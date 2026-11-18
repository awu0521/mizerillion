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
    "🤯": ["exploding head", "mind blown"], "🖕": ["middle finger", "the finger"], "🥰": ["hearts face", "in love", "smiling hearts"],
    "😮": ["open mouth", "surprised", "wow"], "🙋‍♀": ["raising hand", "hand raised", "woman raising hand"],
    "🟣": ["purple circle", "purple"], "🙄": ["eye roll", "rolling eyes"], "🫶": ["heart hands"], "🫩": ["tired", "eye bags"],
    "😩": ["weary"], "😝": ["squinting tongue", "squinty tongue"], "😛": ["tongue out"], "🤩": ["star eyes", "starstruck"],
    "😁": ["beaming", "grinning"], "🤤": ["drool"], "😨": ["scared"], "🍅": ["tomato"], "🦉": ["owl"],
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
# Hand-picked extra spellings, applied to any answer in any prompt whose normalized text matches the key.
# Keys and values are compared with normalize(), so case/punctuation/spaces don't matter.
EXTRA_ALIASES = {
    # places
    "McDonald's": ["mcd", "mcds", "mickey ds", "maccas"], "Tim Hortons": ["timmies", "tims", "tim hortons"],
    "Starbucks": ["sbux", "starbs"], "The gym / ARC": ["ubc gym", "arc gym"], "Metrotown": ["metro"],
    "Abbotsford": ["abby"], "Coquitlam": ["coq", "coquitlam centre"], "Buchanan": ["buch"], "SFU": ["simon fraser"],
    "Orchard Commons (OC)": ["orchard"], "Life Building": ["life", "the life building"], "Vegas": ["las vegas"],
    "Cactus Club": ["cactus"], "Big Way": ["big way hot pot", "bigway hotpot"], "Wesbrook": ["westbrook", "wesbrook village"],
    "Kitsilano (Kits)": ["kits beach"], "Uncle Fatih's": ["uncle fatihs pizza", "fatihs"], "Panda Express": ["panda"],
    "Hong Kong": ["hk"], "Philippines": ["the philippines"], "Nest": ["the nest", "ams nest"],
    # daily games
    "Connections": ["nyt connections"], "Strands": ["nyt strands"], "Rule34dle": ["rule 34dle", "rule34 dle"],
    "Minute Cryptic": ["minutecryptic", "cryptic"], "Royaledle": ["clash royale dle"], "Krillion": ["openkrillion"],
    # themes
    "THE TORTURED POETS DEPARTMENT": ["ttpd", "tortured poets department", "tortured poets"],
    "HIT ME HARD AND SOFT": ["hmhas", "hit me hard"], "super smash bros ultimate": ["smash bros", "smash", "ssbu", "smash ultimate"],
    "Tron: Ares": ["tron"], "Year of the Snake": ["snake"], "Lo-Fi": ["lofi", "lo fi"], "j-hope": ["jhope", "hobi"],
    "Murphy the Dog": ["murphy"], "House of the Dragon": ["hotd"], "Sabrina Carpenter": ["sabrina"], "Taylor Swift": ["taylor", "tswift"],
    "Benson Boone": ["benson"], "Squid Game": ["squid"], "Cats": ["cat"], "Paralympics": ["paralympic"],
    "Olympics": ["olympic", "the olympics"], "Can't Rush Greatness": ["cant rush greatness", "crg"],
    # group names
    "____’s Dark Desires": ["blanks dark desires", "blank dark desires", "s dark desires"],
    # slang/abbreviations people type out in full (shown as a correction, still counts)
    "ppl": ["people"], "abt": ["about"], "smt": ["something", "smth"], "tdy": ["today"], "gna": ["gonna"],
    "ima": ["imma", "i'ma"], "prolly": ["probably", "probs"], "ngl": ["not gonna lie"], "gng": ["gang"],
    "lowk": ["lowkey"], "lowkey": ["low key", "lk"], "yall": ["y'all", "you all"], "wanna": ["want to"],
    "gotta": ["got to"], "bruh": ["bro"], "lol": ["laugh out loud"], "lmao": ["lmfao"], "idk": ["i dont know"],
    "tbh": ["to be honest"], "rn": ["right now"], "fr": ["for real"], "bday": ["birthday"], "happy bday": ["happy birthday", "hbd"],
}
# Phrase prompt: pairs containing any of these words are link previews or game-result junk, not things people say
PHRASE_NOISE = {"link", "dle", "app", "view", "update", "doodle", "sent", "tries", "mode", "vercel", "par", "rule",
                "minutecryptic", "daily", "google", "reddit", "tiktok", "wxu", "zheng", "wang", "lee", "jon"}
# "Name a website" prompt: domain -> site name + what people would type
SITES = {
    "instagram.com": ("Instagram", ["insta", "ig"]), "tiktok.com": ("TikTok", ["tik tok", "tt"]),
    "giphy.com": ("Giphy", ["gif", "gifs"]), "tenor.co": ("Tenor", ["tenor gif"]), "reddit.com": ("Reddit", []),
    "youtube.com": ("YouTube", ["yt", "youtu be"]), "youtu.be": ("YouTube", []), "goo.gl": ("Google Maps", ["maps", "gmaps"]),
    "docs.google.com": ("Google Docs", ["docs", "google doc", "gdocs"]), "rule34dle.vercel.app": ("Rule34dle", ["rule 34dle"]),
    "royaledle.com": ("Royaledle", []), "globle-game.com": ("Globle", []), "minutecryptic.com": ("Minute Cryptic", ["cryptic"]),
    "duotrigordle.com": ("Duotrigordle", ["duotrigordle"]), "dialed.gg": ("Dialed", ["dialed gg"]),
}
# "Name a swear word": answer -> spellings that count toward it (and are accepted). Slurs stay in BLOCKLIST.
SWEARS = {
    "fuck": ["fucking", "fucked", "fuckin", "fucks", "fck", "fk", "fuk", "fking", "fkn"], "fucker": ["fuckers"],
    "motherfucker": ["motherfuckers", "mf", "mfs", "mofo"], "shit": ["shits", "shitting", "shitted", "sht"],
    "shitty": [], "bullshit": ["bs"], "bitch": ["bitches", "bitching", "bitchy"], "bitchass": ["bitch ass"],
    "damn": ["damnit", "dammit", "damned", "dam"], "goddamn": ["goddamnit", "god damn"], "ass": ["asses"],
    "asshole": ["assholes"], "dumbass": ["dumb ass", "dumbasses"], "jackass": [], "dipshit": [], "shithead": [],
    "smartass": [], "hell": [], "crap": ["crappy"], "dick": ["dicks", "dih"], "dickhead": [], "cock": [],
    "piss": ["pissed", "pissing"], "pussy": ["pussies"], "cunt": [], "bastard": ["bastards"], "whore": [],
    "slut": [], "hoe": ["hoes"], "prick": [], "wtf": ["what the fuck"], "stfu": ["shut the fuck up"],
}
# Long words: minimum letters, and real words /usr/share/dict/web2 doesn't know
LONG_WORD_MIN = 9
# tier by how many times the word was said: (minimum count, tier), first match wins
LONG_WORD_TIERS = [(10, "plankton"), (3, "schooler"), (2, "rare"), (1, "deepcut")]
# hand-picked krillions for the long-word prompt: word -> quip
LONG_WORD_KRILLION = {
    "acromioclavicular": 'Jocelyn said this in this msg: "Tear the acromioclavicular joint elden"',
    "parallelepiped": 'Elden said this in this msg: "what the fuck is a parallelepiped"',
}
LONG_WORD_ALLOW = {"doomscrolling", "screenshotted", "friendsgiving", "rollercoaster", "cybersecurity", "autocorrected",
                   "uncoordinated", "dysfunctional", "decriminalized", "neurodivergent", "recertification",
                   "miscommunication", "aforementioned", "macroeconomics", "microeconomics", "motherfuckers",
                   "bodypositivity", "counterstrafe", "infraspinatus"}
# UBC Vancouver campus food places. Weight = how well known each is online: listed on UBC's own pages
# (visit.ubc.ca food courts, food.ubc.ca Feed Me) and how often student guides recommend it
# (Noms Magazine "Best UBC Restaurants", Daily Hive, UBC student blogs). Checked 2026-11.
UBC_FOOD = [  # (name, weight, aliases, where)
    ("Blue Chip Café", 10, ["blue chip", "bluechip", "blue chip cookies", "bluechip cafe"], "AMS Nest"),
    ("Mercante", 8, ["mercante pizza", "mercante ubc"], "University Blvd"), ("Browns Crafthouse", 7, ["browns", "brown", "browns socialhouse", "browns crafthouse ubc"], "UBC Central"),
    ("Grand Noodle Emporium", 7, ["grand noodle", "gne", "noodle emporium", "grand noodles"], "AMS Nest"), ("McDonald's", 7, [], "University Village"),
    ("Tim Hortons", 7, [], "four on campus"), ("Starbucks", 6, ["starbucks ubc"], "three on campus"),
    ("Pizza Garden", 6, ["pizza garden village"], "University Village"), ("DownLow Chicken Shack", 6, ["downlow", "down low", "dl", "dl chicken", "downlow chicken", "dl chicken shack"], "UBC Central"),
    ("Feast", 6, ["totem", "totem dining", "totem dining hall", "totem cafeteria", "feast totem", "totem park dining"], "Totem Park dining hall"),
    ("Open Kitchen", 6, ["oc", "oc dining", "oc dining hall", "orchard commons", "orchard commons dining", "orchard"], "Orchard Commons dining hall"),
    ("Gather", 5, ["vanier", "vanier dining", "vanier dining hall", "vanier cafeteria"], "Vanier dining hall"),
    ("Honour Roll", 5, ["honor roll", "honour roll sushi", "honor roll sushi"], "AMS Nest"), ("The Delly", 5, ["delly", "deli", "the deli"], "AMS Nest"),
    ("Kinton Ramen", 5, ["kinton"], "UBC Central"), ("Sesame", 4, ["sesame cafe"], "UBC Central"),
    ("My Home Cuisine", 4, ["my home"], "University Village"), ("Uncle Fatih's Pizza", 4, ["uncle fatihs", "fatihs", "uncle fatih", "fatih", "fatihs pizza"], "UBC Central"),
    ("Big Way Hot Pot", 4, ["big way", "bigway", "big way hotpot", "bigway hotpot"], "University Village"), ("Triple O's", 4, ["triple os", "triple o", "triple 0s", "ooo"], "Main Mall"),
    ("Subway", 4, ["subway ubc"], "University Village"), ("Chatime", 3, ["cha time"], "UBC Central"), ("Chipotle", 3, ["chipotle ubc"], "UBC Central"),
    ("Steve's Poké Bar", 3, ["steves poke", "steves", "steve", "steves poke bar", "steve poke"], "UBC Central"), ("Kyros Kitchen", 3, ["kyros"], "AMS Nest"),
    ("Only U Café", 3, ["only u", "only you", "only you cafe"], "University Village"), ("Perch", 3, ["the perch", "perch restaurant"], "AMS Nest"),
    ("Gallery Patio and Lounge", 3, ["the gallery", "gallery", "gallery patio", "gallery lounge", "the gallery patio"], "AMS Nest"), ("Ryuu Japanese Kitchen", 3, ["ryuu"], "University Blvd"),
    ("Jamjar Canteen", 2, ["jamjar", "jam jar"], "University Blvd"), ("Virtuous Pie", 2, ["virtuous", "virtuous pizza"], "Shrum Lane"),
    ("Pearl Fever Tea House", 2, ["pearl fever", "pearl fever tea"], "University Village"), ("A&W", 2, ["a and w", "aw", "a n w", "anw"], "University Village"),
    ("Pita Pit", 2, ["pitapit", "pita"], "University Village"), ("Osmow's Shawarma", 2, ["osmows", "osmow", "osmows shawarma"], "UBC Central"),
    ("JJ Bean", 2, ["jj bean coffee", "jj beans", "jjbean"], "UBC Central"), ("Nori Bento & Udon", 2, ["nori", "nori bento", "nori udon"], "UBC Central"),
    ("Harvest Market", 2, ["harvest", "harvest market ubc"], "Food Services market"), ("Pho Real", 2, ["pho", "pho real ubc"], "Food Services"),
    ("Domino's Pizza", 2, ["dominos", "domino", "dominoes"], "on campus"), ("Booster Juice", 2, ["booster"], "Life Building"),
    ("Presto", 2, ["presto panini"], "Main Mall"), ("Hero Coffee + Market", 2, ["hero coffee", "hero", "hero market", "hero cafe"], "Orchard Commons"),
    ("Sprouts", 2, ["sprouts cafe", "sprout"], "AMS Nest, student-run"), ("IFC", 2, ["international food court", "international", "ifc ubc"], "University Village"), ("Donair Town", 1, ["donair", "donairtown"], "University Village"),
    ("Chirpyhut Fried Chicken", 1, ["chirpyhut", "chirpy hut", "chirpy"], "University Village"), ("Crab Hot Lau", 1, ["crab hotlau", "crab"], "University Village"),
    ("Beyond Plus", 1, ["beyond", "beyond+"], "University Village"), ("Burgers n Fries Forever", 1, ["burgers and fries forever", "bff", "burgers n fries", "burgers and fries", "burger n fries forever"], "University Village"),
    ("Sahel Persian Restaurant", 1, ["sahel", "sahel persian"], "University Village"), ("Body Energy Club", 1, ["bec", "body energy"], "UBC Central"),
    ("Chachi's Sandwiches", 1, ["chachis", "chachi", "chachis sandwich"], "UBC Central"), ("Rain or Shine", 1, ["rain or shine ice cream", "ros", "rain n shine", "rain and shine"], "UBC Central"),
    ("The Soup Market", 1, ["soup market", "soup"], "AMS Nest"), ("Great Dane Coffee", 1, ["great dane", "great dane cafe"], "Food Services"),
    ("Perugia Italian Caffè", 1, ["perugia", "perugia cafe"], "Life Sciences"), ("Stir It Up Café", 1, ["stir it up", "stiritup"], "Food Services"),
    ("TEADOT", 1, ["tea dot", "teadot cafe"], "Food Services"), ("DaBao", 1, ["da bao", "dabao ubc"], "Food Services"),
    ("Pacific Poke", 1, ["pacific poke life"], "Life Building"), ("Gage Market", 1, ["gage", "gage store"], "Gage residence"),
    ("Nicli Pizzeria", 1, ["nicli", "nicli pizza", "nicli antica"], "Wesbrook Village"), ("Doughgirls", 1, ["dough girls", "doughgirl"], "Wesbrook Village"),
    ("Togo Sushi", 1, ["togo", "to go sushi"], "Wesbrook Village"), ("Chef Hung Taiwanese Beef Noodle", 1, ["chef hung", "chef hungs", "chef hung beef noodle"], "Wesbrook Village"),
    ("Freshii", 1, ["freshi", "fresh ii"], "Wesbrook Village"), ("Share Tea", 1, ["sharetea", "share tea ubc"], "Wesbrook Village"),
    ("Big Star Sandwich", 1, ["big star", "big star sandwiches"], "Wesbrook Village"), ("Sports Illustrated Clubhouse", 1, ["sports illustrated", "si clubhouse"], "Wesbrook Village"),
    ("Seoul Hotdog", 0.9, ["seoul hot dog", "seoul hotdogs", "seoul"], "AMS Nest"),
]
FOOD_GENERIC = {"cafe", "caffe", "coffee", "restaurant", "pizza", "pizzeria", "sushi", "kitchen", "ramen", "shawarma",
                "tea", "house", "bar", "market", "hot", "pot", "chicken", "shack", "fried", "sandwich", "sandwiches",
                "canteen", "crafthouse", "cuisine", "emporium", "persian", "taiwanese", "beef", "noodle", "club",
                "clubhouse", "lounge", "patio", "and", "udon", "bento", "poke", "japanese", "the"}


def food_aliases(name):
    """'Pearl Fever Tea House' -> 'pearl fever'; 'The Delly' -> 'delly': drop generic words at the ends."""
    ws = re.sub(r"[^\w\s']", " ", unicodedata.normalize("NFKD", name)).lower().replace("'", "").split()
    ws = [w for w in ws if not unicodedata.combining(w[0])]
    while ws and ws[-1] in FOOD_GENERIC: ws.pop()
    while ws and ws[0] == "the": ws.pop(0)
    core = " ".join(ws)
    return [core] if core and normalize(core) != normalize(name) and len(normalize(core)) >= 3 else []


# Ids never added by --update (prompts you deleted by hand from the bank). Edit freely.
SKIP_PROMPTS = {"big-likers", "most-liked", "talked-about", "accounts", "poll-votes", "photo-senders", "words-avery",
                "question-askers", "video-senders", "websites", "emojis-annie", "emojis-elden", "emojis-luisguevara",
                "emojis-jocelyn", "emojis-v", "emojis-royzheng", "emojis-jonathanko", "emojis-daxton"}
SKIP_PREFIXES = ("words-",)   # deleted the whole "Name a word X says" family
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


def tier_answers(items, krillion=True, limit=MAX_ANSWERS):
    """items: list of dicts with answer, weight. Returns them with tiers set (most common first)."""
    items = [i for i in items if i["weight"] > 0]
    items.sort(key=lambda i: -i["weight"])
    items = items[:limit]
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


EMOJI_RE = re.compile(r"[←-⯿☀-➿\U0001F000-\U0001FAFF️‍]+")
EXTRA = {normalize(k): v for k, v in EXTRA_ALIASES.items()}


def emoji_names(e):
    """Unicode names for a single emoji: 🤧 -> 'sneezing face', 'sneezing'.
    Skips ZWJ sequences (🏳‍🌈 would become 'waving white flag') and pre-emoji symbols below U+1F000,
    whose names mislead (❤ is 'heavy black heart'); give those EMOJI_WORDS by hand."""
    base = [ch for ch in e if ch != "️" and not 0x1F3FB <= ord(ch) <= 0x1F3FF]
    if len(base) != 1 or ord(base[0]) < 0x1F000:
        return []
    try:
        n = unicodedata.name(base[0]).lower()
    except ValueError:
        return []
    out = {n}
    for pre in ("smiling face with ", "face with "):
        if n.startswith(pre): out.add(n[len(pre):])
    for suf in (" face", " symbol", " sign"):
        if n.endswith(suf) and n != suf.strip(): out.add(n[: -len(suf)])
    return [x for x in out if len(x) > 2]


def auto_aliases(answer):
    """Spellings a player is likely to type for an answer, derived from its text."""
    a = answer.replace("’", "'").strip()
    out = set(EXTRA.get(normalize(a), []))
    if normalize(a) and all(not ("a" <= c <= "z" or "0" <= c <= "9") for c in normalize(a)):
        return sorted(out | set(emoji_names(a)) | set(EMOJI_WORDS.get(a, [])))
    no_emoji = EMOJI_RE.sub("", a).strip()
    if no_emoji and no_emoji != a: out.add(no_emoji)                    # "roys toy🌹" -> "roys toy"
    m = re.match(r"^(.*?)\s*\((.+)\)\s*$", no_emoji)
    if m: out |= {m.group(1), m.group(2)}                              # "Kitsilano (Kits)" -> both
    if " / " in no_emoji: out |= {x for x in no_emoji.split(" / ")}     # "The gym / ARC" -> "The gym", "ARC"
    for x in list(out) + [no_emoji]:
        if re.match(r"(?i)^the\s+", x): out.add(re.sub(r"(?i)^the\s+", "", x))   # "The gym" -> "gym"
    for x in list(out) + [no_emoji]:
        squeezed = re.sub(r"([a-zA-Z])\1{2,}", r"\1", x)                  # "ERRRRRRGHHHH" -> "ERGH"
        if squeezed != x: out.add(squeezed)
    return sorted(x.strip() for x in out if x and x.strip())


def add_aliases(prompt):
    """Add auto_aliases to every answer, skipping any alias that would make the prompt ambiguous.
    Never removes an alias that's already there. Returns how many were added."""
    owner = defaultdict(set)                     # normalized key -> answers that already claim it
    for a in prompt["answers"]:
        for w in [a["answer"], *a.get("aliases", [])]:
            owner[normalize(w)].add(a["answer"])
    proposed = {a["answer"]: [w for w in auto_aliases(a["answer"]) if normalize(w)] for a in prompt["answers"]}
    claims = defaultdict(set)
    for ans, ws in proposed.items():
        for w in ws: claims[normalize(w)].add(ans)
    added = 0
    for a in prompt["answers"]:
        have = {normalize(w) for w in [a["answer"], *a.get("aliases", [])]}
        new = []
        for w in proposed[a["answer"]]:
            k = normalize(w)
            if k in have or owner[k] - {a["answer"]} or claims[k] - {a["answer"]}:
                continue                         # already accepted, or someone else's answer -> skip
            have.add(k); new.append(w)
        if new:
            a["aliases"] = sorted(set(a.get("aliases", [])) | set(new)); added += len(new)
    return added


def build_extra(chat, S):
    """Prompts added in the second pass (also appended to an existing bank by --update)."""
    people = chat["people"]
    regulars = [p for p in S["regulars"] if p not in EXCLUDE]
    P = []

    def add(pid, text, category, answers, review=False, note=None, limit=MAX_ANSWERS):
        answers = tier_answers(answers, limit=limit)
        if len(answers) < 4:
            return
        p = {"id": pid, "text": text, "category": category, "answers": answers}
        if review: p["review"] = True
        if note: p["note"] = note
        P.append(p)

    def who(rows, quip=None):
        return [{"answer": clean_name(r[0]), "weight": r[1], "aliases": person_aliases(r[0], people),
                 **({"quip": quip(r)} if quip else {})} for r in rows if r[0] not in EXCLUDE and r[1] > 0]

    add("early-birds", "Name someone texting the chat between 5 and 9 am", "people",
        who(S["early_birds_5am_9am"], lambda r: f"{r[1]:,} early-morning messages"))
    add("caps-lock", "Name someone who TYPES IN ALL CAPS", "words",
        who(S["all_caps_messages"], lambda r: f"{r[1]:,} all-caps messages ({r[2]}% of theirs)"))
    add("question-askers", "Name someone who's always asking the chat questions", "people",
        who(S["questions_asked"], lambda r: f"{r[1]:,} questions asked"))
    add("double-texters", "Name someone who's sent 5+ messages in a row with no reply", "people",
        who([r for r in S["longest_solo_runs"] if r[1] >= 5], lambda r: f"record: {r[1]} in a row"))
    add("video-senders", "Name someone who sends lots of videos", "people",
        who(S["media_by_person"].get("video", []), lambda r: f"{r[1]:,} videos"))
    add("own-like-emoji", "Name someone who has or has had their own like emoji", "likes",
        [{"answer": clean_name(p), "weight": sum(n for e, n in em.items() if e != "❤"), "aliases": person_aliases(p, people),
          "quip": "likes with " + "".join(e for e in em if e != "❤")} for p, em in S["personal_like_emoji_use"].items()])
    polls = Counter(c for _, c, _ in S["polls"])
    add("poll-makers", "Name someone who has made a poll in the chat", "system",
        who(polls.most_common(), lambda r: f"{r[1]} poll{'s' * (r[1] > 1)}"))
    for game, rows in S["games_posted"].items():
        if game == "Krillion":
            continue                                 # already covered by krillion-posters
        add(f"posters-{normalize(game)}", f"Name someone who posts their {game} results", "games",
            who(rows, lambda r: f"posted {r[1]} times"))
    for p in regulars[:8]:
        em = [(e, n) for e, n in S["text_emoji_by_person"].get(p, []) if e not in ("🏻", "🏼", "🏽", "♀", "♂")]
        add(f"emojis-{normalize(p)}", f"Name an emoji {clean_name(p)} sends a lot", "words",
            [{"answer": e, "weight": n} for e, n in em])
    # websites, merging subdomains (vt.tiktok.com, media2.giphy.com ...) into one site
    sites = Counter(); site_al = {}
    for d, n in S["top_link_domains"]:
        key = next((k for k in SITES if d == k or d.endswith("." + k)), None)
        name, al = SITES[key] if key else (d, [])
        sites[name] += n; site_al.setdefault(name, set()).update(al)
    add("websites", "Name a website we send links from", "media",
        [{"answer": s, "weight": n, "aliases": sorted(site_al[s])} for s, n in sites.items()])
    # two-word phrases, summed over everyone
    names = {w for p in people for w in normalize_words(p["display_name"])}
    ph = Counter()
    for rows in S["top_phrases_by_person"].values():
        for phrase, n in rows:
            ws = phrase.split()
            if not (set(ws) & (PHRASE_NOISE | BLOCKLIST | names)) and len(set(ws)) > 1:
                ph[phrase] += n
    add("phrases", "Name a two-word phrase we say all the time", "words",
        merge_by_key([{"answer": k, "weight": n} for k, n in ph.items()],
                     keyfn=lambda a: normalize(a.replace("bday", "birthday"))), review=True)

    # swear words, counted over every chat word
    tok = chat_tokens(chat)
    add("swears", "Name a swear word we have used before", "words",
        [{"answer": w, "weight": tok[w] + sum(tok[normalize(v)] for v in al), "aliases": al}
         for w, al in SWEARS.items() if w not in BLOCKLIST], limit=len(SWEARS))
    # long real words: in the system dictionary (or a plain inflection of one), no letter tripled
    words = dictionary()
    longs = [{"answer": w, "weight": n, "quip": f"said {n} time{'s' * (n > 1)}"} for w, n in tok.items()
             if len(w) >= LONG_WORD_MIN and w not in BLOCKLIST and is_long_word(w, n, words)]
    add("long-words", f"Name a long word ({LONG_WORD_MIN}+ letters, no keyboard smashes or stretched-out words) that has been said in the chat", "words",
        merge_by_key(longs), limit=100000, note=f"Words of {LONG_WORD_MIN}+ letters; checked against /usr/share/dict/web2 plus LONG_WORD_ALLOW.")
    if P and P[-1]["id"] == "long-words":           # tier by raw count instead of share of total
        for a in P[-1]["answers"]:
            a.pop("auto_pick", None)
            a["tier"] = next(t for n, t in LONG_WORD_TIERS if a["weight"] >= n)
            if a["answer"] in LONG_WORD_KRILLION:
                a.update(tier="krillion", auto_pick=True, quip=LONG_WORD_KRILLION[a["answer"]])
    add("ubc-food", "Name a UBC campus food place", "places",
        [{"answer": n, "weight": w, "aliases": sorted(set(al) | set(food_aliases(n))), "quip": where} for n, w, al, where in UBC_FOOD], limit=len(UBC_FOOD),
        note="Rarity from online sources (UBC food pages, student guides), not the chat. Edit UBC_FOOD.")
    return P


def chat_tokens(chat):
    """Every lowercase word in members' text messages, minus links and @handles."""
    tok = Counter()
    for m in chat["messages"]:
        if m.get("text") and m["type"] == "text" and m["sender"] not in EXCLUDE:
            t = re.sub(r"https?://\S+|@\S+|\S+\.(com|ca|app|gg|org)\S*", "", m["text"].lower().replace("’", "'"))
            tok.update(re.findall(r"[a-z]+", t))
    return tok


def dictionary(path="/usr/share/dict/web2"):
    try:
        return {w.strip().lower() for w in open(path, encoding="utf-8")}
    except OSError:
        return set()


SUFFIXES = ["s", "es", "ed", "d", "ing", "ly", "ness", "ment", "ments", "er", "ers", "ies", "ied", "ation", "ations",
            "ity", "ally", "ful", "less", "able", "ism", "ist", "ists", "ize", "ized", "izing"]


def is_real_word(w, words):
    if w in words: return True
    for suf in SUFFIXES:
        if w.endswith(suf):
            b = w[: -len(suf)]
            if b in words or b + "e" in words or (b.endswith("i") and b[:-1] + "y" in words) \
                    or (len(b) > 2 and b[-1] == b[-2] and b[:-1] in words):
                return True
    return False


LAUGH_RE = re.compile(r"(?:[ha]*h[ha]*a[ha]*|[ah]*(?:he|eh)[aeh]*|(?:lmf?ao)+[aoe]*|(?:lo)+l?|[aeiou]*)")


def is_long_word(w, n, words):
    """Long-word filter: keep anything that isn't an elongated word, a laugh or a keyboard smash.
    Real = dictionary word (or inflection), British spelling, or two dictionary words joined (sleepover).
    Anything else counts if it was said at least twice (names, slang, games); one-offs are likely smashes."""
    if re.search(r"(.)\1\1", w) or LAUGH_RE.fullmatch(w) or len(set(w)) <= 3:
        return False
    if w in LONG_WORD_ALLOW or is_real_word(w, words) or is_real_word(british_to_us(w), words):
        return True
    if any(is_real_word(w[:i], words) and is_real_word(w[i:], words) for i in range(3, len(w) - 2)):
        return True
    return n >= 2


def british_to_us(w):
    return re.sub(r"our(s|ed|ing|ite|ites|able)?$", r"or\1", w).replace("ise", "ize").replace("isation", "ization") \
        .replace("centre", "center").replace("tre", "ter")


def normalize_words(name):
    return [normalize(w) for w in clean_name(name).split() if len(normalize(w)) > 2]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("chat"); ap.add_argument("stats"); ap.add_argument("-o", "--out", default="prompt_bank.json")
    ap.add_argument("--update", metavar="BANK", help="keep this existing (hand-edited) bank: add aliases to it and "
                    "append prompts it doesn't have yet (except SKIP_PROMPTS); nothing in it is changed or removed")
    a = ap.parse_args()
    chat = json.load(open(a.chat, encoding="utf-8")); S = json.load(open(a.stats, encoding="utf-8"))
    if a.update:
        prompts = json.load(open(a.update, encoding="utf-8"))["prompts"]
        have = {p["id"] for p in prompts}
        new = [p for p in build(chat, S) + build_extra(chat, S) if p["id"] not in have | SKIP_PROMPTS and not p["id"].startswith(SKIP_PREFIXES)]
        print(f"kept {len(prompts)} prompts from {a.update}, appending {len(new)} new: {', '.join(p['id'] for p in new)}")
        prompts += new
    else:
        prompts = build(chat, S) + build_extra(chat, S)
    added = sum(add_aliases(p) for p in prompts)
    print(f"added {added} aliases")
    for p in prompts:
        p.pop("clashes", None)
        if c := check_unambiguous(p): p["clashes"] = c
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
