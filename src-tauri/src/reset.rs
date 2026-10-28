//! The factory-reset engine.
//!
//! Factory reset removes every piece of PurpleMemo-owned local state under the
//! app-data dir — and nothing else — and reports a per-component outcome for
//! each one. `complete` is `true` only when every component was removed or was
//! already absent; any failure blocks the overall flag, and the caller must
//! not restart into first run on a blocked reset.
//!
//! The surface:
//!
//! * `share_stop` — the in-memory LAN server and its consent token,
//! * `database` — the WAL checkpoint, the managed connection, then
//!   `purple-memo.db` and its `-wal`/`-shm` siblings,
//! * `photos` — the whole `photos/` tree (originals and `.thumb.jpg`
//!   derivatives),
//! * `backups` — the whole `backups/` safety-copy tree,
//! * `logs` — `key-export.log`, `share.log`, `boot-error.log`,
//! * `keyring_key` — the OS credential-store key, deleted **last**.
//!
//! A durable marker file (E3) brackets the whole run: `mark_reset_started`
//! must succeed **before** the first component deletes anything, and the
//! marker is cleared only once the outcome reports `complete`. A session that
//! dies mid-run therefore leaves proof on disk, and the next boot's
//! [`finish_interrupted_reset`] finishes the job before ordinary first-run
//! initialization can mistake the leftovers for a fresh start.
//!
//! Two ordering invariants, both owner decisions:
//!
//! 1. **Key last.** The credential-store key is deleted only after the
//!    database files are confirmed gone — never orphan a live database from
//!    its key. A `share_stop` or `database` failure therefore aborts the
//!    whole run: the remaining components are reported as `not_attempted`
//!    and nothing after the failure is touched. A photos/backups/logs failure
//!    does *not* abort: the database is already gone at that point, and
//!    reporting every remaining component is more useful than stopping.
//! 2. **Nothing is ever created.** No new database, no new key, no seed rows.
//!    The restart's first-run boot owns all of that, and a reset that created
//!    anything could pair a new key with an old database.
//!
//! Everything fallible arrives as a seam — the filesystem root, the share
//! stop, the connection close, the keyring delete — so the tests inject
//! failures directly without touching a real keyring, a real
//! listener, or the environment. Debug builds can additionally force
//! per-component failures with `PURPLE_MEMO_RESET_FAIL=database,photos` for
//! manual recovery testing; release builds read no such variable, so a
//! shipped app can never be sabotaged by an environment it inherited.

use std::io::{ErrorKind, Write};
use std::path::Path;

use serde::Serialize;

use crate::db::db_file_paths;
use crate::safety_copy::{PHOTOS_DIR, SAFETY_DIR};

/// One component of PurpleMemo-owned state, in the order the reset removes
/// them. Serialized snake_case — `share_stop`, `database`, … — which is the
/// IPC contract `src/data/driver.ts` mirrors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetComponent {
    ShareStop,
    Database,
    Photos,
    Backups,
    Logs,
    KeyringKey,
}

/// Every component, in removal order. The key is last on purpose (invariant
/// 1 above); share stop is first because nothing may be deleted while a
/// server could still be serving it.
pub const RESET_COMPONENTS: [ResetComponent; 6] = [
    ResetComponent::ShareStop,
    ResetComponent::Database,
    ResetComponent::Photos,
    ResetComponent::Backups,
    ResetComponent::Logs,
    ResetComponent::KeyringKey,
];

impl ResetComponent {
    /// The wire name, also used in human-readable details.
    fn as_str(self) -> &'static str {
        match self {
            Self::ShareStop => "share_stop",
            Self::Database => "database",
            Self::Photos => "photos",
            Self::Backups => "backups",
            Self::Logs => "logs",
            Self::KeyringKey => "keyring_key",
        }
    }

    /// Parse a wire name — the inverse of [`Self::as_str`], used by the
    /// debug-only fault-injection spec.
    fn parse(name: &str) -> Option<Self> {
        RESET_COMPONENTS
            .iter()
            .copied()
            .find(|component| component.as_str() == name.trim())
    }

    /// Whether this component's failure stops everything after it. Only the
    /// two components guarding invariant 1 abort: a share that will not stop
    /// must not be deleted behind, and a database that will not go must never
    /// be separated from its key.
    fn aborts_on_failure(self) -> bool {
        matches!(self, Self::ShareStop | Self::Database)
    }
}

impl std::fmt::Display for ResetComponent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The outcome of one component. Serialized snake_case — `removed`,
/// `already_absent`, `failed`, `not_attempted` — the IPC contract.
///
/// `already_absent` counts as success for `complete`: a reset that finds
/// nothing left has still achieved its goal. `not_attempted` only ever
/// appears after an aborting failure, and blocks `complete` like `failed`
/// does — it says "we never got there", which must never read as success.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetStatus {
    Removed,
    AlreadyAbsent,
    Failed,
    NotAttempted,
}

/// One row of the reset report. Wave 2's Settings UI renders this verbatim.
#[derive(Debug, Clone, Serialize)]
pub struct ComponentOutcome {
    pub name: ResetComponent,
    pub status: ResetStatus,
    /// Why it failed, or why it was skipped; `None` for removed/absent.
    pub detail: Option<String>,
}

/// The full factory-reset outcome.
#[derive(Debug, Clone, Serialize)]
pub struct ResetOutcome {
    /// True only when every component was removed or already absent.
    pub complete: bool,
    pub components: Vec<ComponentOutcome>,
}

fn outcome(name: ResetComponent, status: ResetStatus, detail: Option<String>) -> ComponentOutcome {
    ComponentOutcome {
        name,
        status,
        detail,
    }
}

/// The debug-only fault-injection switch:
/// `PURPLE_MEMO_RESET_FAIL=database,photos` makes those components fail, so
/// the recovery paths can be exercised by hand in `tauri dev`.
#[cfg(debug_assertions)]
pub fn fault_injection() -> impl FnMut(ResetComponent) -> bool {
    let forced = std::env::var("PURPLE_MEMO_RESET_FAIL")
        .ok()
        .map(|spec| parse_reset_fail_spec(&spec))
        .unwrap_or_default();
    move |component| forced.contains(&component)
}

/// The release counterpart reads no environment variable at all: a shipped
/// app must never be un-completable because of an environment it inherited.
/// This body is what release builds contain, so no injection path exists
/// outside `#[cfg(debug_assertions)]`.
#[cfg(not(debug_assertions))]
pub fn fault_injection() -> impl FnMut(ResetComponent) -> bool {
    |_: ResetComponent| false
}

/// `"database,photos"` → those two components; whitespace tolerated, unknown
/// names ignored (an empty spec means "fail nothing"). Pure, so the syntax
/// the verification run depends on is pinned by a test without touching the
/// environment.
pub fn parse_reset_fail_spec(spec: &str) -> Vec<ResetComponent> {
    spec.split(',').filter_map(ResetComponent::parse).collect()
}

// ---------------------------------------------------------------------------
// The durable reset marker (E3).
//
// The reset engine reports its outcome only in memory, and the database is
// removed before the photos, the backups, the logs and the key. A crash
// between those steps used to leave the app-data dir indistinguishable from
// first run on the next start: with the old key still in the credential
// store the boot would happily create a fresh database under it while the old
// photos and safety copies survived — exactly the residual state E3 describes.
//
// The marker closes that hole with one file: written (and synced) before the
// first deletion, cleared only on `complete`. The next boot sees it before it
// touches any key and finishes the job.
// ---------------------------------------------------------------------------

/// The marker file in the app-data dir. Deliberately NOT one of the reset
/// components' own targets — it must outlive every partial run so the next
/// session can see it, and only [`clear_reset_marker`] on a `complete` outcome
/// removes it.
pub const RESET_MARKER_FILE: &str = "reset-in-progress";

/// The marker's entire content: one fixed sentinel line. The fixed content
/// is what lets [`reset_in_progress`] reject an unrelated file that happens
/// to carry the name, instead of "recovering" a reset nobody started.
const RESET_MARKER_CONTENT: &[u8] = b"purple-memo factory reset started\n";

/// Record that a factory reset is starting — the precondition for the first
/// deletion. Fails loudly when the marker cannot be made durable: a reset
/// that cannot be recorded cannot be recovered, so the caller must cancel
/// before deleting anything rather than start an unrecordable run.
pub fn mark_reset_started(data_dir: &Path) -> Result<(), String> {
    let marker = data_dir.join(RESET_MARKER_FILE);
    write_durable(&marker, RESET_MARKER_CONTENT).map_err(|e| {
        format!(
            "could not record the reset in {}: {e} — nothing was deleted; \
             a reset only starts once it can be recovered",
            marker.display()
        )
    })
}

/// Whether an earlier session started a reset that never reported `complete`.
///
/// A missing, unreadable, or foreign-content file all answer `false`: the
/// check must never refuse ordinary first-run boot on a hunch.
pub fn reset_in_progress(data_dir: &Path) -> bool {
    std::fs::read(data_dir.join(RESET_MARKER_FILE))
        .map(|bytes| bytes == RESET_MARKER_CONTENT)
        .unwrap_or(false)
}

/// Remove the marker after a `complete` outcome. Absent is success (the same
/// rule as every component), so this is idempotent.
pub fn clear_reset_marker(data_dir: &Path) -> Result<(), String> {
    let marker = data_dir.join(RESET_MARKER_FILE);
    match std::fs::remove_file(&marker) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not remove {}: {e}", marker.display())),
    }
}

/// Write `bytes` to `path` durably: a synced temp sibling, then an atomic
/// rename over the target — the same protocol `file_write` uses for exports.
///
/// The rename is not decoration: the retry path calls this while a valid
/// marker from an earlier attempt may already be on disk, and an in-place
/// truncate-then-write would open a crash window in which the deletions are
/// recorded nowhere. With the rename the marker is always either the old
/// complete sentinel or the new one, never partial or absent.
fn write_durable(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    // Closure, not a block: `?` inside a block would leave this function
    // before the temp could be cleaned up below.
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Finish a factory reset that an earlier session started but did not report
/// `complete` — the E3 recovery, run by `boot` before it loads or mints any
/// key (so a database can never be created under the old key while the old
/// photos still exist).
///
/// The seams are an earlier session's run re-expressed for a process that has
/// not opened anything yet: no LAN server exists this early in boot
/// (`Ok(false)` = already absent), and there is no managed connection to take
/// (`Ok(())` — the files are simply still on disk). `fail` is injected so
/// tests can pin the failure behaviour without the debug env-var switch;
/// `boot` passes [`fault_injection`].
///
/// Clears the marker when the outcome is `complete`. On failure the marker
/// stays — the next start (or the Retry dialog) runs this again, because the
/// deletions are idempotent and the user's confirmed intent still stands.
pub fn finish_interrupted_reset(
    fail: impl FnMut(ResetComponent) -> bool,
    data_dir: &Path,
    delete_key: impl FnMut() -> Result<bool, String>,
) -> ResetOutcome {
    let outcome = run_factory_reset(fail, || Ok(false), || Ok(()), data_dir, delete_key);
    if outcome.complete {
        // Best effort, deliberately: a marker that cannot be removed makes
        // the next start re-run this pass over an already-empty app-data dir,
        // which is harmless and retries the removal — while failing the boot
        // on it would brick the app behind a file it was not allowed to
        // delete. `eprintln` keeps the anomaly visible either way.
        if let Err(e) = clear_reset_marker(data_dir) {
            eprintln!("purple-memo: {e} — the reset was finished; the leftover marker is retried on the next start");
        }
    }
    outcome
}

/// The components that blocked `complete`, as one line for the boot-failure
/// dialog: name and detail for each, so the user is told which file to free
/// or close before pressing Retry.
pub fn blocked_summary(outcome: &ResetOutcome) -> String {
    outcome
        .components
        .iter()
        .filter(|c| matches!(c.status, ResetStatus::Failed | ResetStatus::NotAttempted))
        .map(|c| format!("{}: {}", c.name, c.detail.as_deref().unwrap_or("failed")))
        .collect::<Vec<_>>()
        .join("; ")
}

/// The factory-reset engine: run every component in order
/// and report each one individually.
///
/// Seams, in the order they are consulted:
/// * `fail` — fault injection; a failing component is reported `failed`
///   without its work being done (debug builds wire the env-var switch,
///   tests wire their own);
/// * `stop_share` — stop the LAN server and clear its consent token;
///   `Ok(true)` = something was removed, `Ok(false)` = already absent;
/// * `close_db` — checkpoint the WAL and take the managed connection, so no
///   open handle survives into file deletion (fail-closed afterwards);
/// * `data_dir` — the filesystem root; every path below is derived from it,
///   so tests point it at a temp dir;
/// * `delete_key` — delete the OS credential-store key; same bool contract
///   as `stop_share`, and called **only** after the database files are
///   confirmed gone.
pub fn run_factory_reset(
    mut fail: impl FnMut(ResetComponent) -> bool,
    mut stop_share: impl FnMut() -> Result<bool, String>,
    mut close_db: impl FnMut() -> Result<(), String>,
    data_dir: &Path,
    mut delete_key: impl FnMut() -> Result<bool, String>,
) -> ResetOutcome {
    let mut components: Vec<ComponentOutcome> = Vec::with_capacity(RESET_COMPONENTS.len());
    let mut aborted = false;
    for component in RESET_COMPONENTS {
        if aborted {
            components.push(outcome(
                component,
                ResetStatus::NotAttempted,
                Some("not attempted — an earlier step failed".to_string()),
            ));
            continue;
        }
        if fail(component) {
            components.push(outcome(
                component,
                ResetStatus::Failed,
                Some(format!(
                    "fault injection: {component} was forced to fail (PURPLE_MEMO_RESET_FAIL)"
                )),
            ));
            if component.aborts_on_failure() {
                aborted = true;
            }
            continue;
        }
        let component_outcome = match component {
            ResetComponent::ShareStop => match stop_share() {
                Ok(true) => outcome(component, ResetStatus::Removed, None),
                Ok(false) => outcome(component, ResetStatus::AlreadyAbsent, None),
                Err(e) => {
                    aborted = true;
                    outcome(component, ResetStatus::Failed, Some(e))
                }
            },
            ResetComponent::Database => match close_db() {
                Err(e) => {
                    aborted = true;
                    outcome(component, ResetStatus::Failed, Some(e))
                }
                Ok(()) => match remove_db_files(data_dir) {
                    Ok(true) => outcome(component, ResetStatus::Removed, None),
                    Ok(false) => outcome(component, ResetStatus::AlreadyAbsent, None),
                    Err(e) => {
                        aborted = true;
                        outcome(component, ResetStatus::Failed, Some(e))
                    }
                },
            },
            ResetComponent::Photos => remove_tree_outcome(component, &data_dir.join(PHOTOS_DIR)),
            ResetComponent::Backups => remove_tree_outcome(component, &data_dir.join(SAFETY_DIR)),
            ResetComponent::Logs => logs_outcome(data_dir),
            // Last, and only ever reached with the database files confirmed
            // gone (invariant 1). A failure here blocks `complete` but has
            // nothing left to protect: the data files are already deleted and
            // the outcome record is the user's evidence.
            ResetComponent::KeyringKey => match delete_key() {
                Ok(true) => outcome(component, ResetStatus::Removed, None),
                Ok(false) => outcome(component, ResetStatus::AlreadyAbsent, None),
                Err(e) => outcome(component, ResetStatus::Failed, Some(e)),
            },
        };
        components.push(component_outcome);
    }
    let complete = components
        .iter()
        .all(|c| !matches!(c.status, ResetStatus::Failed | ResetStatus::NotAttempted));
    ResetOutcome {
        complete,
        components,
    }
}

/// Delete the database and its WAL/SHM siblings. `Ok(true)` means at least
/// one of the three existed and every existing one went; `Ok(false)` means
/// none of them existed (already absent). Stops at the first failure: the
/// siblings belong with the file that could not go, and a re-run retries
/// them — the WAL was truncated before the connection closed, so no
/// committed data lives in a sidecar at this point.
fn remove_db_files(data_dir: &Path) -> Result<bool, String> {
    let mut existed = false;
    for path in db_file_paths(data_dir) {
        match std::fs::remove_file(&path) {
            Ok(()) => existed = true,
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Err(format!("could not remove {}: {e}", path.display())),
        }
    }
    Ok(existed)
}

/// One tree component (`photos/`, `backups/`): removed, already absent, or
/// failed with the path that could not go.
fn remove_tree_outcome(name: ResetComponent, path: &Path) -> ComponentOutcome {
    match std::fs::remove_dir_all(path) {
        Ok(()) => outcome(name, ResetStatus::Removed, None),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            outcome(name, ResetStatus::AlreadyAbsent, None)
        }
        Err(e) => outcome(
            name,
            ResetStatus::Failed,
            Some(format!("could not remove {}: {e}", path.display())),
        ),
    }
}

/// The three log files, removed independently: one undeletable log must not
/// keep the others on disk. `already_absent` only when none of them existed.
fn logs_outcome(data_dir: &Path) -> ComponentOutcome {
    let mut existed = false;
    let mut first_err: Option<String> = None;
    for name in [
        crate::KEY_EXPORT_LOG,
        crate::SHARE_LOG,
        crate::BOOT_ERROR_LOG,
    ] {
        let path = data_dir.join(name);
        match std::fs::remove_file(&path) {
            Ok(()) => existed = true,
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) if first_err.is_none() => {
                first_err = Some(format!("could not remove {}: {e}", path.display()));
            }
            Err(_) => {}
        }
    }
    match first_err {
        Some(e) => outcome(ResetComponent::Logs, ResetStatus::Failed, Some(e)),
        None => outcome(
            ResetComponent::Logs,
            if existed {
                ResetStatus::Removed
            } else {
                ResetStatus::AlreadyAbsent
            },
            None,
        ),
    }
}

// ---------------------------------------------------------------------------
// Tests — run with `cargo test`
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::path::PathBuf;

    /// Self-cleaning temp dir standing in for the app-data dir.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("purple-memo-p9-reset-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Every listed piece of state, planted so a reset has real work to do —
    /// plus one unrelated file, which must survive: the reset removes the
    /// listed surface, not the app-data dir wholesale.
    fn seed(root: &Path) {
        for path in db_file_paths(root) {
            std::fs::write(&path, b"db-bytes").expect("plant a db file");
        }
        seed_photos_and_logs(root);
        std::fs::create_dir_all(root.join("backups/pre-import-2026")).expect("backups tree");
        std::fs::write(root.join("backups/pre-import-2026/purple-memo.db"), b"copy")
            .expect("backup db");
        std::fs::write(root.join("unrelated.txt"), b"not ours").expect("unrelated file");
    }

    /// The photos tree and the three logs (also used by the undeletable-DB
    /// test, where the database files are planted differently).
    fn seed_photos_and_logs(root: &Path) {
        std::fs::create_dir_all(root.join("photos/2026/10")).expect("photos tree");
        std::fs::write(root.join("photos/2026/10/abc.jpg"), b"photo").expect("photo");
        std::fs::write(root.join("photos/2026/10/abc.thumb.jpg"), b"thumb").expect("thumb");
        for name in [
            crate::KEY_EXPORT_LOG,
            crate::SHARE_LOG,
            crate::BOOT_ERROR_LOG,
        ] {
            std::fs::write(root.join(name), b"log line\n").expect("log");
        }
    }

    fn status_of(outcome: &ResetOutcome, component: ResetComponent) -> ResetStatus {
        outcome
            .components
            .iter()
            .find(|c| c.name == component)
            .unwrap_or_else(|| panic!("missing component {component}"))
            .status
    }

    fn detail_of(outcome: &ResetOutcome, component: ResetComponent) -> String {
        outcome
            .components
            .iter()
            .find(|c| c.name == component)
            .and_then(|c| c.detail.clone())
            .unwrap_or_else(|| panic!("no detail for {component}"))
    }

    fn assert_listed_state_is_gone(root: &Path) {
        for path in db_file_paths(root) {
            assert!(!path.exists(), "{} must be gone", path.display());
        }
        for name in [
            "photos",
            "backups",
            crate::KEY_EXPORT_LOG,
            crate::SHARE_LOG,
            crate::BOOT_ERROR_LOG,
        ] {
            assert!(
                !root.join(name).exists(),
                "{} must be gone",
                root.join(name).display()
            );
        }
    }

    #[test]
    fn a_complete_reset_removes_every_listed_component() {
        let dir = TempDir::new("happy");
        seed(&dir.0);
        let keyring_called = Cell::new(false);

        let outcome = run_factory_reset(
            |_| false,
            || Ok(true),
            || Ok(()),
            &dir.0,
            || {
                keyring_called.set(true);
                Ok(true)
            },
        );

        assert!(outcome.complete, "everything was removable: {outcome:?}");
        for component in outcome.components.iter().map(|c| (c.name, c.status)) {
            assert_eq!(component.1, ResetStatus::Removed, "{:?}", component.0);
        }
        assert_listed_state_is_gone(&dir.0);
        assert!(keyring_called.get(), "the key is deleted last, but deleted");
        assert!(
            dir.0.join("unrelated.txt").exists(),
            "the reset removes the listed surface, not the whole directory"
        );
    }

    #[test]
    fn every_component_already_absent_still_reports_complete() {
        let dir = TempDir::new("absent");
        // Nothing planted; the share was never started; the key is gone.
        let outcome = run_factory_reset(|_| false, || Ok(false), || Ok(()), &dir.0, || Ok(false));

        assert!(outcome.complete, "already absent is success: {outcome:?}");
        for component in outcome.components.iter().map(|c| (c.name, c.status)) {
            assert_eq!(component.1, ResetStatus::AlreadyAbsent, "{:?}", component.0);
        }
    }

    // -- The durable marker (E3) -------------------------------------------

    #[test]
    fn the_reset_marker_round_trips_and_rejects_foreign_content() {
        let dir = TempDir::new("marker");
        assert!(!reset_in_progress(&dir.0), "no marker at first");

        mark_reset_started(&dir.0).expect("write");
        assert!(reset_in_progress(&dir.0), "recorded");
        // A retry re-records over an existing marker — and must not be able
        // to leave a half-written one behind, which is why the write is
        // temp-plus-rename (pinned indirectly: rewrite works, content valid).
        mark_reset_started(&dir.0).expect("rewrite");
        assert!(reset_in_progress(&dir.0), "still recorded after a retry");
        // The temp sibling must not linger next to the marker.
        assert!(
            !dir.0.join(RESET_MARKER_FILE).with_extension("tmp").exists(),
            "the synced temp is renamed away, not left behind"
        );

        // A file that merely carries the name is not a marker: an unrelated
        // `reset-in-progress` must not trigger a recovery pass (E3).
        std::fs::write(dir.0.join(RESET_MARKER_FILE), b"something else\n")
            .expect("plant foreign content");
        assert!(
            !reset_in_progress(&dir.0),
            "the content guard keeps junk from reading as a reset"
        );

        clear_reset_marker(&dir.0).expect("clear");
        assert!(!reset_in_progress(&dir.0));
        clear_reset_marker(&dir.0)
            .expect("clearing an already-absent marker is success, like every component");
    }

    #[test]
    fn an_unrecordable_reset_never_reports_success() {
        // `mark_reset_started` is the command's precondition: if the marker
        // cannot be written the reset must not start. A missing data dir is
        // the portable way to make the write fail.
        let dir = TempDir::new("marker-fail");
        let missing = dir.0.join("does-not-exist");
        let error = mark_reset_started(&missing).expect_err("must refuse");
        assert!(
            error.contains(RESET_MARKER_FILE),
            "names the marker: {error}"
        );
        assert!(
            error.contains("nothing was deleted"),
            "must say the reset never started: {error}"
        );
        assert!(!reset_in_progress(&missing));
    }

    #[test]
    fn finish_interrupted_reset_completes_what_an_earlier_session_started() {
        let dir = TempDir::new("finish");
        seed(&dir.0);
        mark_reset_started(&dir.0).expect("plant marker");
        let key_deleted = Cell::new(false);

        let outcome = finish_interrupted_reset(
            |_| false,
            &dir.0,
            || {
                key_deleted.set(true);
                Ok(true)
            },
        );

        assert!(
            outcome.complete,
            "the leftovers are all removable: {outcome:?}"
        );
        assert_listed_state_is_gone(&dir.0);
        assert!(key_deleted.get(), "the key goes last, but goes");
        assert!(
            !reset_in_progress(&dir.0),
            "and the marker goes with the completed outcome"
        );
        assert!(
            dir.0.join("unrelated.txt").exists(),
            "recovery removes the listed surface, not the whole directory"
        );
    }

    #[test]
    fn finish_interrupted_reset_keeps_the_marker_while_a_component_blocks() {
        let dir = TempDir::new("finish-fail");
        seed(&dir.0);
        mark_reset_started(&dir.0).expect("plant marker");

        let outcome =
            finish_interrupted_reset(|c| c == ResetComponent::Photos, &dir.0, || Ok(true));

        assert!(!outcome.complete, "a failed photos tree blocks completion");
        assert_eq!(
            status_of(&outcome, ResetComponent::Photos),
            ResetStatus::Failed
        );
        assert!(
            reset_in_progress(&dir.0),
            "the next start must be able to finish this (E3)"
        );
        let summary = blocked_summary(&outcome);
        assert!(summary.contains("photos"), "the dialog names it: {summary}");
    }

    #[test]
    fn an_injected_share_stop_failure_touches_nothing_and_skips_every_later_component() {
        let dir = TempDir::new("share-fail");
        seed(&dir.0);
        let keyring_called = Cell::new(false);
        let close_called = Cell::new(false);

        let outcome = run_factory_reset(
            |c| c == ResetComponent::ShareStop,
            || Ok(true),
            || {
                close_called.set(true);
                Ok(())
            },
            &dir.0,
            || {
                keyring_called.set(true);
                Ok(true)
            },
        );

        assert!(!outcome.complete);
        assert_eq!(
            status_of(&outcome, ResetComponent::ShareStop),
            ResetStatus::Failed
        );
        assert!(
            detail_of(&outcome, ResetComponent::ShareStop).contains("fault injection"),
            "the detail must say why it failed"
        );
        for skipped in RESET_COMPONENTS.iter().skip(1) {
            assert_eq!(
                status_of(&outcome, *skipped),
                ResetStatus::NotAttempted,
                "{skipped} must not run after a share-stop failure"
            );
        }
        assert!(!close_called.get(), "the connection must not be touched");
        assert!(!keyring_called.get(), "the key must not be touched");
        assert!(dir.0.join("photos/2026/10/abc.jpg").exists());
        assert!(db_file_paths(&dir.0)[0].exists());
        assert!(dir.0.join(crate::SHARE_LOG).exists());
    }

    #[test]
    fn a_real_share_stop_error_aborts_exactly_like_an_injected_one() {
        let dir = TempDir::new("share-err");
        seed(&dir.0);
        let outcome = run_factory_reset(
            |_| false,
            || Err("share thread refused to stop".to_string()),
            || Ok(()),
            &dir.0,
            || Ok(true),
        );

        assert!(!outcome.complete);
        assert_eq!(
            detail_of(&outcome, ResetComponent::ShareStop),
            "share thread refused to stop"
        );
        for skipped in RESET_COMPONENTS.iter().skip(1) {
            assert_eq!(
                status_of(&outcome, *skipped),
                ResetStatus::NotAttempted,
                "a real error aborts the same way an injected one does"
            );
        }
        assert!(
            dir.0.join("photos/2026/10/abc.jpg").exists(),
            "nothing was deleted"
        );
        assert!(db_file_paths(&dir.0).iter().all(|p| p.exists()));
        assert!(dir.0.join(crate::BOOT_ERROR_LOG).exists());
    }

    #[test]
    fn an_injected_database_failure_aborts_before_the_files_the_trees_and_the_key() {
        let dir = TempDir::new("db-fail");
        seed(&dir.0);
        let keyring_called = Cell::new(false);

        let outcome = run_factory_reset(
            |c| c == ResetComponent::Database,
            || Ok(true),
            || Ok(()),
            &dir.0,
            || {
                keyring_called.set(true);
                Ok(true)
            },
        );

        assert!(!outcome.complete);
        assert_eq!(
            status_of(&outcome, ResetComponent::Database),
            ResetStatus::Failed
        );
        for skipped in [
            ResetComponent::Photos,
            ResetComponent::Backups,
            ResetComponent::Logs,
            ResetComponent::KeyringKey,
        ] {
            assert_eq!(
                status_of(&outcome, skipped),
                ResetStatus::NotAttempted,
                "{skipped} must not run after a database failure"
            );
        }
        assert!(
            !keyring_called.get(),
            "never orphan a live database from its key"
        );
        // Everything after the share stop is still on disk.
        assert!(db_file_paths(&dir.0).iter().all(|p| p.exists()));
        assert!(dir.0.join("photos/2026/10/abc.jpg").exists());
        assert!(dir
            .0
            .join("backups/pre-import-2026/purple-memo.db")
            .exists());
        assert!(dir.0.join(crate::KEY_EXPORT_LOG).exists());
    }

    #[test]
    fn a_database_file_that_cannot_be_removed_blocks_the_reset_before_the_key() {
        // A real (not injected) filesystem failure: a directory squatting on
        // the database path cannot be removed with `remove_file`.
        let dir = TempDir::new("db-undeletable");
        std::fs::create_dir(dir.0.join(crate::db::DB_FILE_NAME)).expect("db as a dir");
        std::fs::write(
            dir.0.join(format!("{}-wal", crate::db::DB_FILE_NAME)),
            b"wal",
        )
        .expect("wal");
        seed_photos_and_logs(&dir.0);
        let keyring_called = Cell::new(false);

        let outcome = run_factory_reset(
            |_| false,
            || Ok(true),
            || Ok(()),
            &dir.0,
            || {
                keyring_called.set(true);
                Ok(true)
            },
        );

        assert!(!outcome.complete);
        assert_eq!(
            status_of(&outcome, ResetComponent::Database),
            ResetStatus::Failed
        );
        assert!(
            detail_of(&outcome, ResetComponent::Database).contains("could not remove"),
            "a real deletion failure must name the operation"
        );
        assert!(
            dir.0
                .join(format!("{}-wal", crate::db::DB_FILE_NAME))
                .exists(),
            "stops at the first failed file: the siblings belong with it"
        );
        assert!(dir.0.join("photos/2026/10/abc.jpg").exists());
        assert!(
            !keyring_called.get(),
            "the key must survive a surviving database"
        );
        assert_eq!(
            status_of(&outcome, ResetComponent::KeyringKey),
            ResetStatus::NotAttempted
        );
    }

    #[test]
    fn an_injected_failure_of_any_component_after_the_database_blocks_complete_but_reports_the_rest(
    ) {
        // Only the database guards the key; a failure after it keeps going, so
        // the user sees every remaining component's true state at once.
        for target in [
            ResetComponent::Photos,
            ResetComponent::Backups,
            ResetComponent::Logs,
            ResetComponent::KeyringKey,
        ] {
            let dir = TempDir::new(&format!("injected-{target}"));
            seed(&dir.0);
            let outcome =
                run_factory_reset(|c| c == target, || Ok(true), || Ok(()), &dir.0, || Ok(true));

            assert!(!outcome.complete, "{target} failed: {outcome:?}");
            assert_eq!(status_of(&outcome, target), ResetStatus::Failed);
            for other in RESET_COMPONENTS.iter().copied() {
                if other == target {
                    continue;
                }
                assert_ne!(
                    status_of(&outcome, other),
                    ResetStatus::NotAttempted,
                    "{other} must still be attempted when {target} fails"
                );
            }
        }
    }

    #[test]
    fn a_photos_entry_that_cannot_be_removed_blocks_complete_only() {
        // A real filesystem failure for a tree component: a regular file where
        // the photos TREE should be cannot be removed with `remove_dir_all`,
        // and — unlike the database — it must not abort the remaining
        // components, because the database is already gone.
        let dir = TempDir::new("photos-file");
        seed(&dir.0);
        std::fs::remove_dir_all(dir.0.join("photos")).expect("drop the tree");
        std::fs::write(dir.0.join("photos"), b"not a tree").expect("file in its place");

        let outcome = run_factory_reset(|_| false, || Ok(true), || Ok(()), &dir.0, || Ok(true));

        assert!(!outcome.complete, "a failed component blocks complete");
        assert_eq!(
            status_of(&outcome, ResetComponent::Photos),
            ResetStatus::Failed
        );
        assert!(
            dir.0.join("photos").exists(),
            "the undeletable entry stays where it is"
        );
        // The database and everything else was removed and reported.
        assert_eq!(
            status_of(&outcome, ResetComponent::Database),
            ResetStatus::Removed
        );
        assert_eq!(
            status_of(&outcome, ResetComponent::Backups),
            ResetStatus::Removed
        );
        assert_eq!(
            status_of(&outcome, ResetComponent::Logs),
            ResetStatus::Removed
        );
        assert_eq!(
            status_of(&outcome, ResetComponent::KeyringKey),
            ResetStatus::Removed
        );
        assert!(!db_file_paths(&dir.0).iter().any(|p| p.exists()));
        assert!(!dir.0.join("backups").exists());
    }

    #[test]
    fn an_interrupted_reset_can_be_re_run_to_completion() {
        // Plan task 7: recovery is a re-run. The first run dies at photos;
        // the second finds the database already gone and finishes the rest.
        let dir = TempDir::new("rerun");
        seed(&dir.0);

        let first = run_factory_reset(
            |c| c == ResetComponent::Photos,
            || Ok(true),
            || Ok(()),
            &dir.0,
            || Ok(true),
        );
        assert!(!first.complete);
        assert_eq!(
            status_of(&first, ResetComponent::Database),
            ResetStatus::Removed
        );

        let second = run_factory_reset(|_| false, || Ok(true), || Ok(()), &dir.0, || Ok(false));
        assert!(second.complete, "the re-run finishes the job: {second:?}");
        assert_eq!(
            status_of(&second, ResetComponent::Photos),
            ResetStatus::Removed
        );
        assert_eq!(
            status_of(&second, ResetComponent::Database),
            ResetStatus::AlreadyAbsent,
            "a re-run must not error on what the first run already deleted"
        );
        assert_listed_state_is_gone(&dir.0);
    }

    #[test]
    fn the_outcome_serializes_to_the_contract_the_settings_ui_renders() {
        // Wave 2 renders this verbatim, so the wire shape is pinned: field
        // names, the snake_case component names and statuses, and `detail`
        // as a string or null.
        let outcome = run_factory_reset(
            |_| false,
            || Ok(false),
            || Ok(()),
            Path::new("/nonexistent"),
            || Ok(false),
        );
        let json = serde_json::to_value(&outcome).expect("serialize");
        assert_eq!(json["complete"], serde_json::json!(true));
        let rows = json["components"].as_array().expect("components array");
        let names: Vec<&str> = rows
            .iter()
            .map(|r| r["name"].as_str().expect("name"))
            .collect();
        assert_eq!(
            names,
            vec![
                "share_stop",
                "database",
                "photos",
                "backups",
                "logs",
                "keyring_key"
            ]
        );
        for row in rows {
            assert_eq!(row["status"], serde_json::json!("already_absent"));
            assert!(row["detail"].is_null(), "no detail on a clean component");
        }

        let failed = run_factory_reset(
            |c| c == ResetComponent::KeyringKey,
            || Ok(true),
            || Ok(()),
            Path::new("/nonexistent"),
            || Ok(true),
        );
        let json = serde_json::to_value(&failed).expect("serialize");
        assert_eq!(json["complete"], serde_json::json!(false));
        assert_eq!(json["components"][5]["status"], serde_json::json!("failed"));
        assert!(json["components"][5]["detail"].is_string());

        let aborted = run_factory_reset(
            |c| c == ResetComponent::ShareStop,
            || Ok(true),
            || Ok(()),
            Path::new("/nonexistent"),
            || Ok(true),
        );
        let json = serde_json::to_value(&aborted).expect("serialize");
        assert_eq!(
            json["components"][1]["status"],
            serde_json::json!("not_attempted")
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn the_debug_fault_injection_spec_names_components() {
        assert_eq!(
            parse_reset_fail_spec("database,photos"),
            vec![ResetComponent::Database, ResetComponent::Photos]
        );
        assert_eq!(
            parse_reset_fail_spec(" share_stop "),
            vec![ResetComponent::ShareStop]
        );
        assert_eq!(
            parse_reset_fail_spec("nope,logs"),
            vec![ResetComponent::Logs]
        );
        assert!(parse_reset_fail_spec("").is_empty());
        assert!(parse_reset_fail_spec("  ,  ").is_empty());
    }

    #[test]
    fn factory_reset_and_app_restart_are_in_the_registered_command_set() {
        // The IPC contract test in `src/data/ipc.test.ts` pins the same list
        // from the driver side; this keeps the Rust suite self-contained.
        let lib = include_str!("lib.rs");
        assert!(
            lib.contains("commands::factory_reset,"),
            "factory_reset registered"
        );
        assert!(
            lib.contains("commands::app_restart,"),
            "app_restart registered"
        );
    }
}
