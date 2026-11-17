# Group chat → krillion prompt bank

Turns an Instagram group-chat export into a prompt bank for the krillion game.

```
bank_generation/
├── data/            your export and everything generated from it (git-ignored, except README.txt)
└── tools/
    ├── html_to_json.py   export HTML → chat.json
    ├── eda.py            chat.json → stats, charts, report
    ├── make_prompts.py   chat.json + stats → prompt_bank.json
    └── requirements.txt
```

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r bank_generation/tools/requirements.txt
```

Put the export's `message_1.html` … `message_N.html` files in `bank_generation/data/`.

## Run

From `bank_generation/`:

```bash
python tools/html_to_json.py data/ -o data/chat.json
python tools/eda.py data/chat.json -o data/eda_out
python tools/make_prompts.py data/chat.json data/eda_out/stats.json -o data/prompt_bank.json
```

| Step | Writes |
|---|---|
| `html_to_json.py` | `chat.json`: every message, oldest first |
| `eda.py` | `eda_out/report.md`, `eda_out/stats.json`, `eda_out/*.png` |
| `make_prompts.py` | `prompt_bank.json` |

`html_to_json.py` also accepts individual files: `python tools/html_to_json.py data/message_*.html -o data/chat.json`.

## Before you run it on a groupchat

- **Like emojis:** edit `LIKE_EMOJIS` at the top of `html_to_json.py`. ❤ counts as a like from anyone. Each person's own emoji counts as a like only when they use it; from anyone else it's a normal reaction. Names are display names from the export, matched case-insensitively by prefix.
- **Excluded senders:** `EXCLUDE` in `eda.py` (default: `Instagram User`, `Meta AI`) is left out of the stats.
- **Regulars:** `CORE_MIN_MESSAGES` in `eda.py` (default 1000) sets who gets their own row in the per-person tables.
- **Prompt answers:** at the top of `make_prompts.py`, `PERSON_ALIASES` lists the names people might type for each member, `EMOJI_WORDS` lists words accepted in place of emoji, `BLOCKLIST` lists words never offered as answers, and `EXCLUDE` lists senders left out.

## chat.json

- `meta`: title, participants, exporter, date range, like rules
- `people`: display name, usernames seen in system lines, message count, like emojis
- `messages` (oldest first): `id, ts, sender, type, text, share, attachments, links, likes, reactions, system, source`
  - `type`: `text`, `photo`, `video`, `audio`, `share`, `system`, `empty` (content missing from the export), `attachment_unavailable`
  - `likes`: like emojis, as defined above
  - `reactions`: every other emoji, plus sticker reactions (`sticker` path)
  - `system.kind`: `group_rename`, `nickname`, `nickname_cleared`, `theme`, `member_added` / `member_removed` / `member_left`, `poll_created` / `poll_vote` / `poll_unavailable` ("This poll is no longer available"), `call_started` / `call_missed` / `call_ended`, `like_notification` ("X liked a message"), `reaction_notification` ("X reacted 🦭 to your message", with `is_like`), `pin`, `shared_album`, `collection`, `group_photo`
  - `source`: page and position in the original HTML, for checking
- Timestamps are the export's local time, with no timezone.

## prompt_bank.json

```json
{
  "version": 1,
  "source": "<chat title>",
  "tiers": { "plankton": 10, "tooclever": 15, "schooler": 30, "rare": 60, "deepcut": 85, "krillion": 100 },
  "prompts": [
    {
      "id": "group-names",
      "text": "Name a name this group chat has had",
      "category": "system",
      "answers": [
        { "answer": "…", "aliases": ["…"], "tier": "plankton", "weight": 346.8, "quip": "Used 345.8 days, set by …" }
      ]
    }
  ]
}
```

- Each answer has the same shape as OpenKrillion (`answer, tier, aliases, quip`), plus `weight`: how common it is in the chat.
- Tiers are assigned automatically from `weight`. Answers are sorted most common first and tiered by their running share of the total (using √weight): the first ~45% are `plankton`, up to ~80% `schooler`, up to ~95% `rare`, the rest `deepcut`, and the single rarest answer is `krillion`. The cut-offs are `TIER_CUTS` in `make_prompts.py`.
- Change any `tier` by hand. `tooclever` is never assigned automatically, so set it yourself.
- `auto_pick: true` marks the auto-chosen One in a Krillion (the `krillion` answer). `review: true` marks prompts to check before they go live.
- Answer matching keeps emoji (see `normalize()` in `make_prompts.py`). The game must normalize answers the same way.

## Privacy

Everything in `data/` is real chat content. It is git-ignored; when using this please keep it that way, and don't commit `chat.json`, `eda_out/` or `prompt_bank.json` from anywhere else either.
