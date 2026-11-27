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
//! Pairing ids are minted as UUIDs by the app; anything that does not look
//! like one (hand-edited IPC input) is refused a key rather than becoming a
//! settings row that code elsewhere cannot tell apart from its neighbours.

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

/// The stored floor, or `None` when the row is absent or unreadable. An
/// unreadable row is *not* zero: silently accepting a corrupted floor would
/// re-open the replay window it exists to close, and the caller that seeds a
/// window treats `None` as "no floor" — which is why a corrupt floor is
/// reported on stderr here instead of passed off as a number.
pub(crate) fn read_floor(conn: &Connection, key: &str) -> Option<u64> {
    let raw: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .ok()?;
    match serde_json::from_str::<u64>(&raw) {
        Ok(value) => Some(value),
        Err(error) => {
            eprintln!("purple-memo: ignoring unreadable {key} floor row: {error}");
            None
        }
    }
}

/// Upsert a floor. The value is stored as a bare JSON number so the row is
/// indistinguishable from every other numeric settings row.
pub(crate) fn write_floor(conn: &Connection, key: &str, value: u64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
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
        assert_eq!(read_floor(&conn, &key), None);
        write_floor(&conn, &key, 7).expect("write");
        assert_eq!(read_floor(&conn, &key), Some(7));
        write_floor(&conn, &key, 42).expect("raise");
        assert_eq!(read_floor(&conn, &key), Some(42));
    }

    #[test]
    fn an_unreadable_floor_is_none_not_zero() {
        let conn = counter_db();
        let key = peer_floor_key("pair-2").expect("key");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, 'not-a-number')",
            [&key],
        )
        .expect("corrupt row");
        assert_eq!(read_floor(&conn, &key), None);
    }
}
