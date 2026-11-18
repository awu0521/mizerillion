#!/usr/bin/env python3
"""
make_prompts.py: build a krillion-style prompt bank from chat.json + eda_out/stats.json.

Usage:
    python make_prompts.py chat.json eda_out/stats.json -o prompt_bank.json

Each prompt has the same shape the OpenKrillion worker uses:
    {"id", "text", "category", "answers": [{"answer", "tier", "aliases", "quip", "weight"}]}

Tiers are set automatically from how common each answer is in the chat (weight):
    the answers that make up the first ~45% of total weight -> plankton  (10)
    up to ~80%                                              -> schooler  (30)
    up to ~95%                                              -> rare      (60)
    the long tail                                           -> deepcut   (85)
    the rarest answer                                       -> krillion  (100)  marked "auto_pick": true
"Too clever" (15) is never set automatically: edit the JSON and change a tier to "tooclever" by hand.
Anything with "review": true deserves a human look before it goes live.
"""
import argparse, json, math, re, unicodedata
from collections import Counter, defaultdict

TIER_CUTS = [(0.45, "plankton"), (0.80, "schooler"), (0.95, "rare"), (1.01, "deepcut")]
MAX_ANSWERS = 45
EXCLUDE = {"Instagram User", "Meta AI", "a participant"}
# words never offered as answers (edit freely)
BLOCKLIST = {"retarded", "retard", "nigga", "nigger", "faggot", "fag", "tranny", "kys"}

# extra ways people might type each member (first names, short forms, usernames are added automatically)
PERSON_ALIASES = {
    "Daxton": ["dax", "daxton"], "Jonathan Ko": ["jon", "jonathan", "jonjon", "ko"], "V": ["veronica", "vron", "v"],
    "Roy zheng": ["roy"], "Luis Guevara": ["luis"], "Thomas Ah Sing": ["thomas", "tom"], "annie": ["annie", "annie wu"],
    "Elden": ["elden"], "jocelyn": ["jocelyn", "joce", "jos"], "Rafee Ahsan": ["rafee"], "ambrose lee": ["ambrose"],
    "Adam Tsang": ["adam"], "Dora": ["dora"], "adrian": ["adrian"], "bosco": ["bosco"], "avery": ["avery"],
    "Angel H.": ["angel"], "ariel": ["ariel"], "heidii": ["heidi", "heidii"], "jenica": ["jenica"],
}
# words players can type instead of the emoji
EMOJI_WORDS = {
    "❤": ["heart", "red heart", "love"], "🦭": ["seal"], "😺": ["cat", "smiling cat"], "🥖": ["baguette", "bread"],
    "🩷": ["pink heart"], "💙": ["blue heart", "dark blue heart"], "🐒": ["monkey"], "🩵": ["light blue heart"],
    "😭": ["crying", "sob", "loudly crying"], "💀": ["skull", "skeleton"], "👎": ["thumbs down"], "👍": ["thumbs up"],
    "🥀": ["wilted rose", "wilted flower", "dead rose", "rose"], "☹": ["frown", "frowning", "sad face"], "🔥": ["fire"],
    "🥲": ["smiling tear", "smile tear", "holding back tears"], "😢": ["tear", "crying face", "sad crying"], "🧢": ["cap", "blue cap"],
    "😦": ["frowning open mouth", "shocked"], "😔": ["pensive"], "😃": ["smile", "grin", "big smile"],
    "😂": ["joy", "laughing", "tears of joy", "laugh cry"], "🏳‍🌈": ["pride flag", "rainbow flag", "gay flag"],
    "🤨": ["raised eyebrow", "eyebrow", "sus"], "😡": ["angry", "mad", "rage"], "👅": ["tongue"], "🙁": ["slight frown"],
    "💔": ["broken heart"], "👋": ["wave", "waving"], "⁉": ["interrobang"], "👽": ["alien"], "❓": ["question mark", "question"],
    "🙏": ["pray", "praying", "please", "folded hands"], "🗣": ["speaking head", "yapping"], "🥳": ["party", "party face"],
    "🙂": ["slight smile", "smiley"], "😍": ["heart eyes"], "😋": ["yum"], "🥹": ["holding tears", "pleading tears"],
    "🎉": ["party popper", "tada", "confetti"], "😞": ["disappointed"], "🟩": ["green square"], "🟥": ["red square"],
    "🤷": ["shrug"], "🥺": ["pleading", "puppy eyes"], "🤣": ["rofl", "rolling"], "🫡": ["salute"],
}
LAUGH_ALIASES = {
    "😭": ["crying emoji", "sob", "crying"], "💀": ["skull", "skull emoji"], "lmao": ["lmfao", "lmaoo", "lmaooo"],
    "LMAO (caps)": ["LMAO", "caps lmao", "all caps lmao"], "lol": ["lool", "lolol"], "haha": ["hahaha", "hahahaha"],
    "😂": ["laughing emoji", "tears of joy"], "ded": ["dead", "im dead", "i'm dead"], "hehe": ["heehee"], "ahaha": ["ahahaha"],
    "xd": ["xD"],
}
PLACES = {
    "Nest": [r"\bnest\b"], "IKB (Irving K. Barber library)": [r"\bikb\b", r"irving"], "Totem": [r"\btotem\b"],
    "Vanier": [r"\bvanier\b"], "Orchard Commons (OC)": [r"\boc\b", r"orchard"], "Buchanan": [r"\bbuchanan\b", r"\bbuch\b"],
    "Wesbrook": [r"\bwe?st?brook\b"], "Sauder": [r"\bsauder\b"], "Metrotown": [r"\bmetrotown\b", r"\bmetro\b"],
    "Richmond": [r"\brichmond\b"], "Burnaby": [r"\bburnaby\b"], "White Rock": [r"\bwhite rock\b"],
    "Abbotsford": [r"\babbotsford\b", r"\babby\b"], "Kokoro": [r"\bkokoro\b"], "Big Way": [r"\bbig ?way\b"],
    "Browns": [r"\bbrowns\b"], "Cactus Club": [r"\bcactus\b"], "McDonald's": [r"\bmcdonald'?s?\b", r"\bmcd'?s?\b"],
    "Costco": [r"\bcostco\b"], "Kitsilano (Kits)": [r"\bkits\b", r"kitsilano"], "Granville": [r"\bgranville\b"],
    "Oakridge": [r"\boakridge\b"], "Starbucks": [r"\bstarbucks\b", r"\bsbux\b"], "Popeyes": [r"\bpopeyes\b"],
    "Tim Hortons": [r"\btim hortons\b", r"\btimmies\b", r"\btims\b"], "Sea House": [r"\bsea ?house\b"],
    "The gym / ARC": [r"\bgym\b", r"\barc\b"], "Life Building": [r"\blife building\b", r"\blife\b(?= building)"],
    "Hong Kong": [r"\bhong ?kong\b"], "Philippines": [r"\bphilippines\b", r"\bphilly\b"], "Calgary": [r"\bcalgary\b"],
    "Vegas": [r"\bvegas\b"], "Seattle": [r"\bseattle\b"], "Whistler": [r"\bwhistler\b"], "Downlow": [r"\bdownlow\b"],
    "Zubu": [r"\bzubu\b"], "Panda Express": [r"\bpanda express\b"], "Uncle Fatih's": [r"\buncle fatih"],
    "Jericho": [r"\bjericho\b"], "Bridgeport": [r"\bbridgeport\b"], "Coquitlam": [r"\bcoquitlam\b", r"\bcoq\b"],
    "Surrey": [r"\bsurrey\b"], "SFU": [r"\bsfu\b"], "Waterloo": [r"\bwaterloo\b"], "Toronto": [r"\btoronto\b"],
}
DAILY_GAMES = {"Wordle": [r"^wordle \d"], "Connections": [r"^connections\b"], "Strands": [r"^strands\b"],
               "Krillion": [r"^krillion #"], "Feetle": [r"^feetle #"], "Rule34dle": [r"rule34dle"],
               "Royaledle": [r"royaledle"], "Globle": [r"globle"], "Minute Cryptic": [r"minutecryptic|minute cryptic"],
               "Costcodle": [r"costcodle"], "Framed": [r"framed\.wtf|^framed #"], "Worldle": [r"worldle"],
               "Bandle": [r"bandle"], "Spotle": [r"spotle"], "Pokedoku": [r"pokedoku"], "Loldle": [r"loldle"],
               "Smashdle": [r"smashdle"], "Pokedle": [r"pokedle"]}


def normalize(v):
    """OpenKrillion's normalize(), except emoji/symbols are kept so emoji answers work.
    The game must use the same rule (keep a-z, 0-9 and Unicode 'So'/'Sk' symbols)."""
    v = unicodedata.normalize("NFKD", str(v))
    v = "".join(ch for ch in v if not unicodedata.combining(ch)).lower().replace("&", "and")
    return "".join(ch for ch in v if ("a" <= ch <= "z") or ("0" <= ch <= "9")
                   or (ord(ch) > 0x2000 and unicodedata.category(ch) in ("So", "Sk")))


def clean_name(n):
    return re.sub(r"\s*[^\x00-\x7F]+\s*$", "", n).strip() or n


def person_aliases(name, people):
    key = clean_name(name)
    al = set(PERSON_ALIASES.get(key, [])) | {key.lower(), key.split()[0].lower()}
    for p in people:
        if p["display_name"] == name:
            al |= {u.lower() for u in p["usernames"] if u not in ("You",)}
    al.discard(key.lower())
    return sorted(a for a in al if a and normalize(a))


def tier_answers(items, krillion=True):
    """items: list of dicts with answer, weight. Returns them with tiers set (most common first)."""
    items = [i for i in items if i["weight"] > 0]
    items.sort(key=lambda i: -i["weight"])
    items = items[:MAX_ANSWERS]
    # tiers use sqrt(weight): how memorable an answer is grows slower than how often it happened
    total = sum(math.sqrt(i["weight"]) for i in items) or 1
    cum = 0
    for idx, i in enumerate(items):
        share_before = cum / total
        cum += math.sqrt(i["weight"])
        i["tier"] = next(t for cut, t in TIER_CUTS if share_before < cut)
        if idx == 0:
            i["tier"] = "plankton"
    if krillion and len(items) >= 5:
        items[-1]["tier"] = "krillion"; items[-1]["auto_pick"] = True
    for i in items:
        i["weight"] = round(i["weight"], 2)
    return items


def merge_by_key(items, keyfn=lambda a: normalize(a).rstrip("s")):
    """Merge answers that differ only by punctuation/case/plural; keep the most-weighted spelling."""
    groups = defaultdict(list)
    for i in items:
        groups[keyfn(i["answer"])].append(i)
    out = []
    for g in groups.values():
        g.sort(key=lambda i: -i["weight"])
        best = dict(g[0])
        best["weight"] = sum(i["weight"] for i in g)
        al = set(best.get("aliases", []))
        for i in g[1:]:
            al.add(i["answer"]); al |= set(i.get("aliases", []))
        al.discard(best["answer"])
        if al: best["aliases"] = sorted(al)
        quips = [i.get("quip") for i in g if i.get("quip")]
        if quips: best["quip"] = quips[0]
        out.append(best)
    return out


def check_unambiguous(prompt):
    """Warn when two different answers share a normalized alias (the game would reject both)."""
    seen = {}
    clashes = []
    for a in prompt["answers"]:
        for w in [a["answer"], *a.get("aliases", [])]:
            k = normalize(w)
            if k in seen and seen[k] != a["answer"]:
                clashes.append((w, seen[k], a["answer"]))
            seen.setdefault(k, a["answer"])
    return clashes


def build(chat, S):
    people = chat["people"]
    msgs = chat["messages"]
    exporter = chat["meta"].get("exporter")
    regulars = [p for p in S["regulars"] if p not in EXCLUDE]
    P = []

    def add(pid, text, category, answers, review=False, note=None, krillion=True):
        answers = tier_answers(answers, krillion)
        if len(answers) < 4:
            return
        p = {"id": pid, "text": text, "category": category, "answers": answers}
        if review: p["review"] = True
        if note: p["note"] = note
        P.append(p)

    # 1. group chat names, weighted by days in use (+0.5 per time it was set so one-minute names still count)
    gn = [{"answer": n, "weight": days + 0.5 * times,
           "quip": f"{'Used' if days >= 1 else 'Lasted'} {days:g} day{'s' if days != 1 else ''}, set by {', '.join(clean_name(s) for s in setby)}"}
          for n, days, times, setby in S["group_names_total"]]
    add("group-names", "Name a name this group chat has had", "system", merge_by_key(gn),
        note="Weighted by days each name was in use.")

    # 2. who renamed the chat
    add("group-renamers", "Name someone who has renamed the group chat", "system",
        [{"answer": clean_name(p), "weight": n, "aliases": person_aliases(p, people), "quip": f"{n} rename{'s' * (n > 1)}"} for p, n in S["group_renamers"]])

    # 3. nicknames: overall and per person
    allnick = Counter(); nick_target = {}
    for r in S["nicknames"]:
        allnick[r["nickname"]] += 1; nick_target.setdefault(r["nickname"], r["target"])
    add("nicknames-any", "Name a nickname someone has had in this chat", "system",
        merge_by_key([{"answer": n, "weight": c, "quip": f"{clean_name(nick_target[n])}'s nickname"} for n, c in allnick.items()],
                     keyfn=lambda a: normalize(a)), review=True)
    for person, nicks in S["nicknames_by_person"].items():
        if person in EXCLUDE or len(set(n.lower() for n in nicks)) < 5:
            continue
        c = Counter(nicks)
        add(f"nicknames-{normalize(person)}", f"Name a nickname {clean_name(person)} has had in the chat", "system",
            merge_by_key([{"answer": n, "weight": k} for n, k in c.items()], keyfn=lambda a: normalize(a)))

    # 4. members
    add("members", "Name someone in the group chat (past or present)", "people",
        [{"answer": clean_name(p), "weight": n, "aliases": person_aliases(p, people), "quip": f"{n:,} messages"}
         for p, n in S["messages_per_person"] if p not in EXCLUDE])
    # 5. removed / left
    gone = Counter()
    for _, t in S["membership"]:
        m = re.match(r"^\S+ removed (.+?) from the group", t) or re.match(r"^(\S+) left the group", t)
        if m: gone[{"Avery Hayes": "avery"}.get(m.group(1), m.group(1))] += 1
    add("removed", "Name someone who got removed from (or left) the group chat", "system",
        [{"answer": clean_name(p), "weight": 1 + S_msgs(S, p) / 1000, "aliases": person_aliases(p, people)} for p in gone])

    # 6. likes / reactions
    add("big-likers", "Name someone who likes a LOT of messages", "likes",
        [{"answer": clean_name(p), "weight": n, "aliases": person_aliases(p, people), "quip": f"{n:,} likes given ({pct}% of everyone else's messages)"}
         for p, n, pct in S["likes_given"] if p not in EXCLUDE])
    add("most-liked", "Name someone whose messages get liked a lot", "likes",
        [{"answer": clean_name(p), "weight": n, "aliases": person_aliases(p, people), "quip": f"{n:,} likes received"}
         for p, n, _ in S["likes_received"] if p not in EXCLUDE])
    add("like-emojis", "Name an emoji one of us uses as our like", "likes",
        [{"answer": e, "weight": n, "aliases": EMOJI_WORDS.get(e, []), "quip": f"used {n:,} times as a like"} for e, n in S["like_emoji_counts"]])
    add("reaction-emojis", "Name an emoji we react with (not a like)", "likes",
        [{"answer": e, "weight": n, "aliases": EMOJI_WORDS.get(e, [])} for e, n in S["reaction_emojis"] if e != "(sticker)"])
    add("text-emojis", "Name an emoji we send in messages", "words",
        [{"answer": e, "weight": n, "aliases": EMOJI_WORDS.get(e, [])} for e, n in S["text_emoji_totals"] if e not in ("🏻", "🏼", "🏽", "♀", "♂")])
    add("funny-people", "Name someone who gets lots of 😭 / 💀 reactions", "likes",
        [{"answer": clean_name(p), "weight": n, "aliases": person_aliases(p, people)} for p, n in S["funniest_by_laugh_reactions"] if p not in EXCLUDE])

    # 7. how we talk
    add("laughs", "Name a way we laugh in the chat", "words",
        merge_by_key([{"answer": k.replace(" (caps)", ""), "weight": n, "aliases": LAUGH_ALIASES.get(k, [])}
                      for k, n in S["laugh_totals"] if n], keyfn=normalize))
    add("common-words", "Name a word we say all the time", "words",
        [{"answer": w, "weight": n} for w, n in S["top_words"] if w not in BLOCKLIST and len(w) > 2], review=True)
    for p in regulars[:12]:
        words = [(w, n) for w, n in S["distinctive_words"].get(p, []) if w not in BLOCKLIST and not re.search(r"'", w)]
        if len(words) >= 6:
            add(f"words-{normalize(p)}", f"Name a word {clean_name(p)} says way more than everyone else", "words",
                [{"answer": w, "weight": n} for w, n in words], review=True)
    # most-liked quotes -> "finish the message" is better as a separate game mode; here: who said it
    # 8. habits
    add("night-owls", "Name someone texting the chat between 1 and 5 am", "people",
        [{"answer": clean_name(p), "weight": n, "aliases": person_aliases(p, people), "quip": f"{n:,} late-night messages"} for p, n, _ in S["night_owls_1am_5am"]])
    add("revivers", "Name someone who revives a dead chat", "people",
        [{"answer": clean_name(p), "weight": n, "aliases": person_aliases(p, people), "quip": f"broke {n} silences of 6h+"} for p, n in S["chat_revivers_after_6h"] if p not in EXCLUDE])
    add("callers", "Name someone who starts calls in the chat", "system",
        [{"answer": clean_name(p), "weight": n, "aliases": person_aliases(p, people)} for p, n in S["calls_started"] if p not in EXCLUDE])
    add("photo-senders", "Name someone who sends lots of photos", "people",
        [{"answer": clean_name(p), "weight": n, "aliases": person_aliases(p, people)} for p, n in S["media_by_person"].get("photo", []) if p not in EXCLUDE])
    add("talked-about", "Name someone who gets talked about in the chat", "people",
        [{"answer": clean_name(p), "weight": n, "aliases": person_aliases(p, people), "quip": f"name said {n:,} times"} for p, n in S["name_mentions"]])

    # 9. themes, games, places, accounts
    th = Counter(t for _, _, t in S["themes"])
    add("themes", "Name a theme this chat has used", "system",
        merge_by_key([{"answer": t.strip('"'), "weight": n} for t, n in th.items()], keyfn=normalize))
    texts = [m for m in msgs if m.get("text") and m["type"] == "text" and m["sender"] not in EXCLUDE]
    gc = Counter()
    for m in texts:
        low = m["text"].lower()
        for g, rxs in DAILY_GAMES.items():
            if any(re.search(rx, low) for rx in rxs): gc[g] += 1
    add("daily-games", "Name a daily game someone posts results from", "games",
        [{"answer": g, "weight": n, "quip": f"posted {n} times"} for g, n in gc.items()])
    pc = Counter()
    for m in texts:
        low = m["text"].lower().replace("’", "'")
        for place, rxs in PLACES.items():
            if any(re.search(rx, low) for rx in rxs): pc[place] += 1
    add("places", "Name a place that comes up in the chat", "places",
        [{"answer": p, "weight": n, "aliases": place_aliases(p)} for p, n in pc.items() if n >= 3], review=True,
        note="Place list is hand-made in PLACES; add your spots.")
    add("accounts", "Name an Instagram account we share posts from", "media",
        [{"answer": a, "weight": n} for a, n in S["top_shared_accounts"] if n >= 3])
    if S.get("krillion_scores"):
        add("krillion-posters", "Name someone who posts their Krillion score", "games",
            [{"answer": clean_name(p), "weight": n, "aliases": person_aliases(p, people), "quip": f"avg {avg}, best {best}"} for p, n, avg, best in S["krillion_scores"]])
    poll_opts = [(o, n) for o, n in S["poll_votes"] if len(o) <= 40]
    add("poll-votes", "Name an option someone voted for in a poll", "system",
        merge_by_key([{"answer": o, "weight": n} for o, n in poll_opts], keyfn=normalize), review=True)

    for p in P:
        p["clashes"] = check_unambiguous(p)
        if not p["clashes"]: p.pop("clashes")
    return P


def S_msgs(S, p):
    return dict(S["messages_per_person"]).get(p, 0)


def place_aliases(p):
    m = re.match(r"^(.*?) \((.*)\)$", p)
    al = [m.group(1), m.group(2)] if m else []
    return [a for a in al if a]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("chat"); ap.add_argument("stats"); ap.add_argument("-o", "--out", default="prompt_bank.json")
    a = ap.parse_args()
    chat = json.load(open(a.chat, encoding="utf-8")); S = json.load(open(a.stats, encoding="utf-8"))
    prompts = build(chat, S)
    bank = {"version": 1, "source": chat["meta"].get("title"),
            "tiers": {"plankton": 10, "tooclever": 15, "schooler": 30, "rare": 60, "deepcut": 85, "krillion": 100},
            "prompts": prompts}
    json.dump(bank, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(prompts)} prompts -> {a.out}")
    for p in prompts:
        tiers = Counter(x["tier"] for x in p["answers"])
        flag = " [review]" if p.get("review") else ""
        clash = f"  CLASH: {p['clashes'][:2]}" if p.get("clashes") else ""
        print(f"- {p['id']}: {p['text']} ({len(p['answers'])} answers; {dict(tiers)}){flag}{clash}")


if __name__ == "__main__":
    main()
