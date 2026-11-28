//! Device-local envelope-counter floors (§7.2), as `settings` rows under the
//! prefix `pairing_counter.` — the same device-local, backup-excluded
//! mechanism F7's `sync_endpoints` uses (both borders read
//! `isDeviceLocalSetting`, which is why these rows must live under one
//! constant prefix).
//!
//! Why this exists: the §7.2 replay guard compares an envelope against the
//! highest counter this device has *accepted*. A process-local counter resets
//! at every start, so after a restart the desktop used to seed its window
//! from the webview's argument (default 0) and would honour a replayed
//! envelope. A durable, paired-forever phone makes that worse, not better:
//! the whole point is that the phone does not re-scan a code after a
//! restart.
//!
//! Two rows exist:
//!
//! * `pairing_counter.<pairing_id>` — the highest counter this device
//!   accepted from that peer. Read at window open (never trusted from the
//!   webview) and raised before every admitted envelope is acted on;
//! * `pairing_counter.local` — the floor for this device's own minted
//!   outbound stream (the phone's hello/exchange allocator). Without it, a
//!   phone restart would mint counters at 1 again and the desktop's floor
//!   would refuse every one of them — a permanent lockout disguised as
//!   replay protection.
//!
//! Pairing ids are minted as UUIDs by the app. The key check below is wider
//! than a UUID (ASCII alphanumerics and `-`, at most 64 bytes) so test ids
//! like `pair-1` work; anything outside that set (hand-edited IPC input) is
//! refused a key rather than becoming a settings row that code elsewhere
//! cannot tell apart from its neighbours.

use rusqlite::Connection;

/// The one prefix every floor row lives under. Exported for the tests that
/// pin the backup-exclusion contract.
pub(crate) const PREFIX: &str = "pairing_counter.";

/// The outbound stream's own floor.
pub(crate) const LOCAL_KEY: &str = "pairing_counter.local";

/// `pairing_counter.<pairing_id>`, or `None` when the id is not one this app
/// would mint. The HKDF salt (§11.6.1) is the id, so a key that cannot be a
/// salt cannot be a floor either.
pub(crate) fn peer_floor_key(pairing_id: &str) -> Option<String> {
    let plausible = !pairing_id.is_empty()
        && pairing_id.len() <= 64
        && pairing_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    plausible.then(|| format!("{PREFIX}{pairing_id}"))
}

/// What a floor row holds. Absent and unreadable are different answers: an
/// absent row means this pairing has admitted nothing yet, while an
/// unreadable row means the record exists but cannot be trusted — and the
/// caller that seeds a window must refuse rather than treat "I don't know"
/// as zero, which would silently re-open the replay window the row exists
/// to close.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FloorRead {
    Absent,
    Value(u64),
    Unreadable,
}

/// The stored floor. An unreadable row is reported on stderr here (the row
/// key and the parse error) so the refusal the caller raises has a cause on
/// record.
pub(crate) fn read_floor(conn: &Connection, key: &str) -> FloorRead {
    let raw: String =
        match conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get(0)
        }) {
            Ok(raw) => raw,
            Err(rusqlite::Error::QueryReturnedNoRows) => return FloorRead::Absent,
            Err(error) => {
                eprintln!("purple-memo: could not read {key} floor row: {error}");
                return FloorRead::Unreadable;
            }
        };
    match serde_json::from_str::<u64>(&raw) {
        Ok(value) => FloorRead::Value(value),
        Err(error) => {
            eprintln!("purple-memo: ignoring unreadable {key} floor row: {error}");
            FloorRead::Unreadable
        }
    }
}

/// Raise a floor, monotonically: the stored value never decreases. A lower
/// write (a re-pair under a reused id, a window seeded stale) must not be
/// able to re-open the replay window for envelopes already admitted under
/// this key. Values are stored as bare JSON numbers (decimal text), so the
/// `MAX` casts both sides to integers. A corrupt existing value casts to 0
/// in SQLite, so the next write self-heals the row — the read side is what
/// refuses on corruption, before any window opens.
pub(crate) fn write_floor(conn: &Connection, key: &str, value: u64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = \
         CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)",
        rusqlite::params![key, value.to_string()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counter_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .expect("settings table");
        conn
    }

    #[test]
    fn peer_floor_key_accepts_uuid_shapes_and_refuses_the_rest() {
        assert_eq!(
            peer_floor_key("9c3df3b7-3f31-4c9c-9f4a-3b0d0f5a1a91").as_deref(),
            Some("pairing_counter.9c3df3b7-3f31-4c9c-9f4a-3b0d0f5a1a91"),
        );
        assert_eq!(peer_floor_key(""), None);
        assert_eq!(peer_floor_key("has spaces in it"), None);
        assert_eq!(peer_floor_key("../escape"), None);
        assert_eq!(peer_floor_key(&"x".repeat(65)), None);
        // KEYWORDS-safe: even a plausible-looking word is fine as a *key* —
        // the parameterised statements are what make it safe, not the name.
        assert!(peer_floor_key("local").is_some());
    }

    #[test]
    fn a_floor_round_trips_and_never_goes_backwards_through_the_api() {
        let conn = counter_db();
        let key = peer_floor_key("pair-1").expect("key");
        assert_eq!(read_floor(&conn, &key), FloorRead::Absent);
        write_floor(&conn, &key, 7).expect("write");
        assert_eq!(read_floor(&conn, &key), FloorRead::Value(7));
        write_floor(&conn, &key, 42).expect("raise");
        assert_eq!(read_floor(&conn, &key), FloorRead::Value(42));
        // The monotonicity the name claims: a lower write changes nothing.
        write_floor(&conn, &key, 1).expect("lower write is accepted");
        assert_eq!(read_floor(&conn, &key), FloorRead::Value(42));
    }

    #[test]
    fn an_unreadable_floor_is_not_absent_and_not_zero() {
        let conn = counter_db();
        let key = peer_floor_key("pair-2").expect("key");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, 'not-a-number')",
            [&key],
        )
        .expect("corrupt row");
        assert_eq!(read_floor(&conn, &key), FloorRead::Unreadable);
    }
}
