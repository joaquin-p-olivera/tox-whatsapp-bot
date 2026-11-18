import type { Proto } from 'zapo-js'

/** What the bot sent as a picture, a voice note, a sticker or a video, by the id WhatsApp gave the message. None of
 * those carries text, so a reply to one arrives quoting nothing, and the API cannot tell what it is about: this is
 * what fills the quote in. Kept in memory and only the latest few hundred, so after a restart a reply to an older one
 * gets the kind of thing it is (`describeQuoted`) and not what it was sent for. */
const MAX_REMEMBERED = 500
const sent = new Map<string, string>()

export function rememberSent(id: string | undefined, about: string | undefined): void {
    if (!id || !about) return
    sent.set(id, about)
    if (sent.size > MAX_REMEMBERED) sent.delete(sent.keys().next().value as string)
}

/** The text a quote with none of its own stands in with: what the bot sent that message for, when it remembers, and
 * otherwise the kind of message it is. Empty when it is no media at all. */
export function describeQuoted(context?: Proto.IContextInfo | null): string {
    const quoted = context?.quotedMessage
    if (!quoted) return ''
    const known = context?.stanzaId ? sent.get(context.stanzaId) : undefined
    if (known) return `[${known}]`
    if (quoted.imageMessage) return '[una foto]'
    if (quoted.audioMessage) return '[un audio]'
    if (quoted.stickerMessage) return '[un sticker]'
    if (quoted.videoMessage) return '[un video]'
    return ''
}
