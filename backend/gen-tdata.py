#!/usr/bin/env python3
"""
Generate Telegram Desktop TData from a Telethon SQLite .session file.

Usage:
    python3 gen-tdata.py <path/to/session.session> <output_tdata_dir>

Environment:
    TELEGRAM_API_ID    — API ID used to create the session
    TELEGRAM_API_HASH  — API Hash used to create the session
"""

import asyncio
import sys
import os


async def main():
    if len(sys.argv) < 3:
        print("Usage: gen-tdata.py <session_file.session> <output_dir>", file=sys.stderr)
        sys.exit(1)

    session_path = sys.argv[1]
    out_dir      = sys.argv[2]
    api_id       = int(os.environ.get("TELEGRAM_API_ID", "2040"))
    api_hash     = os.environ.get("TELEGRAM_API_HASH", "b18441a1ff607e10a989891a5462e627")

    # Strip .session extension if passed — opentele/Telethon appends it automatically
    if session_path.endswith(".session"):
        session_path = session_path[:-len(".session")]

    from opentele.tl import TelegramClient
    from opentele.td import TDesktop
    from opentele.api import UseCurrentSession

    # TelegramClient(session_path_without_ext, api_id, api_hash) opens existing SQLite session
    client = TelegramClient(session_path, api_id=api_id, api_hash=api_hash)
    try:
        await client.connect()
        me = await client.get_me()
        print(f"[gen-tdata] connected as {me.first_name} (id={me.id})", file=sys.stderr)

        tdesk = await TDesktop.FromTelethon(client, flag=UseCurrentSession)
        tdesk.SaveTData(out_dir)
        print(f"[gen-tdata] tdata saved to: {out_dir}", flush=True)
    finally:
        await client.disconnect()


asyncio.run(main())
