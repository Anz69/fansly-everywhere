#!/usr/bin/env python3
"""
Convert gramjs StringSession → official Telethon SQLite .session file.

gramjs StringSession format:
    "1" + base64( dc_id[1] + addrLen[2, Int16BE] + addr[addrLen] + port[2, Int16BE] + authKey[256] )

Usage:  python3 make_telethon_session.py <gramjs_session_str> <output.session>
Exit 0 on success, 1 on error.
"""
import sys, sqlite3, base64, struct

GRAMJS_VERSION_PREFIX = "1"
# Must match CURRENT_VERSION in telethon/sessions/sqlite.py (= 8 for Telethon 1.44.x)
TELETHON_SCHEMA_VERSION = 8


def gramjs_to_telethon(session_str: str, output_path: str) -> None:
    session_str = session_str.strip()

    # Strip gramjs version prefix (the literal character "1")
    if not session_str.startswith(GRAMJS_VERSION_PREFIX):
        raise ValueError(
            f"Not a valid gramjs StringSession (expected version prefix '{GRAMJS_VERSION_PREFIX}')"
        )
    session_str = session_str[len(GRAMJS_VERSION_PREFIX):]

    # Decode base64 (standard — gramjs uses Buffer.toString('base64'))
    padded = session_str + "=" * (-len(session_str) % 4)
    data = base64.b64decode(padded)

    offset = 0

    # dc_id — 1 byte (uint8)
    dc_id = data[offset]; offset += 1

    # server_address — length-prefixed string (Int16BE + bytes)
    addr_len = struct.unpack(">h", data[offset: offset + 2])[0]; offset += 2
    server_address = data[offset: offset + addr_len].decode("utf-8"); offset += addr_len

    # port — Int16BE
    port = struct.unpack(">h", data[offset: offset + 2])[0]; offset += 2

    # auth_key — remaining bytes (always 256)
    auth_key = bytes(data[offset: offset + 256])

    print(
        f"[telethon] parsed: dc={dc_id} server={server_address}:{port} key_len={len(auth_key)}",
        file=sys.stderr,
    )

    # ── Create Telethon SQLite .session at schema version 8 ──────────────────
    # Schema version must be current (8 for Telethon 1.44.x) so that Telethon
    # does NOT run _upgrade_database (which would fail on a pre-populated DB).
    #
    # Full schema history:
    #   v1→2 no-op
    #   v2→3 drop/recreate sent_files; add update_state
    #   v3→4 ALTER sessions ADD takeout_id
    #   v4→5 delete entities
    #   v5→6 ALTER entities ADD date
    #   v6→7 ALTER entities ADD date (noop here — we include it already)
    #   v7→8 ALTER sessions ADD tmp_auth_key
    #
    # We create all tables with their v8-final columns upfront.
    conn = sqlite3.connect(output_path)
    c = conn.cursor()
    c.executescript(f"""
        CREATE TABLE IF NOT EXISTS version (
            version integer primary key
        );
        -- sessions v8: includes takeout_id (v4) and tmp_auth_key (v8)
        CREATE TABLE IF NOT EXISTS sessions (
            dc_id          integer primary key,
            server_address text,
            port           integer,
            auth_key       blob,
            takeout_id     integer,
            tmp_auth_key   blob
        );
        -- entities v6+: includes date column
        CREATE TABLE IF NOT EXISTS entities (
            id       integer primary key,
            hash     integer not null,
            username text,
            phone    integer,
            name     text,
            date     integer
        );
        CREATE TABLE IF NOT EXISTS sent_files (
            md5_digest blob,
            file_size  integer,
            type       integer,
            id         integer,
            hash       integer,
            primary key (md5_digest, file_size, type)
        );
        CREATE TABLE IF NOT EXISTS update_state (
            id   integer primary key,
            pts  integer,
            qts  integer,
            date integer,
            seq  integer
        );
    """)
    c.execute(f"INSERT OR IGNORE INTO version VALUES ({TELETHON_SCHEMA_VERSION})")
    c.execute(
        "INSERT OR REPLACE INTO sessions (dc_id, server_address, port, auth_key) VALUES (?, ?, ?, ?)",
        (dc_id, server_address, port, auth_key),
    )
    conn.commit()
    conn.close()

    print(f"[telethon] session created: {output_path} (schema v{TELETHON_SCHEMA_VERSION})", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: make_telethon_session.py <session_str> <output.session>", file=sys.stderr)
        sys.exit(1)
    try:
        gramjs_to_telethon(sys.argv[1], sys.argv[2])
    except Exception as e:
        print(f"[telethon] ERROR: {e}", file=sys.stderr)
        sys.exit(1)
