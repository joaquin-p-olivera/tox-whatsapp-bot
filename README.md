# Tox WhatsApp bot

WhatsApp front-end for the [Tox API](../tox). It has no command logic: it forwards every message that
starts with `!` or `/` to the API and sends back the replies. Commands, games and content are all defined
in the API.

## Why Zapo (and not Baileys)

Both libraries speak the WhatsApp Web protocol without the official Business API. Compared on 21 Sep 2026 from the npm registry, GitHub and each project's docs (rows marked "not evaluated" weren't checked in depth):

|                       | [`zapo-js`](https://github.com/vinikjkkj/zapo)                   | [`baileys`](https://github.com/WhiskeySockets/Baileys)              |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Release line          | Stable `1.x` with SemVer (`1.9.0`, published 20 Sep 2026)         | `7.0.0-rc14` (release candidate); `6.7.x` is the legacy line         |
| Runtime dependencies  | None (optional add-ons)                                          | 11                                                                  |
| Community             | Younger (first release Mar 2026, ~235 stars)                      | Much larger (~11k stars), most tutorials and examples               |
| Pairing               | QR or 8-character code from a phone number                       | QR or pairing code                                                  |
| Groups / LID          | Documents PN vs LID addressing and exposes both on each message  | Not evaluated in depth                                              |
| Session storage       | Built-in SQLite store (uses Node's `node:sqlite`, no native build) | Not evaluated in depth (you provide/choose the auth-state storage) |
| Testing without phone | Ships an in-process fake WhatsApp server (real Noise/Signal crypto) | Not bundled (Zapo's fake server is documented to work with it)   |

**Choice: Zapo**, because the API is stable and versioned, it needs no native compilation, and the fake
server let us test the whole pipeline (pairing, encrypted group message in, reply out) without a phone.
The main risk is its smaller community. WhatsApp-specific code is isolated in `src/whatsapp.ts`, so
switching libraries later only touches that file.

> **Unofficial library warning.** Neither library is endorsed by WhatsApp, and automated accounts can be
> banned. That's why the bot should run on a dedicated number, only in groups you control, and answer only
> to explicit commands. Never use your personal number.

## Requirements

- Node.js ≥ 22.13 (developed on 24). The code runs directly with Node's type stripping: no build step.
- The [Tox API](../tox) running (default `http://127.0.0.1:8000`).

## Setup

```bash
npm install
cp .env.default .env      # set TOX_API_KEY (same value as API_KEY in ../tox/.env)
npm start
```

### First run: pairing

Put the bot's number in `.env` as `BOT_PHONE_NUMBER` (with country code, e.g. `+598XXXXXXXX`).

1. **The number must already have a WhatsApp account.** The bot links as a companion device (like WhatsApp Web), so it needs a real account on a phone first: install WhatsApp on a phone with that chip and complete the SMS registration. A number without an account can't be paired.
2. Run `npm start`. The log prints `PAIRING CODE: XXXX-XXXX`.
3. On the phone: **WhatsApp → Linked devices → Link a device → Link with phone number instead**, and enter the code.

Keep that phone with the account around: like WhatsApp Web, linked devices are logged out if the main phone stays offline for too long (about 2 weeks).

The session is stored in `.auth/state.sqlite` (git-ignored, contains the account's keys) and reused on the
next start. To pair again, delete `.auth/`.

### Locking it down

1. Add the bot to your group and send `!id`. The reply shows the group's JID (`…@g.us`).
2. Set `ALLOWED_GROUP_JIDS=<that jid>` in `.env` and restart. Any other group is ignored (the log tells you
   which JID was ignored).

Until you set it, the bot answers in every group it's in. Private chats are ignored unless
`ALLOW_PRIVATE_CHATS=true`.

## Two ways to run it

| | Groups (default) | Personal |
| --- | --- | --- |
| Start | `npm start` / `./start_dev.sh` | `npm run start:personal` / `./start_dev.sh --mode=personal` |
| Account | the dedicated bot account | your own number, linked as a device |
| Where | WhatsApp groups | your private chats, and the groups you list in `PERSONAL_GROUP_JIDS` |
| Who | anyone in the group | only you (what you type yourself) |
| Command | `!sticker`, `!voz -h Hola` | `.b sticker`, `.b voz -h Hola` |
| Env file | `.env` / `.env.prod` | `.env.personal` only |
| Admin commands | per `ADMIN_USER_IDS` | never: the reply is visible to the other person |

`./start_dev.sh` is the same thing with the chores done for you: it installs the dependencies when `node_modules`
is missing, checks that the env file it is going to read exists, and `exec`s the bot. It is also what the services
below run.

### Running it as a service

Two `systemd` user units (no `sudo`, and they start at boot thanks to `loginctl enable-linger`) live outside this
repo, in `~/.config/systemd/user/`: `tox-bot.service` and `tox-bot-personal.service`, each running `./start_dev.sh`.

```bash
systemctl --user daemon-reload
systemctl --user enable --now tox-bot.service tox-bot-personal.service
systemctl --user status tox-bot.service
journalctl --user -u tox-bot.service -f          # the log (-n 200 for the last lines)
```

Never run a mode twice (the service **and** `npm start`): both instances use the same `.auth`, and WhatsApp throws
one of them out over and over — `stream_error_replaced` in the log.

The personal instance **never acts on its own**: no alerts (it would otherwise take the groups bot's queue and send it
from your number) and no blacklist sweeps. `!recordar` is refused there for the same reason. Groups are ignored
unless you list them in `PERSONAL_GROUP_JIDS` (comma-separated JIDs; empty = none): type `.b id` in one and the log
shows the JID it ignored. In a listed group only *your* `.b` messages count, never anyone else's.
Replies go out from your number, so the other person sees them as yours.

**History.** Both modes forward the *text* of the chats that have history on (`h -on`): everyone's messages in that
chat, never pictures but their captions yes. The bot only asks the API which chats are on (every 15 s) and sends
nothing for the others; commands and the bot's own answers are never saved. In the groups bot, `!h -on | -off | -status
| -delete` and `!res` are for the admins (`ADMIN_USER_IDS`, who must also administer the group); from your own number
they are `.b h ...` and `.b res`. See the API's README.

Setup: copy `.env` to `.env.personal` and change `BOT_PHONE_NUMBER` (yours), `BOT_SESSION_ID` and `AUTH_DIR`
(they default to `tox-personal` and `.auth-personal`, so the session never collides with the bot's), then run
`npm run start:personal` and link it from your phone (Linked devices → *Link with phone number instead*). Both
instances can run at the same time against the same API. `.auth-personal/` holds your account's keys: it is
git-ignored, keep it private.

## Configuration

| Variable              | Default                 | Description                                                  |
| --------------------- | ----------------------- | ------------------------------------------------------------ |
| `TOX_API_URL`         | `http://127.0.0.1:8000` | Tox API base URL                                             |
| `TOX_API_KEY`         | (required)              | Shared secret sent as `X-API-Key`                            |
| `TOX_API_TIMEOUT_MS`  | `10000`                 | API request timeout                                          |
| `BOT_PHONE_NUMBER`    |                         | Number of the bot's account, for the pairing code            |
| `BOT_SESSION_ID`      | `tox`                   | Session name; changing it forces a new pairing               |
| `AUTH_DIR`            | `.auth`                 | Where the session is stored                                  |
| `ALLOWED_GROUP_JIDS`  | (all groups)            | Comma-separated group JIDs                                   |
| `ALLOW_PRIVATE_CHATS` | `false`                 | Answer in 1:1 chats                                          |
| `COMMAND_PREFIXES`    | `!,/`                   | Only messages starting with these reach the API              |
| `LOG_LEVEL`           | `info`                  | `trace`, `debug`, `info`, `warn`, `error`                    |

`.env` and `.env.prod` are git-ignored. `npm run start:prod` sets `APP_ENV=prod` and reads `.env.prod`.

## Behaviour

- Ignores its own messages, non-text messages and anything that doesn't start with a command prefix — except a reply to one of
  its own messages, which goes to the API with no prefix: that is how the API lets people talk to Claude by just replying
  (`CLAUDE_ON_REPLY`). In the personal mode nothing changes: only the owner's `.b <command>` is forwarded.
- Ordinary chatter is forwarded too, but only from a **group whose history is on** (`GET /api/v1/history/chats`, looked up again
  every 15 s): the API reads it and now and then answers with a remark of its own (`CLAUDE_INTERJECT_CHANCE`), and otherwise
  with nothing. Nobody asked for anything there, so the picture of such a message is never downloaded.
- **Censorship** (`!censura`, groups mode only): before anything else — the history included — a group message is
  checked against the list of censored people (`GET /api/v1/censored`, read again at most every 15 s and right after
  any command). Theirs is deleted for everyone and goes no further: not forwarded, not saved, no reply. WhatsApp only
  lets an **admin of the group** delete somebody else's message, so without that the deletion fails; the group is then
  told once per run and every failure is logged. If the list can't be read the last one stays in force, so an API
  restart does not quietly lift it.
- Replies are quoted (the first one), so it's clear who asked.
- When a message replies to another one, that text goes to the API too (`quoted`, with who wrote it; the bot's own message is
  flagged), so `!claude` can answer about it. A quoted message with no text (a voice note) is forwarded as an empty one, which
  is what tells the API that somebody replied to the bot's own voice note.
- If the API is unreachable, the chat gets `⚠️ Tox no está disponible en este momento…`.
- In groups it sends the member list (cached 5 minutes, bot excluded) so the API can pick a random member for `!m`. The sender is excluded whichever JID form (LID or phone number) the group uses. If the list can't be fetched, the API falls back to the users it has seen.
- Audio replies (`!m`) are downloaded from the API and sent as audio: Ogg/Opus goes out as a voice note, m4a/mp3 as a plain audio file. If the download fails, it's logged and nothing is sent.
- Mentions are sent as `@<number>` plus the mentioned JIDs, which is how WhatsApp renders a real tag.
- Reconnects with exponential backoff (up to 10 attempts). If the phone unlinks the device it stops and
  asks you to pair again.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # unit tests + end-to-end test against Zapo's fake WhatsApp server
```

The end-to-end test (`test/e2e.test.ts`) pairs the bot with an in-process fake WhatsApp server, sends an
encrypted command from a fake group member (answered by a stub of the API) and checks another member receives the reply. Run it with
`E2E_LOG=debug` to see the client's logs.

## Branching model

- `main`: released code only.
- `develop`: integration branch; `feature/{name}`, `doc/{name}`, ... branch off it.
- `release/{version}`: cut from `develop`, merged into `main` via PR.

See [CHANGELOG.md](./CHANGELOG.md) for release history.
