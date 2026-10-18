# Flume branding

`flume-mark.svg` is the canonical Flume mark: one channel of work falling from the top and branching into three (director, manager, contributor), the workforce flowing down the org chart. Deep teal #0f5f63 with the water #7fd3c8 running through it, on off-white #f3f1ea.

It is the Telegram avatar of @flume_pm_bot, set with the `hermes-project-avatar` skill:

```bash
python3 ~/.agents/skills/hermes-project-avatar/scripts/telegram_avatar.py convert \
  --svg branding/flume-mark.svg --out /tmp/flume-pm.jpg --background '#f3f1ea' --pad 5
```

Change the mark here and re-run the skill; the Holocene Agent Pad picks the new avatar up from Telegram by itself.
