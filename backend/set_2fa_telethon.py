#!/usr/bin/env python3
"""Set Telegram 2FA password via Telethon.
Email confirmation is handled automatically via IMAP (ZickMail).

Usage:
  python3 set_2fa_telethon.py <session_file_no_ext> <api_id> <api_hash> <password> [<email> <email_pwd>]

Prints "2FA_OK" to stdout on success.
"""
import asyncio, sys, imaplib, email as emaillib, re, time

IMAP_HOST = "imap.zick-mail.casa"
IMAP_PORT = 993


def imap_get_existing_uids(email_addr, email_pwd):
    """Get the set of all email UIDs currently in INBOX (snapshot before 2FA trigger)."""
    try:
        m = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        m.login(email_addr, email_pwd)
        m.select("INBOX")
        _, ids = m.search(None, "ALL")
        uids = set(ids[0].split()) if ids[0] else set()
        m.logout()
        print(f"IMAP_SNAPSHOT:{len(uids)} existing emails", flush=True)
        return uids
    except Exception as e:
        print(f"IMAP_SNAPSHOT_ERR:{e}", flush=True)
        return set()


def imap_wait_code(email_addr, email_pwd, max_wait=120, existing_uids=None):
    """Poll IMAP inbox for a 6-digit Telegram confirmation code in NEW emails only.

    existing_uids — set of UIDs that were in INBOX before 2FA was triggered.
    Only emails NOT in existing_uids are checked, preventing stale code reuse.
    """
    if existing_uids is None:
        existing_uids = set()
    deadline = time.time() + max_wait
    checked_new = set()

    while time.time() < deadline:
        try:
            m = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
            m.login(email_addr, email_pwd)
            m.select("INBOX")
            _, ids = m.search(None, "ALL")
            all_uids = ids[0].split() if ids[0] else []

            # Only look at UIDs that weren't there before 2FA and haven't been checked yet
            new_uids = [uid for uid in all_uids
                        if uid not in existing_uids and uid not in checked_new]

            for uid in reversed(new_uids):  # newest first
                checked_new.add(uid)
                try:
                    _, data = m.fetch(uid, "(RFC822)")
                    msg = emaillib.message_from_bytes(data[0][1])
                    body = b""
                    if msg.is_multipart():
                        for part in msg.walk():
                            if part.get_content_type() in ("text/plain", "text/html"):
                                body += part.get_payload(decode=True) or b""
                    else:
                        body = msg.get_payload(decode=True) or b""
                    body_str = body.decode(errors="ignore")
                    code_m = re.search(r'\b(\d{6})\b', body_str)
                    if code_m:
                        m.logout()
                        return code_m.group(1)
                except Exception as fe:
                    print(f"IMAP_FETCH_ERR:{fe}", flush=True)

            m.logout()
            if new_uids:
                print(f"IMAP_POLL: {len(new_uids)} new email(s), no code yet", flush=True)
            else:
                print(f"IMAP_POLL: waiting for new email…", flush=True)

        except Exception as e:
            print(f"IMAP_ERR:{e}", flush=True)
        time.sleep(5)

    return None


async def main():
    if len(sys.argv) < 5:
        print("Usage: set_2fa_telethon.py <session> <api_id> <api_hash> <password> [<email> <email_pwd>]",
              file=sys.stderr, flush=True)
        sys.exit(1)

    session_file = sys.argv[1]
    api_id       = int(sys.argv[2])
    api_hash     = sys.argv[3]
    new_password = sys.argv[4]
    email_addr   = sys.argv[5] if len(sys.argv) > 5 else None
    email_pwd    = sys.argv[6] if len(sys.argv) > 6 else None

    from telethon import TelegramClient
    client = TelegramClient(
        session_file, api_id, api_hash,
        device_model="Telegram Desktop",
        system_version="Windows 10",
        app_version="5.8.1",
        lang_code="en",
        system_lang_code="en-US",
        connection_retries=5,
        retry_delay=2,
        request_retries=3,
    )
    try:
        await client.connect()
        if not await client.is_user_authorized():
            print("ERROR: session not authorized", file=sys.stderr, flush=True)
            sys.exit(1)

        if email_addr and email_pwd:
            # Snapshot existing UIDs BEFORE triggering 2FA so we ignore stale codes
            loop = asyncio.get_event_loop()
            existing_uids = await loop.run_in_executor(
                None, imap_get_existing_uids, email_addr, email_pwd
            )

            async def email_callback(email_to=None):
                print(f"IMAP_WAIT:{email_addr}", flush=True)
                code = await loop.run_in_executor(
                    None, imap_wait_code, email_addr, email_pwd, 120, existing_uids
                )
                if not code:
                    raise Exception(f"No confirmation code received for {email_addr} within 120s")
                print(f"IMAP_CODE:{code}", flush=True)
                return code

            await client.edit_2fa(
                new_password=new_password,
                email=email_addr,
                hint="remember",
                email_code_callback=email_callback,
            )
        else:
            # No email — set 2FA without recovery email
            await client.edit_2fa(new_password=new_password, hint="remember")

        print("2FA_OK", flush=True)

    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr, flush=True)
        sys.exit(1)
    finally:
        await client.disconnect()

asyncio.run(main())
