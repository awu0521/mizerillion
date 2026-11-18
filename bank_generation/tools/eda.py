#!/usr/bin/env python3
"""
eda.py: explore the converted group chat (chat.json) and write a report, charts and a stats file.

Usage:
    python eda.py chat.json -o eda_out

Outputs (in eda_out/):
    report.md    readable findings
    stats.json   every table used in the report (the question generator reads this)
    *.png        charts
Requires: pip install matplotlib
"""
import argparse, json, math, os, re, sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta

EXCLUDE = {"Instagram User", "Meta AI"}          # not real people for stats
CORE_MIN_MESSAGES = 1000                          # "regulars" for per-person tables

BLUE = "#2a78d6"; INK = "#0b0b0b"; INK2 = "#52514e"; GRID = "#e4e3df"; SURFACE = "#fcfcfb"

STOP = set("""a an the and or but if so of to in on at for with from by as is am are was were be been being it its it's i i'm im me my
you u your ur you're youre we us our they them their he him his she her this that these those there here what who whom which when where why how
do does did done dont don't doesnt didnt not no yes ya ye yea yeah ok okay oh just like can cant can't could would should will wont won't
get got go going gonna have has had havent i'd id i'll ill ive i've also too then than now all any some more most one up out about into over
very really still even only much many lmao lmfao haha hahaha bro wait thats that's what's whats theres there's let lets let's want know
think see say said make made take time back off because cause cuz bc rn tho though ig idk wtf yo hey oo ooh omg nah na ye yeh yep thing things
well good way need right sure guys people day today tmr tn also again don't didn't doesn't isn't can't won't i'll it's that's he's she's
they're there's what's you're i've we're wasn't aren't couldn't wouldn't shouldn't haven't let's ain't y'all""".split())
LAUGHS = {
    "lol": r"\blo+l+\b", "lmao": r"\blmf?a+o+\b", "haha": r"\b(?:ha){2,}h?\b", "hehe": r"\b(?:he){2,}\b",
    "LMAO (caps)": r"\bLMF?A+O+\b", "😭": "😭", "💀": "💀", "😂": "😂", "ahaha": r"\ba(?:ha){2,}\b",
    "bahaha": r"\bba(?:ha)+\b", "xd": r"\bxd+\b", "ded": r"\bdea?d\b",
}
EMOJI_RX = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF]\ufe0f?")
WORD_RX = re.compile(r"[a-z][a-z']+")
URL_RX = re.compile(r"(?:https?://|www\.)\S+|\b[\w.-]+\.(?:com|ca|net|org|io|be|gg|ly|me|tv)(?:/\S*)?")


def link_site(u):
    """vt.tiktok.com/abc -> tiktok"""
    host = re.sub(r"^(?:https?://)?(?:www\.)?", "", u).split("/")[0].split("?")[0]
    parts = [x for x in host.split(".") if x]
    return parts[-2] if len(parts) >= 2 else host


def load(path):
    d = json.load(open(path, encoding="utf-8"))
    for m in d["messages"]:
        m["_dt"] = datetime.fromisoformat(m["ts"]) if m.get("ts") else None
    return d


def short(name):
    return re.sub(r"\s*[^\x00-\x7F]+\s*$", "", name).strip() or name


def fmt_table(rows, headers):
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    for r in rows:
        out.append("| " + " | ".join(str(x).replace("|", "\\|").replace("\n", " ") for x in r) + " |")
    return "\n".join(out)


# ------------------------------------------------------------------ charts
def setup_mpl():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "axes.edgecolor": GRID,
                         "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2, "text.color": INK,
                         "font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
                         "axes.titleweight": "bold", "axes.titlesize": 12, "axes.titlelocation": "left"})
    return plt


def hbar(plt, labels, values, title, path, xlabel="", fmt="{:,.0f}"):
    h = max(2.5, 0.32 * len(labels) + 1)
    fig, ax = plt.subplots(figsize=(8, h))
    y = range(len(labels))[::-1]
    ax.barh(list(y), values, color=BLUE, height=0.62)
    ax.set_yticks(list(y)); ax.set_yticklabels(labels)
    ax.xaxis.grid(True, color=GRID, linewidth=0.8); ax.set_axisbelow(True)
    ax.spines["left"].set_visible(False); ax.tick_params(axis="y", length=0)
    vmax = max(values) if values else 1
    for yi, v in zip(y, values):
        ax.text(v + vmax * 0.01, yi, fmt.format(v), va="center", fontsize=8, color=INK2)
    ax.set_xlim(0, vmax * 1.12); ax.set_title(title); ax.set_xlabel(xlabel)
    fig.tight_layout(); fig.savefig(path, dpi=150); plt.close(fig)


def line(plt, xs, ys, title, path, ylabel=""):
    fig, ax = plt.subplots(figsize=(9, 3.4))
    ax.plot(xs, ys, color=BLUE, linewidth=2)
    ax.fill_between(xs, ys, color=BLUE, alpha=0.08)
    ax.yaxis.grid(True, color=GRID, linewidth=0.8); ax.set_axisbelow(True)
    ax.set_title(title); ax.set_ylabel(ylabel)
    fig.autofmt_xdate(); fig.tight_layout(); fig.savefig(path, dpi=150); plt.close(fig)


def heatmap(plt, grid, title, path):
    import numpy as np
    from matplotlib.colors import LinearSegmentedColormap
    cmap = LinearSegmentedColormap.from_list("blues", ["#f2f6fc", "#9cc0ee", BLUE, "#123f78"])
    fig, ax = plt.subplots(figsize=(9, 3.2))
    ax.imshow(np.array(grid), aspect="auto", cmap=cmap)
    ax.set_yticks(range(7)); ax.set_yticklabels(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
    ax.set_xticks(range(0, 24, 2)); ax.set_xticklabels([f"{h:02d}" for h in range(0, 24, 2)])
    ax.set_xlabel("hour of day (export local time)"); ax.set_title(title)
    for s in ax.spines.values(): s.set_visible(False)
    fig.tight_layout(); fig.savefig(path, dpi=150); plt.close(fig)


# ------------------------------------------------------------------ analysis
def analyse(d):
    msgs = d["messages"]
    people_msgs = [m for m in msgs if m["sender"] not in EXCLUDE]
    user = [m for m in people_msgs if m["type"] != "system"]
    texts = [m for m in user if m.get("text")]
    S = {"meta": {k: v for k, v in d["meta"].items() if k != "header"}}

    # --- overview
    sent = Counter(m["sender"] for m in user)
    S["messages_per_person"] = sent.most_common()
    regulars = [p for p, n in sent.items() if n >= CORE_MIN_MESSAGES]
    S["regulars"] = sorted(regulars, key=lambda p: -sent[p])
    S["types"] = Counter(m["type"] for m in msgs).most_common()
    first_seen, last_seen = {}, {}
    for m in user:
        first_seen.setdefault(m["sender"], m["ts"]); last_seen[m["sender"]] = m["ts"]
    S["first_last_seen"] = {p: [first_seen[p], last_seen[p]] for p in sent}
    month = Counter(m["_dt"].strftime("%Y-%m") for m in user if m["_dt"])
    S["per_month"] = sorted(month.items())
    day = Counter(m["_dt"].date().isoformat() for m in user if m["_dt"])
    S["busiest_days"] = day.most_common(15)
    S["active_days"] = len(day)
    grid = [[0] * 24 for _ in range(7)]
    for m in user:
        if m["_dt"]:
            grid[m["_dt"].weekday()][m["_dt"].hour] += 1
    S["weekday_hour"] = grid
    night = Counter(m["sender"] for m in user if m["_dt"] and 1 <= m["_dt"].hour < 5)
    S["night_owls_1am_5am"] = [(p, n, round(n / sent[p] * 100, 1)) for p, n in night.most_common() if p in regulars]
    morning = Counter(m["sender"] for m in user if m["_dt"] and 5 <= m["_dt"].hour < 9)
    S["early_birds_5am_9am"] = [(p, n, round(n / sent[p] * 100, 1)) for p, n in morning.most_common() if p in regulars]

    # --- media
    media = defaultdict(Counter)
    for m in user:
        for a in m.get("attachments", []):
            media[a["kind"]][m["sender"]] += 1
        if m["type"] == "share":
            media["share"][m["sender"]] += 1
    S["media_by_person"] = {k: v.most_common() for k, v in media.items()}
    owners = Counter(m["share"]["owner"] for m in user if m.get("share", {}).get("owner") and "giphy" not in (m["share"].get("url") or ""))
    S["top_shared_accounts"] = owners.most_common(30)
    dom = Counter()
    for m in user:
        for u in (m.get("links") or []) + ([m["share"]["url"]] if m.get("share", {}).get("url") else []):
            mm = re.match(r"https?://(?:www\.)?([^/]+)", u or "")
            if mm: dom[mm.group(1)] += 1
    S["top_link_domains"] = dom.most_common(20)

    # --- likes & reactions
    given, received = Counter(), Counter()
    pairs = Counter(); like_emoji = Counter(); per_person_like_emoji = defaultdict(Counter)
    react_emoji = Counter(); react_by = defaultdict(Counter); react_to = defaultdict(Counter)
    personal_monthly = defaultdict(Counter)
    for m in user:
        for l in m.get("likes", []):
            if l["by"] in EXCLUDE: continue
            given[l["by"]] += 1; received[m["sender"]] += 1; pairs[(l["by"], m["sender"])] += 1
            like_emoji[l["emoji"]] += 1; per_person_like_emoji[l["by"]][l["emoji"]] += 1
            if l["emoji"] != "❤" and m["_dt"]:
                personal_monthly[l["by"]][m["_dt"].strftime("%Y-%m")] += 1
        for r in m.get("reactions", []):
            if r["by"] in EXCLUDE: continue
            e = r["emoji"] or "(sticker)"
            react_emoji[e] += 1; react_by[r["by"]][e] += 1; react_to[m["sender"]][e] += 1
    S["likes_total"] = sum(given.values())
    S["like_emoji_counts"] = like_emoji.most_common()
    S["likes_given"] = [(p, n, round(n / max(1, sum(sent.values()) - sent[p]) * 100, 1)) for p, n in given.most_common()]
    S["likes_received"] = [(p, n, round(n / max(1, sent[p]), 2)) for p, n in received.most_common()]
    S["top_like_pairs"] = [(a, b, n) for (a, b), n in pairs.most_common(25)]
    S["personal_like_emoji_use"] = {p: dict(c) for p, c in per_person_like_emoji.items() if len(c) > 1}
    S["personal_like_emoji_by_month"] = {p: sorted(c.items()) for p, c in personal_monthly.items()}
    S["reactions_total"] = sum(react_emoji.values())
    S["reaction_emojis"] = react_emoji.most_common(40)
    S["reaction_emojis_by_person"] = {p: c.most_common(8) for p, c in react_by.items()}
    S["reaction_emojis_received"] = {p: c.most_common(5) for p, c in react_to.items()}
    # everyone's own top non-like reactions (to spot like emojis we might be missing)
    S["possible_unlisted_like_emojis"] = [(p, c.most_common(1)[0]) for p, c in react_by.items()
                                          if c and c.most_common(1)[0][1] >= 100]
    # most-liked messages
    def score(m): return len(m.get("likes", [])) + len(m.get("reactions", []))
    ranked = sorted([m for m in user if m.get("likes") or m.get("reactions")], key=score, reverse=True)
    S["most_reacted_messages"] = [{"sender": m["sender"], "ts": m["ts"], "type": m["type"], "text": m.get("text") or (m.get("share") or {}).get("caption") or "",
                                   "likes": len(m.get("likes", [])), "reactions": len(m.get("reactions", [])), "source": m["source"]}
                                  for m in ranked[:40]]
    S["most_liked_text_by_person"] = {}
    for p in regulars:
        best = sorted([m for m in texts if m["sender"] == p and len(m["text"]) >= 6], key=lambda m: len(m.get("likes", [])), reverse=True)[:5]
        S["most_liked_text_by_person"][p] = [(m["text"][:200], len(m.get("likes", []))) for m in best]
    most_skull = Counter()
    for m in user:
        for r in m.get("reactions", []):
            if r["emoji"] in ("😭", "💀", "😂"): most_skull[m["sender"]] += 1
    S["funniest_by_laugh_reactions"] = most_skull.most_common()

    # --- system notifications
    sysm = [m for m in msgs if m["type"] == "system"]
    S["system_counts"] = Counter(m["system"]["kind"] for m in sysm).most_common()
    renames = [m for m in sysm if m["system"]["kind"] == "group_rename"]
    names = []
    end = msgs[-1]["_dt"]
    for i, m in enumerate(renames):
        nxt = renames[i + 1]["_dt"] if i + 1 < len(renames) else end
        names.append({"name": m["system"]["name"], "set_by": m["sender"], "from": m["ts"],
                      "days": round((nxt - m["_dt"]).total_seconds() / 86400, 1)})
    S["group_names"] = names
    gn = defaultdict(lambda: {"days": 0.0, "times": 0, "set_by": []})
    for n in names:
        key = n["name"]; gn[key]["days"] += n["days"]; gn[key]["times"] += 1; gn[key]["set_by"].append(n["set_by"])
    S["group_names_total"] = sorted(([k, round(v["days"], 1), v["times"], sorted(set(v["set_by"]))] for k, v in gn.items()), key=lambda x: -x[1])
    S["group_renamers"] = Counter(n["set_by"] for n in names).most_common()
    S["current_title"] = d["meta"].get("title")

    nick = [m for m in sysm if m["system"]["kind"] == "nickname"]
    unames = {u: p["display_name"] for p in d["people"] for u in p["usernames"]}
    nick_rows = []
    for m in nick:
        tgt = m["system"].get("target") or m["sender"]   # "their own nickname" -> the actor
        if m["system"].get("target") is None and "your nickname" in m["text"]:
            tgt = d["meta"].get("exporter")
        nick_rows.append({"target": tgt, "nickname": m["system"]["nick"], "set_by": m["sender"], "ts": m["ts"]})
    S["nicknames"] = nick_rows
    byt = defaultdict(list)
    for r in nick_rows: byt[r["target"]].append(r["nickname"])
    S["nicknames_by_person"] = {k: v for k, v in sorted(byt.items(), key=lambda x: -len(x[1]))}
    S["themes"] = [(m["ts"][:10], m["sender"], m["system"]["theme"]) for m in sysm if m["system"]["kind"] == "theme"]
    S["polls"] = [(m["ts"][:10], m["sender"], m["system"]["question"]) for m in sysm if m["system"]["kind"] == "poll_created"]
    S["poll_votes"] = Counter(m["system"]["option"] for m in sysm if m["system"]["kind"] == "poll_vote").most_common(30)
    S["calls_started"] = Counter(m["sender"] for m in sysm if m["system"]["kind"] == "call_started").most_common()
    S["membership"] = [(m["ts"][:10], m["text"]) for m in sysm if m["system"]["kind"] in ("member_added", "member_removed", "member_left")]

    # like notifications: do they duplicate likes already on the exporter's messages?
    ln = Counter(m["sender"] for m in sysm if m["system"]["kind"] == "like_notification")
    exp = d["meta"].get("exporter")
    likes_on_exp = Counter(l["by"] for m in user if m["sender"] == exp for l in m.get("likes", []))
    S["like_notifications_vs_likes_on_exporter"] = [(p, n, likes_on_exp.get(p, 0)) for p, n in ln.most_common()]
    rn = Counter((m["sender"], m["system"]["emoji"]) for m in sysm if m["system"]["kind"] == "reaction_notification")
    S["reaction_notifications"] = [(p, e, n) for (p, e), n in rn.most_common(40)]

    # --- text
    words_by = defaultdict(Counter); total_words = Counter(); msg_len = defaultdict(list)
    laugh = defaultdict(Counter); emoji_by = defaultdict(Counter); caps = Counter(); q = Counter()
    bigram_by = defaultdict(Counter)
    for m in texts:
        t = m["text"]; p = m["sender"]
        if re.match(r"^(Wordle|Krillion|Feetle|Connections|Strands|Costcodle|Framed|#Worldle)", t):
            continue
        low = t.lower().replace("’", "'")
        links = URL_RX.findall(low)
        low = URL_RX.sub(" ", low)                    # a link is not words: count it once, as "<site> link"
        for u in links:
            bigram_by[p][f"{link_site(u)} link"] += 1
        ws = WORD_RX.findall(low)
        msg_len[p].append(len(ws))
        for w in ws:
            words_by[p][w] += 1; total_words[w] += 1
        content = [w for w in ws if w not in STOP and len(w) > 2]
        for a, b in zip(content, content[1:]):
            bigram_by[p][f"{a} {b}"] += 1
        for k, rx in LAUGHS.items():
            n = len(re.findall(rx, t if k == "LMAO (caps)" else low))
            if n: laugh[p][k] += n
        for e in EMOJI_RX.findall(t):
            emoji_by[p][e.replace("\ufe0f", "")] += 1
        if len(t) > 6 and t.upper() == t and re.search("[A-Z]", t): caps[p] += 1
        if t.rstrip().endswith("?"): q[p] += 1
    S["avg_words_per_message"] = sorted([(p, round(sum(v) / len(v), 2)) for p, v in msg_len.items() if p in regulars], key=lambda x: -x[1])
    S["all_caps_messages"] = sorted([(p, n, round(n / sent[p] * 100, 1)) for p, n in caps.items() if p in regulars], key=lambda x: -x[2])
    S["questions_asked"] = sorted([(p, n, round(n / sent[p] * 100, 1)) for p, n in q.items() if p in regulars], key=lambda x: -x[2])
    S["top_words"] = [(w, n) for w, n in total_words.most_common(400) if w not in STOP][:60]
    allw = sum(total_words.values())
    distinct = {}
    for p in regulars:
        c = words_by[p]; n_p = sum(c.values()); rest = allw - n_p
        rows = []
        for w, k in c.items():
            if k < 15 or w in STOP or len(w) < 3: continue
            other = total_words[w] - k
            # log-odds ratio with informative Dirichlet prior
            a0 = 0.01 * allw; aw = 0.01 * total_words[w]
            lo = math.log((k + aw) / (n_p + a0 - k - aw)) - math.log((other + aw) / (rest + a0 - other - aw))
            var = 1 / (k + aw) + 1 / (other + aw)
            rows.append((w, k, round(lo / math.sqrt(var), 2)))
        distinct[p] = [r[:2] for r in sorted(rows, key=lambda x: -x[2])[:15]]
    S["distinctive_words"] = distinct
    S["top_phrases_by_person"] = {p: [x for x in bigram_by[p].most_common(40) if x[1] >= 8][:12] for p in regulars}
    S["laugh_styles"] = {p: laugh[p].most_common(6) for p in regulars}
    S["laugh_totals"] = Counter({k: sum(laugh[p][k] for p in laugh) for k in LAUGHS}).most_common()
    S["text_emoji_totals"] = sum((emoji_by[p] for p in emoji_by), Counter()).most_common(40)
    S["text_emoji_by_person"] = {p: emoji_by[p].most_common(8) for p in regulars}
    # names of members said in chat
    first_names = {short(p).split()[0].lower(): p for p in regulars}
    first_names.update({"dax": "Daxton", "jon": "Jonathan Ko", "veronica": "V", "roy": "Roy zheng"})
    mention = Counter()
    for w, n in total_words.items():
        if w in first_names: mention[first_names[w]] += n
    S["name_mentions"] = mention.most_common()
    at = Counter()
    for m in texts:
        for u in re.findall(r"@([\w.]+)", m["text"]): at[unames.get(u, u)] += 1
    S["at_mentions"] = at.most_common(20)

    # --- daily games
    games = defaultdict(lambda: defaultdict(list))
    for m in texts:
        t = m["text"]
        g = re.match(r"^Krillion #(\d+)\D*?\n\s*(\d+)", t)
        if g: games["Krillion"][m["sender"]].append(int(g.group(2))); continue
        g = re.match(r"^Wordle ([\d,]+) ([1-6X])/6", t)
        if g: games["Wordle"][m["sender"]].append(7 if g.group(2) == "X" else int(g.group(2))); continue
        g = re.match(r"^Feetle #(\d+) ([\dX])/(\d)", t)
        if g: games["Feetle"][m["sender"]].append(7 if g.group(2) == "X" else int(g.group(2))); continue
        g = re.match(r"^(Connections|Strands|Costcodle|Framed|Worldle|#Worldle|Bandle|Pokedoku|Spotle)\b", t)
        if g: games[g.group(1).lstrip("#")][m["sender"]].append(1)
    S["games_posted"] = {g: sorted(((p, len(v)) for p, v in d_.items()), key=lambda x: -x[1]) for g, d_ in games.items()}
    S["krillion_scores"] = sorted(((p, len(v), round(sum(v) / len(v)), max(v)) for p, v in games["Krillion"].items()), key=lambda x: -x[2])
    S["wordle_avg"] = sorted(((p, len(v), round(sum(v) / len(v), 2)) for p, v in games["Wordle"].items() if len(v) >= 5), key=lambda x: x[2])

    # --- streaks: longest run of consecutive messages by one person
    best = {}
    run_p, run_n = None, 0
    for m in user:
        if m["sender"] == run_p: run_n += 1
        else: run_p, run_n = m["sender"], 1
        if run_n > best.get(run_p, 0): best[run_p] = run_n
    S["longest_solo_runs"] = sorted(((p, n) for p, n in best.items() if p in regulars), key=lambda x: -x[1])
    # who revives the chat after 6h+ silence
    rev = Counter(); prev = None
    for m in user:
        if prev and m["_dt"] and prev["_dt"] and m["_dt"] - prev["_dt"] > timedelta(hours=6): rev[m["sender"]] += 1
        prev = m
    S["chat_revivers_after_6h"] = rev.most_common()
    return S


# ------------------------------------------------------------------ report
def write_report(S, out, plt):
    P = lambda name: os.path.join(out, name)
    R = S["regulars"]
    hbar(plt, [short(p) for p, _ in S["messages_per_person"][:20]], [n for _, n in S["messages_per_person"][:20]],
         "Messages sent per person", P("messages_per_person.png"))
    from datetime import date
    xs = [datetime.strptime(k, "%Y-%m") for k, _ in S["per_month"]]; ys = [v for _, v in S["per_month"]]
    line(plt, xs, ys, "Messages per month", P("messages_per_month.png"), "messages")
    heatmap(plt, S["weekday_hour"], "When the chat is active", P("weekday_hour.png"))
    lg = S["likes_given"][:16]
    hbar(plt, [short(p) for p, *_ in lg], [n for _, n, _ in lg], "Likes given (❤ + personal like emoji)".replace("❤ ", ""), P("likes_given.png"))
    lr = S["likes_received"][:16]
    hbar(plt, [short(p) for p, *_ in lr], [n for _, n, _ in lr], "Likes received", P("likes_received.png"))
    gn = S["group_names_total"][:20]
    hbar(plt, [re.sub(r"[^\x00-\x7F’]", "", n)[:40] for n, *_ in gn], [d for _, d, *_ in gn], "Days each group name was in use", P("group_names_days.png"), "days", "{:,.1f}")
    if S["krillion_scores"]:
        ks = S["krillion_scores"]
        hbar(plt, [f"{short(p)} ({n})" for p, n, *_ in ks], [a for _, _, a, _ in ks], "Average posted Krillion score (dives posted)", P("krillion_scores.png"))

    L = []
    m = S["meta"]
    L.append(f"# {m.get('title')}: group chat exploration\n")
    L.append(f"{m['message_count']:,} entries from {m['first_ts'][:10]} to {m['last_ts'][:10]}, exported by {m.get('exporter')} "
             f"({m['pages']} pages). Active on {S['active_days']} days. Instagram User and Meta AI are excluded from per-person stats.\n")
    L.append("Entry types: " + ", ".join(f"{k} {v:,}" for k, v in S["types"]) + "\n")
    L.append("![](messages_per_person.png)\n![](messages_per_month.png)\n![](weekday_hour.png)\n")
    L.append("## Busiest days\n" + fmt_table(S["busiest_days"][:10], ["day", "messages"]) + "\n")
    L.append("## Night owls (1–5 am) and early birds (5–9 am)\n" + fmt_table(S["night_owls_1am_5am"][:8], ["person", "msgs", "% of theirs"]) + "\n\n"
             + fmt_table(S["early_birds_5am_9am"][:8], ["person", "msgs", "% of theirs"]) + "\n")
    L.append("## Group names\n" + f"Current name: **{S['current_title']}**. {len(S['group_names'])} renames in the export.\n\n"
             + fmt_table([(n['from'][:10], n['name'], n['set_by'], n['days']) for n in S["group_names"]], ["from", "name", "set by", "days"]) + "\n\n"
             + "Who renames the chat most: " + ", ".join(f"{p} ({n})" for p, n in S["group_renamers"]) + "\n\n![](group_names_days.png)\n")
    L.append("## Nicknames\n" + "\n".join(f"- **{p}**: " + "; ".join(v) for p, v in S["nicknames_by_person"].items()) + "\n")
    L.append("## Chat themes\n" + fmt_table(S["themes"], ["date", "set by", "theme"]) + "\n")
    L.append("## Polls\n" + fmt_table(S["polls"], ["date", "by", "question"]) + "\n")
    L.append("## Membership changes\n" + "\n".join(f"- {a}: {b}" for a, b in S["membership"]) + "\n")
    L.append(f"## Likes ({S['likes_total']:,})\n" + "Like emojis used: " + ", ".join(f"{e} {n:,}" for e, n in S["like_emoji_counts"]) + "\n\n"
             + fmt_table(S["likes_given"][:16], ["person", "likes given", "% of others' msgs"]) + "\n\n"
             + fmt_table(S["likes_received"][:16], ["person", "likes received", "per message"]) + "\n\n"
             + fmt_table(S["top_like_pairs"][:15], ["liker", "liked", "likes"]) + "\n\n![](likes_given.png)\n![](likes_received.png)\n")
    L.append("Personal like emoji vs ❤ per person: " + "; ".join(f"{p}: " + ", ".join(f"{e} {n:,}" for e, n in c.items()) for p, c in S["personal_like_emoji_use"].items()) + "\n")
    L.append("\nMonths each person used their personal like emoji (first → last): " + "; ".join(
        f"{p}: {v[0][0]} → {v[-1][0]}" for p, v in S["personal_like_emoji_by_month"].items() if v) + "\n")
    L.append(f"## Other reactions ({S['reactions_total']:,})\n" + ", ".join(f"{e} {n}" for e, n in S["reaction_emojis"][:25]) + "\n\n"
             + "\n".join(f"- **{p}** reacts with: " + " ".join(f"{e}{n}" for e, n in c) for p, c in S["reaction_emojis_by_person"].items() if p in R) + "\n")
    L.append("\nPeople whose top non-like reaction is used 100+ times (check if it's really a like emoji): "
             + ", ".join(f"{p} {e} ({n})" for p, (e, n) in S["possible_unlisted_like_emojis"]) + "\n")
    L.append("\n### \"X liked a message\" notifications vs likes on the exporter's messages\n"
             + fmt_table(S["like_notifications_vs_likes_on_exporter"][:15], ["person", "notifications", f"likes on {m.get('exporter')}'s msgs"]) + "\n")
    L.append("\n## Most-reacted messages\n" + fmt_table([(x["sender"], x["ts"][:10], (x["text"] or f"[{x['type']}]")[:90], x["likes"], x["reactions"]) for x in S["most_reacted_messages"][:25]],
                                                    ["sender", "date", "message", "likes", "reactions"]) + "\n")
    L.append("\n## Funniest (most 😭/💀/😂 reactions received)\n" + ", ".join(f"{p} {n}" for p, n in S["funniest_by_laugh_reactions"][:12]) + "\n")
    L.append("\n## How people talk\n" + fmt_table(S["avg_words_per_message"], ["person", "avg words/msg"]) + "\n\n"
             + "ALL CAPS messages: " + ", ".join(f"{p} {pct}%" for p, n, pct in S["all_caps_messages"][:8]) + "\n\n"
             + "Questions asked: " + ", ".join(f"{p} {pct}%" for p, n, pct in S["questions_asked"][:8]) + "\n\n"
             + "Laugh styles overall: " + ", ".join(f"{k} {n:,}" for k, n in S["laugh_totals"] if n) + "\n\n"
             + "\n".join(f"- **{p}**: " + ", ".join(f"{k} {n}" for k, n in S["laugh_styles"][p]) for p in R) + "\n")
    L.append("\n### Distinctive words (log-odds vs everyone else)\n" + "\n".join(f"- **{p}**: " + ", ".join(w for w, _ in S["distinctive_words"][p]) for p in R) + "\n")
    L.append("\n### Repeated phrases\n" + "\n".join(f"- **{p}**: " + ", ".join(f"{b} ({n})" for b, n in S["top_phrases_by_person"][p]) for p in R if S["top_phrases_by_person"][p]) + "\n")
    L.append("\n### Top words overall\n" + ", ".join(f"{w} {n:,}" for w, n in S["top_words"][:50]) + "\n")
    L.append("\n### Emojis in messages\n" + " ".join(f"{e}{n}" for e, n in S["text_emoji_totals"][:30]) + "\n\n"
             + "\n".join(f"- **{p}**: " + " ".join(f"{e}{n}" for e, n in S["text_emoji_by_person"][p]) for p in R) + "\n")
    L.append("\n## Who gets talked about\nName said in chat: " + ", ".join(f"{p} {n:,}" for p, n in S["name_mentions"]) + "\n\n@-mentions: " + ", ".join(f"{p} {n}" for p, n in S["at_mentions"][:12]) + "\n")
    L.append("\n## Daily games posted\n" + "\n".join(f"- **{g}**: " + ", ".join(f"{p} {n}" for p, n in v[:8]) for g, v in S["games_posted"].items()) + "\n")
    if S["krillion_scores"]:
        L.append("\n" + fmt_table(S["krillion_scores"], ["person", "dives posted", "avg score", "best"]) + "\n\n![](krillion_scores.png)\n")
    if S["wordle_avg"]:
        L.append("\nWordle average guesses (X counted as 7): " + ", ".join(f"{p} {a} ({n})" for p, n, a in S["wordle_avg"]) + "\n")
    L.append("\n## Media and links\n" + "\n".join(f"- **{k}**: " + ", ".join(f"{p} {n}" for p, n in v[:6]) for k, v in S["media_by_person"].items()) + "\n\n"
             + "Most shared accounts: " + ", ".join(f"{a} {n}" for a, n in S["top_shared_accounts"][:20]) + "\n\n"
             + "Link domains: " + ", ".join(f"{a} {n}" for a, n in S["top_link_domains"][:15]) + "\n")
    L.append("\n## Chat habits\nLongest solo message run: " + ", ".join(f"{p} {n}" for p, n in S["longest_solo_runs"][:10]) + "\n\n"
             + "Revives the chat after 6h+ of silence: " + ", ".join(f"{p} {n}" for p, n in S["chat_revivers_after_6h"][:10]) + "\n\n"
             + "Calls started: " + ", ".join(f"{p} {n}" for p, n in S["calls_started"]) + "\n")
    open(P("report.md"), "w", encoding="utf-8").write("\n".join(L))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("chat", nargs="?", default="chat.json")
    ap.add_argument("-o", "--out", default="eda_out")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    d = load(a.chat)
    S = analyse(d)
    json.dump(S, open(os.path.join(a.out, "stats.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
    write_report(S, a.out, setup_mpl())
    print("wrote", a.out)


if __name__ == "__main__":
    main()
