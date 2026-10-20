# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Forwards the text of the message a command replies to, with who wrote it (`quoted`; the bot's own message is flagged), so `!claude` can answer about it. A reply to one of the bot's own messages is forwarded even without a command prefix (the API answers it with Claude), and a quoted message with no text (a voice note) is forwarded as an empty one.
- Both modes: forwards the text (and captions) of the chats that have history on (`GET /api/v1/history/chats`, `POST /api/v1/history`), with the message id, time and both ids of a private chat. Commands (`.b ...` / `!...`) and the bot's own answers are skipped.
- Personal mode (`npm run start:personal`, `--mode=personal`): runs on the owner's own number and answers only their own `.b <command>` messages in private chats and in the groups listed in `PERSONAL_GROUP_JIDS` (none by default), flagged `personal` for the API. Never acts on its own there (no alerts polling, no blacklist sweeps or group events). Reads only `.env.personal`; its session defaults to `tox-personal` / `.auth-personal`. The default stays the groups mode.
- Follows long-running commands (`!claude`): a reply with a `job` is sent right away and the bot polls `GET /api/v1/jobs/{id}` until the answer is ready, then sends it quoting the command.
- Moderation: removes members when a reply asks for it (`remove`, needs the bot to be a group admin) and enforces the API's blacklist (`!permaban`): sweeps every group it is in when asked and on connect, and checks a group whenever someone is added to it. Forwards each tagged person's aliases and group-admin status from the roster.
- Forwards the picture a command message carries or replies to (up to 5 MB, base64 in the optional `image` field), so `!sticker` can turn it into a sticker. Only downloaded for messages that are being forwarded.
- Sends each group member's aliases (LID and phone number) so the API can honour `!mute` whichever form is used.

- Initial WhatsApp bot built on `zapo-js` 1.9.0 with a persistent SQLite session (`node:sqlite`, no native build).
- Pairing by 8-character code using `BOT_PHONE_NUMBER`.
- Forwards `!`/`/` messages to the Tox API and sends back the replies (first reply quotes the command).
- Group allowlist (`ALLOWED_GROUP_JIDS`), opt-in private chats, `.env` / `.env.prod` selection via `APP_ENV`.
- Reconnection with exponential backoff and graceful shutdown.
- Unit tests plus an end-to-end test against Zapo's in-process fake WhatsApp server.

### Added

- Audio replies: downloads the clip from the API and sends it as WhatsApp audio (voice note for Ogg/Opus). Covered by an end-to-end test.

### Changed

- User-facing bot text is now Spanish; the API decides all replies.
- Sends the group's member list to the API and renders reply mentions as real WhatsApp mentions (for `!m`).

### Fixed

- The pairing code was never requested on a fresh session: WhatsApp signals it with `auth_qr` first and `auth_pairing_required` only on refresh. Both now trigger the request (covered by `test/pairing.test.ts`).

### Added

- Proactive alerts: polls the API (`ALERTS_POLL_INTERVAL_MS`) for messages it must send with no user command
  behind them (e.g. a local service going down or recovering) and sends each straight to its group.
- Image replies (`reply.image`, e.g. `!futbol -t`'s table): downloads it from the API and sends it as a
  WhatsApp image, same pattern as audio/sticker replies.
- Reports whether the sender administers the group (`sender_is_group_admin`, from the group roster it already reads; `false` when
  the roster can't be read), so the API can require it for admin-only commands.
- Flags a tag of the bot itself (`is_bot` on a `mentioned` user, matching either of its own JIDs), e.g. for `!gay @bot`.
- A URL on a private address (`http://192.168.x.x:port`, e.g. `!fred`) is now sent as link data (`matchedText` + title) so WhatsApp can make it
  tappable. Before, every reply went out in the library's plain-string form, which never carries link data (covered by an end-to-end test).
- Reaction replies (`reply.reaction`, e.g. `!uid`): reacts to the command message with the emoji and sends nothing else.
- Forwards the users tagged with `@` in a message (`mentioned`), e.g. for `!gay @user`.
- The group roster (and with it who administers the group) is no longer cached for 5 minutes: it's read from WhatsApp for every
  command in a group, so a change of group admins applies immediately.
