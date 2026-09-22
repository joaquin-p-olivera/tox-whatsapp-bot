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

- Ignores its own messages, non-text messages and anything that doesn't start with a command prefix.
- Replies are quoted (the first one), so it's clear who asked.
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
