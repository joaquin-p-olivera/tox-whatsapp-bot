/**
 * WhatsApp only treats a URL as a link to tap when the message carries it as link-preview data (`matchedText`).
 * The library builds that for the object form of a text message, but NOT for the plain-string form this bot uses
 * everywhere, so a reply like `http://192.168.1.21:5200` (e.g. `!fred`) goes out as plain text. Its automatic preview
 * also refuses private addresses by default, so for those the bot supplies the link data itself (see `sendText`).
 */

// localhost, loopback and the private IPv4 ranges (10/8, 172.16/12, 192.168/16), with an optional port and path
const PRIVATE_URL =
    /\bhttps?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?(?:[/?#]\S*)?/i
const TRAILING_PUNCTUATION = /[.,;:!?'"»›>)\]}]+$/

/** The first URL in `text` that points at a private/local address (trailing punctuation removed), if any. */
export function findPrivateLink(text: string): string | undefined {
    const match = PRIVATE_URL.exec(text)
    return match ? match[0].replace(TRAILING_PUNCTUATION, '') : undefined
}
