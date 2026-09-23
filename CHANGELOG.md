# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
