# Group chat → krillion prompt bank

```
pip install lxml matplotlib
python html_to_json.py path/to/inbox/roysnonutdesires_xxx/ -o chat.json
python eda.py chat.json -o eda_out
python make_prompts.py chat.json eda_out/stats.json -o prompt_bank.json
```

## chat.json
- `meta`: title, participants, exporter, date range, like rules
- `people`: display name, usernames seen in system lines, message count, like emojis
- `messages` (oldest first): `id, ts, sender, type, text, share, attachments, links, likes, reactions, system, source`
  - `type`: text, photo, video, audio, share, system, empty (content missing from export), attachment_unavailable
  - `likes`: ❤ from anyone, plus each person's own like emoji (🦭 Dora, 😺 Luis, 🐒 bosco, 🩵🩷 annie, 💙 Daxton, 🥖 Roy). Edit `LIKE_EMOJIS` at the top of `html_to_json.py`.
  - `reactions`: every other emoji, and sticker reactions (`sticker` path)
  - `system.kind`: group_rename, nickname, theme, member_added/removed/left, poll_created/poll_vote, call_started/missed/ended,
    like_notification ("X liked a message"), reaction_notification ("X reacted 🦭 to your message", with `is_like`), pin, shared_album, collection, group_photo
  - `source`: page and position in the original HTML, for checking
- Timestamps are the export's local time, with no timezone.

## prompt_bank.json
Same answer shape as OpenKrillion (`answer, tier, aliases, quip`) plus `weight` (how common it is in the chat).
Tiers are automatic; change any `tier` by hand. Set "tooclever" yourself. `auto_pick: true` marks the auto-chosen
One in a Krillion; `review: true` marks prompts worth checking before they go live.
Answer matching keeps emoji (see `normalize()` in make_prompts.py); the game must use the same rule.
