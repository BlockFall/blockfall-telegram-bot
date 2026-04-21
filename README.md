# BlockFall Telegram support bot

A small Telegram bot that turns your customer DMs into per-customer **topic
threads** in a private admin supergroup. Built with TypeScript + [grammY].

```
customer ──DM──▶  bot  ──▶  admin supergroup (forum)
                                 │
                                 └──  topic "John Doe (@john)"
                                        ├─ customer's messages
                                        └─ your replies  ──▶  customer DM
```

No websites, no email, no external services – one bot, one admin group, done.

[grammY]: https://grammy.dev

## Features

- One-to-one relay between a customer DM and a dedicated **forum topic** in
  your admin group.
- Every new topic opens with an info card (name, username, Telegram user id).
- Bidirectional. Each relayed message is branded:
  - In the admin topic: `💬 <name>:` for customer messages.
  - In the customer DM: `🛟 Support:` for admin replies.
  - Photos, videos, documents, audio, voice, animations, stickers, video
    notes, locations and contacts are all supported; anything else is
    relayed via `copyMessage` as a fallback.
- A `👌` reaction is placed on the admin message once it has been delivered
  to the customer, so the operator sees at a glance what went through.
- Admin slash commands inside a topic:
  - `/info` – re-print the customer info card.
  - `/close` – close the topic.
  - `/reopen` – reopen the topic.
- Persistent mapping in a tiny JSON file (`data/customers.json`), so topic
  ↔ customer bindings survive restarts.
- Auto-recovers if you (or someone else) delete a topic in Telegram – the next
  customer message creates a fresh one.
- Fails fast at startup with a clear message if the admin group is
  misconfigured (wrong id, bot not in the group, topics disabled, …).

## How to activate the system on Telegram

You only have to do this once.

### 1. Create the bot

1. Open a chat with [@BotFather](https://t.me/BotFather).
2. `/newbot`, pick a name and a username ending in `bot`.
3. Copy the HTTP API token – it becomes `BOT_TOKEN` in `.env`.
4. Still in BotFather, run:
   - `/setprivacy` → choose your bot → **Disable**
     (so the bot can read every message in the admin group, not just
     commands).
   - `/setjoingroups` → **Enable** (so you can add the bot to the admin
     group).

### 2. Create the admin supergroup with topics enabled

1. In Telegram, create a **New Group** (not a channel). Add any member (you
   can remove them afterwards – you need at least one to create the group).
2. Open the group → pencil/edit icon → **Group Type** → switch to
   **Private** if it isn't already.
3. Edit the group again → **Topics** → toggle **ON**. The group is now a
   forum supergroup; every chat becomes a topic.
4. Add your bot to this group and **promote it to admin** with at least
   these permissions:
   - Manage Topics
   - Pin Messages
   - Delete Messages (optional, nice to have)
   - Send Messages (default)

### 3. Find the admin group's numeric ID

The ID you need looks like `-1001234567890` (negative, starting with `-100`).
Two easy ways to get it:

- Forward any message from the admin group to
  [@userinfobot](https://t.me/userinfobot) – it prints the `Chat id`.
- Or temporarily add [@RawDataBot](https://t.me/RawDataBot) to the group and
  read `chat.id` from the JSON it posts, then kick it.

Put that number in `.env` as `ADMIN_GROUP_ID`.

### 4. Configure and run

```bash
cp .env .env.local   # or just edit .env directly
# fill in BOT_TOKEN and ADMIN_GROUP_ID

pnpm install
pnpm dev             # watches src/ and restarts on changes
# or
pnpm start           # one-shot
```

First run will:

- Register the bot's command menu (`/start` in DMs; `/info`, `/close`,
  `/reopen` in the admin group).
- Start long-polling and drop any backlog of updates.

### 5. Smoke test

1. Open a DM with your bot from a **different Telegram account** and send
   `/start`, then a message.
2. A new topic named after that account appears in your admin group, with
   a pinned info card.
3. Reply inside that topic; the reply arrives in the customer DM.
4. Send a photo, file, voice note etc. from either side – all media types
   are relayed.

That's it.

## Configuration

Environment variables (see `.env`):

| Variable          | Required | Default                          | Notes                                                   |
| ----------------- | -------- | -------------------------------- | ------------------------------------------------------- |
| `BOT_TOKEN`       | yes      | –                                | From @BotFather.                                        |
| `ADMIN_GROUP_ID`  | yes      | –                                | Negative `-100…` supergroup id with topics enabled.     |
| `DATA_FILE`       | no       | `data/customers.json`            | Path to the JSON store. Directory is created on start.  |
| `WELCOME_MESSAGE` | no       | *(a short English greeting)*     | Sent to customers on `/start`.                          |

## Project layout

```
src/
  index.ts     # entry point
  bot.ts       # grammY bot, relay logic, admin commands
  storage.ts   # JSON-backed customer ↔ topic store
  config.ts    # zod-validated env loader
```

## Scripts

- `pnpm dev` – watch mode.
- `pnpm start` – production start.
- `pnpm typecheck` – `tsc --noEmit`.
- `pnpm lint` / `pnpm lint:fix` – ESLint.
- `pnpm format` / `pnpm format:check` – Prettier.

## Troubleshooting

- **`Bad Request: chat not found`** when the bot tries to open a topic:
  1. `ADMIN_GROUP_ID` is wrong – must be the full negative supergroup id,
     e.g. `-1001234567890`. A regular group id (positive, or `-<small int>`)
     will not work.
  2. The bot is not a member of the group yet – add it first.
  3. The group is a regular group, not a supergroup. Enable **Topics** in
     the group settings; that converts it to a supergroup automatically.

  The bot now calls `getChat` at startup and prints a targeted hint for
  each of these cases, so the log line right above the crash will tell you
  which one it is.

- **Customer messages don't appear** even though the bot looks healthy:
  BotFather's `/setprivacy` must be **Disabled** for the admin group (so
  non-command messages are visible to the bot). Group-privacy cache can
  take a few minutes to refresh after you change it – removing and
  re-adding the bot to the group forces it.

## Notes and limitations

- Uses long polling, so only **one instance at a time** may run against a
  given bot token.
- Media groups (albums) arrive as several separate messages on the other
  side – Telegram doesn't give bots a way to re-assemble them cleanly.
- Message edits and deletions are **not** propagated (by design – keeps the
  transcript on each side honest).
