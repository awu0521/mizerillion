#!/usr/bin/env python3
"""
html_to_json.py: convert an Instagram group-chat HTML export (message_1.html ... message_N.html)
into one clean, chronological JSON file for the krillion game and for analysis.

Usage:
    python html_to_json.py path/to/message_*.html -o chat.json
    python html_to_json.py path/to/inbox_folder -o chat.json

What it keeps:
  * every message, oldest first, with sender, timestamp, text, shares, links and attachments
    (photos, videos, audio, gifs, stickers: the file paths from the export)
  * reactions on each message, split into `likes` and `reactions` (see LIKE_EMOJIS)
  * system notifications (group renames, nicknames, themes, adds/removes, polls, calls, pins,
    "X liked a message", "X reacted 🦭 to your message", ...) as `type: "system"` with a parsed `system` dict

Requires: pip install lxml
"""
import argparse, glob, json, os, re, sys, unicodedata
from collections import Counter, defaultdict
from datetime import datetime
from lxml import html as lxml_html

# ---------------------------------------------------------------------------
# Like emojis. ❤ counts as a like for everyone. Each person's personal like emoji
# counts as a like only when THEY use it; anyone else using it is a normal reaction.
# Keys are display names as they appear in the export (matched case-insensitively, by prefix).
# ---------------------------------------------------------------------------
UNIVERSAL_LIKES = {"❤"}
LIKE_EMOJIS = {
    "Dora": {"🦭"},
    "Luis Guevara": {"😺"},
    "bosco": {"🐒"},
    "annie": {"🩵", "🩷"},
    "Daxton": {"💙"},
    "Roy zheng": {"🥖"},
}

TS_FMT = "%b %d, %Y %I:%M %p"


def norm_emoji(e):
    """Strip variation selectors so ❤️ and ❤ compare equal."""
    return e.replace("️", "").replace("︎", "").strip()


def like_set_for(display_name):
    out = set(UNIVERSAL_LIKES)
    dn = (display_name or "").lower()
    for k, v in LIKE_EMOJIS.items():
        if dn.startswith(k.lower()):
            out |= {norm_emoji(x) for x in v}
    return out


def parse_ts(s):
    s = (s or "").strip()
    try:
        return datetime.strptime(s, TS_FMT)
    except ValueError:
        return None


def text_with_breaks(el):
    """Text content, turning <br> into newlines."""
    if el is None:
        return ""
    parts = []
    def walk(e):
        if e.tag == "br":
            parts.append("\n")
        if e.text and e.tag != "br":
            parts.append(e.text)
        for c in e:
            walk(c)
            if c.tail:
                parts.append(c.tail)
    walk(el)
    t = "".join(parts)
    t = re.sub(r"[ \t]*\n[ \t]*", "\n", t)
    return t.strip()


# ---------------------------------------------------------------------------
# System-notification patterns. The h2 sender of these lines is the actor.
# ---------------------------------------------------------------------------
SYSTEM_PATTERNS = [
    ("group_rename",      re.compile(r"^(?P<who>.+?) named the group (?P<name>.+?)\.?$", re.S)),
    ("group_name_removed", re.compile(r"^(?P<who>.+?) removed the group name\.?$")),
    ("like_notification", re.compile(r"^(?:(?P<who>\S+) )?[Ll]iked a message$")),
    ("reaction_notification", re.compile(r"^(?P<who>\S+) reacted (?P<emoji>.+?) to your message$")),
    ("nickname",          re.compile(r"^(?P<who>.+?) set (?:the nickname for (?P<target>.+?)|their own nickname|your nickname) to (?P<nick>.+?)\.?$", re.S)),
    ("nickname_cleared",  re.compile(r"^(?P<who>.+?) cleared (?:the nickname for (?P<target>.+?)|their own nickname|your nickname)\.?$")),
    ("theme",             re.compile(r"^(?P<who>.+?) changed the theme(?: using AI)? to (?P<theme>.+?)\.?$", re.S)),
    ("group_photo",       re.compile(r"^(?P<who>.+?) changed the group photo\.?$")),
    ("quick_reaction",    re.compile(r"^(?P<who>.+?) (?:changed|set) the quick reaction to (?P<emoji>.+?)\.?$")),
    ("member_added",      re.compile(r"^(?P<who>.+?) added (?P<target>.+?) to the group\.?$")),
    ("member_removed",    re.compile(r"^(?P<who>.+?) removed (?P<target>.+?) from the group\.?$")),
    ("member_left",       re.compile(r"^(?P<who>.+?) left the group\.?$")),
    ("poll_created",      re.compile(r"^(?P<who>.+?) created a poll: (?P<question>.+)$", re.S)),
    ("poll_vote",         re.compile(r"^(?P<who>.+?) (?:voted|changed (?:their|your) vote to) (?:for )?\"(?P<option>.+?)\"(?: and (?P<more>\d+) other options?)? in the poll\.?$")),
    ("poll_unavailable",  re.compile(r"^This poll is no longer available\.?$")),
    ("call_started",      re.compile(r"^(?P<who>.+?) started (?:a|an) (?P<call>video chat|audio call)\.?$")),
    ("call_missed",       re.compile(r"^(?P<who>.+?) missed (?:a|an) (?P<call>video chat|audio call)\.?$")),
    ("call_ended",        re.compile(r"^(?P<call>Audio call|Video chat) ended\.?$")),
    ("pin",               re.compile(r"^(?P<who>.+?) (?P<action>pinned|unpinned) a message\.?$")),
    ("shared_album",      re.compile(r"^(?P<who>.+?) (?P<action>started|deleted|added to|renamed|updated) (?:a |the )?shared album.*$")),
    ("collection",        re.compile(r"^(?P<who>.+?) added to a collection: (?P<collection>.+)$")),
    ("admin",             re.compile(r"^(?P<who>.+?) (?:made (?P<target>.+?) an admin|removed (?P<target2>.+?) as an admin)\.?$")),
    ("chat_setting",      re.compile(r"^(?P<who>.+?) turned (?P<state>on|off) .+$")),
]
ATTACHMENT_PLACEHOLDER = re.compile(r"^(?P<who>.+?) sent an attachment\.$")


def classify_system(text):
    if not text or len(text) > 400:
        return None
    for kind, rx in SYSTEM_PATTERNS:
        m = rx.match(text)
        if m:
            d = {k: v for k, v in m.groupdict().items() if v is not None}
            if "target2" in d:
                d["target"] = d.pop("target2")
            who = d.get("who")
            if who and " " in who and who != "A contact":
                return None  # system lines start with a username or "You"; real sentences don't
            if "emoji" in d:
                d["emoji"] = norm_emoji(d["emoji"])
            return {"kind": kind, **d}
    return None


def split_reaction(li, known_names):
    """<li><span>❤Roy zheng (Oct 12, 2026 11:04 am)</span></li> -> (emoji, name, ts, sticker_path)"""
    sticker = None
    img = li.xpath(".//img")
    if img:
        sticker = img[0].get("src")
    raw = li.text_content().strip()
    ts = None
    m = re.search(r"\s*\((\w{3} \d{2}, \d{4} \d{1,2}:\d{2} [ap]m)\)\s*$", raw)
    if m:
        ts = m.group(1)
        raw = raw[: m.start()]
    name = None
    for n in known_names:  # longest-first
        if raw.endswith(n):
            name = n
            break
    if name is None:
        # fall back: emoji = leading non-letter run
        m2 = re.match(r"^([^\w]+?)(\w.*)$", raw, re.S)
        emoji, name = (m2.group(1), m2.group(2)) if m2 else ("", raw)
    else:
        emoji = raw[: len(raw) - len(name)]
    return norm_emoji(emoji), name.strip(), ts, sticker


def media_kind(path):
    p = (path or "").lower().split("?")[0]
    if "/videos/" in p or p.endswith((".mp4", ".mov")):
        return "video"
    if "/audio/" in p:
        return "audio"
    if "/gifs/" in p or p.endswith(".gif"):
        return "gif"
    if "/messages/photos/" in p and "/inbox/" not in p:
        return "sticker"
    if "/photos/" in p or p.endswith((".jpg", ".jpeg", ".png", ".webp")):
        return "photo"
    return "file"


def page_number(path):
    m = re.search(r"message_(\d+)\.html$", path)
    return int(m.group(1)) if m else 0


def parse_files(paths):
    paths = sorted(paths, key=page_number)
    meta = {}
    raw_msgs = []
    # pass 1: collect names so reactions can be split reliably
    trees = []
    names = set()
    for p in paths:
        t = lxml_html.parse(p).getroot()
        trees.append((p, t))
        for h in t.xpath("//main/div[contains(@class,'pam')]/h2"):
            names.add(h.text_content().strip())
        part = t.xpath("//h2[starts-with(normalize-space(.),'Participants:')]")
        if part:
            plist = part[0].text_content().split(":", 1)[1].strip()
            plist = re.split(r", | and (?=[^,]+$)", plist)
            meta["participants"] = [x.strip() for x in plist]
            names |= set(meta["participants"])
        if "title" not in meta:
            h1 = t.xpath("//header//h1")
            meta["title"] = h1[0].text_content().strip() if h1 else None
            gen = t.xpath("//header//aside")
            meta["export_note"] = gen[0].text_content().strip() if gen else None
    known_names = sorted({n for n in names if n}, key=len, reverse=True)

    for p, t in trees:
        page = page_number(p)
        blocks = t.xpath("//main/div[contains(@class,'pam')]")
        for pos, m in enumerate(blocks):
            h2 = m.xpath("./h2")
            sender = h2[0].text_content().strip() if h2 else None
            ts_el = m.xpath("./div[contains(@class,'_a6-o')]")
            body = m.xpath("./div[contains(@class,'_a6-p')]")
            if not ts_el:
                # header blocks like "Group photo" / "Group Invite Link: On"
                if sender:
                    links = [a.get("href") for a in m.xpath(".//a")]
                    meta.setdefault("header", {})[sender] = links
                continue
            ts_raw = ts_el[0].text_content().strip()
            ts = parse_ts(ts_raw)
            inner = body[0].xpath("./div")[0] if body and body[0].xpath("./div") else None
            kids = inner.xpath("./div") if inner is not None else []

            text = text_with_breaks(kids[1]) if len(kids) > 1 else ""

            # share block (kids[2]): caption / owner / url
            share = None
            if len(kids) > 2 and kids[2].text_content().strip():
                sdivs = kids[2].xpath("./div/div") or kids[2].xpath(".//div")
                parts = [text_with_breaks(d) for d in sdivs]
                url = next((a.get("href") for a in kids[2].xpath(".//a")), None)
                parts = [x for x in parts if x and x != url]
                share = {"url": url}
                if parts:
                    # one field when it's just a link preview, else caption + owner
                    if len(parts) >= 2:
                        share["caption"], share["owner"] = parts[0], parts[1]
                    else:
                        share["owner" if url and ("giphy" in url) else "caption"] = parts[0]
                if share.get("caption") and share["caption"] == text:
                    share.pop("caption")  # plain-text echo

            # attachments: media outside the reactions list
            attachments = []
            for el in (inner.xpath(".//img|.//video|.//audio") if inner is not None else []):
                if el.xpath("ancestor::ul[contains(@class,'_a6-q')]"):
                    continue
                src = el.get("src")
                if src and not any(a["path"] == src for a in attachments):
                    attachments.append({"kind": media_kind(src), "path": src})
            if share and share.get("url") and "giphy.com" in share["url"]:
                attachments.append({"kind": "gif", "path": share["url"]})

            # inline links in the text
            links = [a.get("href") for a in (kids[1].xpath(".//a") if len(kids) > 1 else [])]

            # reactions
            likes, reactions = [], []
            for li in m.xpath(".//ul[contains(@class,'_a6-q')]/li"):
                emoji, who, rts, sticker = split_reaction(li, known_names)
                item = {"by": who, "emoji": emoji or None}
                if rts:
                    item["ts"] = (parse_ts(rts) or rts).isoformat() if parse_ts(rts) else rts
                if sticker:
                    item["sticker"] = sticker
                if emoji and not sticker and emoji in like_set_for(who):
                    likes.append(item)
                else:
                    reactions.append(item)

            raw_msgs.append(dict(page=page, pos=pos, sender=sender, ts=ts, ts_raw=ts_raw, text=text,
                                 share=share, attachments=attachments, links=links,
                                 likes=likes, reactions=reactions))

    # chronological: page N (oldest) last-position first ... page 1 position 0 newest
    raw_msgs.sort(key=lambda r: (-r["page"], -r["pos"]))

    messages = []
    for i, r in enumerate(raw_msgs):
        msg = {"id": i, "ts": r["ts"].isoformat() if r["ts"] else None, "sender": r["sender"]}
        text = r["text"]
        system = classify_system(text) if not r["attachments"] and not r["share"] else None
        if system:
            msg["type"] = "system"
            msg["system"] = system
            msg["text"] = text
            if system["kind"] == "reaction_notification":
                system["is_like"] = system["emoji"] in like_set_for(r["sender"])
        else:
            ph = ATTACHMENT_PLACEHOLDER.match(text) if text else None
            if ph:
                msg["attachment_placeholder"] = True
                text = ""
            if text:
                msg["type"] = "text"
            elif r["share"]:
                msg["type"] = "share"
            elif r["attachments"]:
                msg["type"] = r["attachments"][0]["kind"]
            elif ph:
                msg["type"] = "attachment_unavailable"  # "X sent an attachment." with nothing exported
            else:
                msg["type"] = "empty"  # content not in export (unsent, expired story, sticker, etc.)
            if text:
                msg["text"] = text
        if r["share"]:
            msg["share"] = r["share"]
        if r["attachments"]:
            msg["attachments"] = r["attachments"]
        if r["links"]:
            msg["links"] = r["links"]
        if r["likes"]:
            msg["likes"] = r["likes"]
        if r["reactions"]:
            msg["reactions"] = r["reactions"]
        msg["source"] = f"message_{r['page']}.html#{r['pos']}"
        messages.append(msg)

    # username -> display name, learned from system lines whose actor is the h2 sender
    uname = defaultdict(Counter)
    for m in messages:
        if m["type"] == "system":
            who = m["system"].get("who")
            if who and who not in ("You", "A contact") and " " not in who:
                uname[who][m["sender"]] += 1
    usernames = {u: c.most_common(1)[0][0] for u, c in uname.items()}
    # "You" in system lines is the exporter
    you = Counter(m["sender"] for m in messages if m["type"] == "system" and m["system"].get("who") == "You")
    exporter = you.most_common(1)[0][0] if you else None
    gm = re.search(r"Generated by (\S+) on", meta.get("export_note") or "")
    if exporter and gm:
        usernames[gm.group(1)] = exporter
    for m in messages:
        if m["type"] == "system":
            m["system"]["actor"] = m["sender"]

    senders = Counter(m["sender"] for m in messages)
    meta.update({
        "exporter": exporter,
        "message_count": len(messages),
        "first_ts": messages[0]["ts"] if messages else None,
        "last_ts": messages[-1]["ts"] if messages else None,
        "pages": len(paths),
        "timestamps_note": "Local time as shown in the export (no timezone).",
        "like_rules": {"universal": sorted(UNIVERSAL_LIKES),
                       "personal": {k: sorted(v) for k, v in LIKE_EMOJIS.items()}},
    })
    people = [{"display_name": n, "messages": senders.get(n, 0),
               "usernames": sorted(u for u, d in usernames.items() if d == n),
               "like_emojis": sorted(like_set_for(n))}
              for n in sorted(set(senders) | set(meta.get("participants", [])), key=lambda n: -senders.get(n, 0))]
    return {"meta": meta, "people": people, "messages": messages}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="message_*.html files or a folder containing them")
    ap.add_argument("-o", "--out", default="chat.json")
    a = ap.parse_args()
    paths = []
    for i in a.inputs:
        if os.path.isdir(i):
            paths += glob.glob(os.path.join(i, "*message_*.html"))
        else:
            paths += glob.glob(i)
    if not paths:
        sys.exit("No message_*.html files found")
    data = parse_files(paths)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    types = Counter(m["type"] for m in data["messages"])
    sys_kinds = Counter(m["system"]["kind"] for m in data["messages"] if m["type"] == "system")
    print(f"{len(paths)} pages -> {a.out}: {len(data['messages'])} messages")
    print("types:", dict(types.most_common()))
    print("system:", dict(sys_kinds.most_common()))


if __name__ == "__main__":
    main()
