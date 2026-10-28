//! The app lifecycle barrier (E1/E2/E5): one shared state machine that makes
//! a factory reset, an import window and ordinary app work mutually exclusive.
//!
//! Three phases:
//!
//! * **Normal** — every writer the app has is admitted.
//! * **Importing** — the pre-import safety copy has been taken and the import
//!   owns the data until it restores `foreign_keys = ON`. Only writes carrying
//!   the window's lease are admitted; quick capture and gallery writes are
//!   refused with [`IMPORT_BLOCKED`]. This is E5: the snapshot boundary and
//!   the destructive replacement are one exclusion window, not two awaits in
//!   the frontend.
//! * **Resetting** — a factory reset owns the data. Every writer is refused
//!   with [`RESET_BLOCKED`], already-admitted workers are drained before the
//!   reset deletes anything, and the phase never goes back for the life of the
//!   process. This is E1: a photo save that was already in flight when the
//!   reset started is waited out, and a photo command that arrives after the
//!   reset resolved fails closed instead of recreating `photos/`.
//!
//! Admission hands out a [`WriterTicket`]; while one is alive the operation is
//! counted, and `begin_import` / `raise_reset` block in `Condvar::wait` until
//! the count reaches zero — the drain. The connection mutex already serializes
//! DB work against `close_connection_for_reset`, so the ticket exists for the
//! *phase* check and for the fs/photo workers that the connection lock never
//! covered.
//!
//! The share server consults the same state through
//! [`Lifecycle::ensure_share_allowed`] (E2): `start` fails fast before
//! spending its consent token, `start_on` re-checks under the server lock —
//! the one place a reset's `stop_for_reset` also serializes — so no start can
//! bind after the stop barrier, and `arm`/`publish` refuse during a reset or
//! import instead of arming a token or a snapshot nobody may serve.

use std::sync::{Condvar, Mutex, MutexGuard};

/// The app's data lifecycle phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Ordinary operation: every writer is admitted.
    Normal,
    /// The import exclusion window is open: only the lease-holder writes.
    Importing,
    /// A factory reset owns the data, for the rest of this process.
    Resetting,
}

/// Refused while a factory reset owns the data (E1). Says what to do — the
/// same rule as `db::DB_CLOSED_MESSAGE`: a dead end with no next step is a
/// bug report waiting to happen.
pub const RESET_BLOCKED: &str =
    "a factory reset owns this app's data now — restart the app before writing again";

/// Refused for anyone who is not the import's lease-holder while the window
/// is open (E5). The caller's write did not happen; the import finishes in
/// seconds and the next attempt succeeds.
pub const IMPORT_BLOCKED: &str =
    "an import is replacing this app's data — this write was refused; try again when it finishes";

/// Shared state: the phase, the current import lease (0 = none), and how many
/// admitted writers are still in flight. The condvar's waiters are the
/// barriers — import open and reset — waiting for the count to drain.
#[derive(Debug)]
struct Inner {
    phase: Phase,
    lease: u64,
    in_flight: u32,
}

/// The lifecycle barrier, managed as `Arc<Lifecycle>` (see `lib::boot`).
///
/// `Mutex` + `Condvar`, and every lock call recovers from poisoning with
/// `into_inner` — the same rule as the connection and photo mutexes: a panic
/// must not wedge the barrier for the rest of the session, and a
/// `WriterTicket`'s `Drop` runs during unwind.
#[derive(Debug)]
pub struct Lifecycle {
    inner: Mutex<Inner>,
    idle: Condvar,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self::new()
    }
}

/// Proof that one writer is admitted. Held for the duration of the command —
/// declared before the connection guard so it drops *after* it: when the
/// count reaches zero, no admitted DB writer is still holding the connection,
/// which is what lets `begin_import` copy the database file with no writer
/// able to land behind it.
///
/// `Drop` decrements and wakes the barriers. It is `Send` because
/// `Lifecycle` is `Sync`, so a ticket can be held across the
/// `spawn_blocking` awaits in `photo_save` / `db_batch`.
#[derive(Debug)]
pub struct WriterTicket<'a> {
    lifecycle: &'a Lifecycle,
}

impl Drop for WriterTicket<'_> {
    fn drop(&mut self) {
        let mut inner = self.lifecycle.lock();
        inner.in_flight = inner.in_flight.saturating_sub(1);
        drop(inner);
        self.lifecycle.idle.notify_all();
    }
}

impl Lifecycle {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                phase: Phase::Normal,
                lease: 0,
                in_flight: 0,
            }),
            idle: Condvar::new(),
        }
    }

    /// Recover-from-poison lock, per the module rule above.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Current phase — asserted by this module's tests (the barrier's
    /// behaviour is observed through `admit`/`begin_import` everywhere else,
    /// so a non-test build has no reader for it).
    #[cfg(test)]
    pub fn phase(&self) -> Phase {
        self.lock().phase
    }

    /// Admit one app-data writer for the duration of its command.
    ///
    /// * `Phase::Normal` — admitted. A stale `lease` from a window that has
    ///   already closed is harmless and admitted too: the write would be
    ///   admissible as an ordinary write anyway.
    /// * `Phase::Importing` — admitted only with the window's exact lease;
    ///   everyone else gets [`IMPORT_BLOCKED`]. This is what keeps quick
    ///   capture (E5) out of the gap between the safety copy and the
    ///   replacement.
    /// * `Phase::Resetting` — refused regardless of lease: a lease minted
    ///   before the reset cannot write into an erased app (E1).
    pub fn admit(&self, lease: Option<u64>) -> Result<WriterTicket<'_>, String> {
        let mut inner = self.lock();
        match inner.phase {
            Phase::Resetting => Err(RESET_BLOCKED.to_string()),
            Phase::Importing => match lease {
                Some(l) if l == inner.lease => {
                    inner.in_flight += 1;
                    Ok(WriterTicket { lifecycle: self })
                }
                _ => Err(IMPORT_BLOCKED.to_string()),
            },
            Phase::Normal => {
                inner.in_flight += 1;
                Ok(WriterTicket { lifecycle: self })
            }
        }
    }

    /// Open the import exclusion window — or attach to the one the safety
    /// copy already opened — and return its lease.
    ///
    /// Drains every admitted writer before returning: by the time the caller
    /// starts its snapshot, nothing admitted earlier can still be writing.
    /// `attach` semantics matter because the window opens at the safety copy
    /// (`backup_safety_copy`) while the lease is claimed again inside
    /// `applyBackup` — the two must be the same window, not two.
    ///
    /// Refuses while a reset owns the data: a reset preempts an import, and
    /// an import must never resume on top of it.
    pub fn begin_import(&self) -> Result<u64, String> {
        let mut inner = self.lock();
        match inner.phase {
            Phase::Resetting => return Err(RESET_BLOCKED.to_string()),
            Phase::Normal => {
                // Monotonic and never 0: a stale lease from an earlier window
                // can never match a later one.
                inner.lease = inner.lease.wrapping_add(1).max(1);
                inner.phase = Phase::Importing;
            }
            // Attach to the window the safety copy opened.
            Phase::Importing => {}
        }
        let lease = inner.lease;
        while inner.in_flight > 0 {
            // Wait releases the mutex, so writers finishing now can drop their
            // tickets; each drop notifies.
            inner = self.idle.wait(inner).unwrap_or_else(|e| e.into_inner());
        }
        // A reset raised while we drained preempts the import entirely.
        if inner.phase == Phase::Resetting {
            return Err(RESET_BLOCKED.to_string());
        }
        Ok(lease)
    }

    /// Close the import window. Refuses a lease the window does not have —
    /// a late or foreign release can never open the door for someone else's
    /// write.
    pub fn end_import(&self, lease: u64) -> Result<(), String> {
        let mut inner = self.lock();
        if inner.phase != Phase::Importing || inner.lease != lease {
            return Err("no import window is open for that lease".to_string());
        }
        inner.phase = Phase::Normal;
        inner.lease = 0;
        drop(inner);
        self.idle.notify_all();
        Ok(())
    }

    /// Raise the reset barrier (E1) and drain every admitted writer.
    ///
    /// Called before `run_factory_reset`: the photo/safety-copy workers that
    /// were already in flight are waited out *here*, so the deletion that
    /// follows cannot be written back into afterwards, and every writer that
    /// arrives from now on is refused. DB writers are additionally
    /// serialized by the connection mutex — `close_connection_for_reset`
    /// takes the same lock — so waiting them out cannot deadlock.
    ///
    /// Deliberately returns nothing: the reset engine runs whether or not
    /// anything needed draining, and a writer that never finishes would hang
    /// the barrier by design rather than let the delete race it.
    pub fn raise_reset(&self) {
        let mut inner = self.lock();
        inner.phase = Phase::Resetting;
        inner.lease = 0;
        while inner.in_flight > 0 {
            inner = self.idle.wait(inner).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// The share server may start/arm/publish only in `Phase::Normal` (E2):
    /// during an import the frontend has stopped sharing and must not be
    /// re-opened from underneath it, and during a reset a listener or a
    /// staged snapshot that came alive after `stop_for_reset` would serve an
    /// erased app — and re-create `share.log` after log deletion.
    pub fn ensure_share_allowed(&self) -> Result<(), String> {
        match self.lock().phase {
            Phase::Normal => Ok(()),
            Phase::Importing => Err(IMPORT_BLOCKED.to_string()),
            Phase::Resetting => Err(RESET_BLOCKED.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — run with `cargo test`
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn ordinary_writes_are_admitted_and_counted() {
        let lc = Lifecycle::new();
        assert_eq!(lc.phase(), Phase::Normal);
        {
            let _t = lc.admit(None).expect("Normal admits every writer");
            assert_eq!(lc.phase(), Phase::Normal);
        }
        // The ticket's drop returns the barrier to idle: a later drain must
        // not wait on a writer that already finished.
        let lease = lc.begin_import().expect("drains to zero immediately");
        assert_eq!(lease, 1, "first window is lease 1");
        lc.end_import(lease).expect("close");
        assert_eq!(lc.phase(), Phase::Normal);
    }

    #[test]
    fn the_import_window_admits_only_its_own_lease() {
        let lc = Lifecycle::new();
        let lease = lc.begin_import().expect("open window");

        let refused = lc.admit(None).expect_err("quick capture must be refused");
        assert_eq!(refused, IMPORT_BLOCKED);
        assert!(refused.contains("try again"), "actionable: {refused}");

        let wrong = lc
            .admit(Some(lease.wrapping_add(1)))
            .expect_err("a stale lease must not match");
        assert_eq!(wrong, IMPORT_BLOCKED);

        // A lease-carrying write runs to completion before anything attaches
        // again — no caller ever holds its own ticket across a barrier wait:
        // `begin_import` drains to zero, so a ticket kept alive here would be
        // this thread waiting on itself. The production order is exactly
        // that: attach (`backup_import_begin`) before the writes it opens.
        drop(
            lc.admit(Some(lease))
                .expect("the import writes with its lease"),
        );

        // Attaching returns the SAME window — the safety copy's boundary and
        // the replacement's writes are one exclusion window, not two.
        assert_eq!(lc.begin_import().expect("attach"), lease);

        lc.end_import(lease).expect("close");
        lc.admit(None)
            .expect("ordinary writes resume after the window");
    }

    #[test]
    fn a_foreign_lease_cannot_close_the_window() {
        let lc = Lifecycle::new();
        let lease = lc.begin_import().expect("open");
        lc.end_import(lease + 7)
            .expect_err("only the window's own lease may close it");
        assert_eq!(lc.phase(), Phase::Importing, "still closed to the world");
        lc.end_import(lease).expect("the real lease closes it");
        lc.end_import(lease)
            .expect_err("and a second release of a spent lease is refused");
    }

    #[test]
    fn begin_import_drains_admitted_writers_before_opening() {
        // E5's drain: a writer admitted before the snapshot must finish (or
        // be gone) before `begin_import` hands back the lease.
        let lc = std::sync::Arc::new(Lifecycle::new());
        let ticket = lc.admit(None).expect("admit the straggler");

        let (tx, rx) = mpsc::channel();
        let waiter = {
            let lc = std::sync::Arc::clone(&lc);
            std::thread::spawn(move || {
                let began = lc.begin_import();
                let _ = tx.send(began);
            })
        };
        assert!(
            rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "begin_import must wait while a writer is in flight"
        );
        drop(ticket);
        let began = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the drain must complete")
            .expect("and then open the window");
        assert_eq!(began, 1);
        waiter.join().expect("waiter thread");
        assert_eq!(lc.phase(), Phase::Importing);
    }

    #[test]
    fn raise_reset_drains_writers_and_then_refuses_them_all() {
        // E1: deletion happens only after the in-flight workers are done,
        // and every later writer — with or without an import lease — fails
        // closed with a message that says to restart.
        let lc = std::sync::Arc::new(Lifecycle::new());
        // A previous window's lease: after the reset it must be refused too.
        let stale_lease = lc.begin_import().expect("a window existed first");
        lc.end_import(stale_lease).expect("closed");
        let ticket = lc.admit(None).expect("admit a photo worker");

        let (tx, rx) = mpsc::channel();
        let resetter = {
            let lc = std::sync::Arc::clone(&lc);
            std::thread::spawn(move || {
                lc.raise_reset();
                let _ = tx.send(());
            })
        };
        assert!(
            rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "reset must not proceed past an admitted worker"
        );
        drop(ticket);
        rx.recv_timeout(Duration::from_secs(5))
            .expect("the drain must complete once the worker is gone");
        resetter.join().expect("reset thread");

        assert_eq!(lc.phase(), Phase::Resetting);
        for lease in [None, Some(1), Some(u64::MAX)] {
            let err = lc.admit(lease).expect_err("no lease survives a reset");
            assert_eq!(err, RESET_BLOCKED);
            assert!(err.contains("restart"), "must say what to do: {err}");
        }
        assert!(lc.begin_import().is_err(), "no import on an erased app");
        lc.end_import(1).expect_err("nor a window left to close");
    }

    #[test]
    fn share_is_refused_outside_normal_but_stays_usable_in_normal() {
        let lc = Lifecycle::new();
        lc.ensure_share_allowed().expect("Normal shares");

        let lease = lc.begin_import().expect("open");
        assert_eq!(
            lc.ensure_share_allowed()
                .expect_err("no listener mid-import"),
            IMPORT_BLOCKED
        );
        lc.end_import(lease).expect("close");
        lc.ensure_share_allowed()
            .expect("shares again after the import");

        lc.raise_reset();
        assert_eq!(
            lc.ensure_share_allowed()
                .expect_err("no listener after reset"),
            RESET_BLOCKED
        );
    }

    #[test]
    fn a_reset_raised_while_importing_preempts_the_window() {
        // `factory_reset` raises the barrier BEFORE its engine runs, so an
        // import that is attaching while the reset drains wakes into
        // Resetting and refuses — it never resumes on top of the erased app.
        let lc = std::sync::Arc::new(Lifecycle::new());
        let lease = lc.begin_import().expect("open a window");
        let ticket = lc.admit(Some(lease)).expect("an import write is in flight");

        let (tx, rx) = mpsc::channel();
        let attach = {
            let lc = std::sync::Arc::clone(&lc);
            std::thread::spawn(move || {
                let _ = tx.send(lc.begin_import());
            })
        };
        assert!(
            rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "the attach must be draining the in-flight import write"
        );

        let resetter = {
            let lc = std::sync::Arc::clone(&lc);
            std::thread::spawn(move || lc.raise_reset())
        };
        // `raise_reset` sets the phase the instant it takes the lock and then
        // blocks in the same drain; a moment is enough to let it get there
        // before the ticket below wakes everyone.
        std::thread::sleep(Duration::from_millis(100));
        drop(ticket);

        let attached = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the attach must wake when the writer drains")
            .expect_err("and refuse: a reset preempts the import");
        assert_eq!(attached, RESET_BLOCKED);
        attach.join().expect("attach thread");
        resetter.join().expect("reset thread");
        assert_eq!(lc.phase(), Phase::Resetting);
    }
}
