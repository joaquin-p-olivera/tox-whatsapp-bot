import type { Config } from './config.ts'
import { ToxApiError, type ToxAudio, type ToxClient, type ToxParticipant, type ToxReply, type ToxSticker } from './toxClient.ts'

/** A chat message, normalised so this module knows nothing about the WhatsApp library. */
export interface ChatMessage {
    chatJid: string
    senderJid: string
    /** The sender's alternate addressing (phone number <-> LID), when WhatsApp shares it. */
    senderAltJid?: string
    senderName?: string
    text: string
    isGroup: boolean
    fromMe: boolean
    /** Opaque handle the sender uses to quote the original message. */
    quoteRef: unknown
}

/** A group member. `aliases` are the other JIDs the same person can appear under. */
export interface GroupMember {
    userId: string
    aliases: string[]
    name?: string
}

export interface SendOptions {
    quoteRef?: unknown
    mentionJids?: string[]
}

export type SendText = (chatJid: string, text: string, options?: SendOptions) => Promise<void>
export type SendAudio = (chatJid: string, audio: ToxAudio, options?: SendOptions) => Promise<void>
export type SendSticker = (chatJid: string, sticker: ToxSticker, options?: SendOptions) => Promise<void>
export type GetGroupMembers = (chatJid: string) => Promise<GroupMember[]>

export interface HandlerLogger {
    info(message: string, context?: Record<string, unknown>): void
    warn(message: string, context?: Record<string, unknown>): void
    error(message: string, context?: Record<string, unknown>): void
    debug(message: string, context?: Record<string, unknown>): void
}

export const API_DOWN_REPLY = '⚠️ Tox no está disponible en este momento. Probá de nuevo en un rato.'

interface Deps {
    config: Config
    tox: Pick<ToxClient, 'sendMessage' | 'fetchAudio' | 'fetchSticker'>
    sendText: SendText
    sendAudio: SendAudio
    sendSticker: SendSticker
    logger: HandlerLogger
    /** Optional: lets the API pick a random member. Failures are tolerated. */
    getGroupMembers?: GetGroupMembers
}

/** Removes the ":device" segment: "123:4@lid" -> "123@lid". */
export function stripDevice(jid: string): string {
    return jid.replace(/:\d+(?=@)/, '')
}

/** "5989123@s.whatsapp.net" -> "5989123": what WhatsApp shows after the "@" in a mention. */
export function jidUser(jid: string): string {
    return stripDevice(jid).split('@')[0] ?? jid
}

/** Replaces `{@0}`, `{@1}`... with `@user` and returns the JIDs to mention. */
export function renderMentions(reply: ToxReply): { text: string; mentionJids: string[] } {
    const mentionJids: string[] = []
    const text = reply.text.replace(/\{@(\d+)\}/g, (placeholder, index: string) => {
        const mention = reply.mentions[Number(index)]
        if (!mention) return placeholder
        mentionJids.push(mention.user_id)
        return `@${jidUser(mention.user_id)}`
    })
    return { text, mentionJids }
}

export function createMessageHandler({ config, tox, sendText, sendAudio, sendSticker, logger, getGroupMembers }: Deps) {
    const startsWithPrefix = (text: string) => config.commandPrefixes.some((prefix) => text.startsWith(prefix))

    async function listParticipants(message: ChatMessage, senderId: string): Promise<ToxParticipant[] | undefined> {
        if (!message.isGroup || !getGroupMembers) return undefined
        try {
            const senderIds = new Set([senderId, message.senderAltJid && stripDevice(message.senderAltJid)])
            const members = await getGroupMembers(message.chatJid)
            const candidates = members
                // The sender must never be a candidate, whichever form of their JID the group uses.
                .filter((member) => ![member.userId, ...member.aliases].some((id) => senderIds.has(id)))
                .map((member) => ({ user_id: member.userId, user_name: member.name, aliases: member.aliases }))
            if (candidates.length === 0) {
                logger.warn('No one to mention: the group has no members besides the sender and the bot', {
                    chat: message.chatJid,
                    membersExcludingBot: members.length
                })
            }
            return candidates
        } catch (error) {
            logger.warn('Could not list group members; the API will use who it has seen', { error: String(error) })
            return undefined
        }
    }

    return async function handleMessage(message: ChatMessage): Promise<void> {
        if (message.fromMe) return

        const text = message.text.trim()
        // Cheap local filter: don't call the API for ordinary chatter.
        if (!text || !startsWithPrefix(text)) return

        if (message.isGroup) {
            if (config.allowedGroupJids.size > 0 && !config.allowedGroupJids.has(message.chatJid)) {
                logger.info('Ignoring command from a group that is not allowed (add it to ALLOWED_GROUP_JIDS)', {
                    chat: message.chatJid
                })
                return
            }
        } else if (!config.allowPrivateChats) {
            logger.debug('Ignoring private chat (ALLOW_PRIVATE_CHATS=false)', { chat: message.chatJid })
            return
        }

        const senderId = stripDevice(message.senderJid)
        let replies: ToxReply[]
        try {
            replies = await tox.sendMessage({
                platform: 'whatsapp',
                chat_id: message.chatJid,
                user_id: senderId,
                user_name: message.senderName,
                text,
                is_group: message.isGroup,
                participants: await listParticipants(message, senderId)
            })
        } catch (error) {
            logger.error('Tox API call failed', { error: error instanceof ToxApiError ? error.message : String(error) })
            replies = [{ text: API_DOWN_REPLY, mentions: [] }]
        }

        for (const [index, reply] of replies.entries()) {
            // Only the first reply quotes the command, so multi-part answers stay readable.
            const quoteRef = index === 0 ? message.quoteRef : undefined
            const hasMedia = Boolean(reply.audio) || Boolean(reply.sticker)
            try {
                if (reply.audio) {
                    await sendAudio(message.chatJid, await tox.fetchAudio(reply.audio), { quoteRef })
                }
                if (reply.sticker) {
                    await sendSticker(message.chatJid, await tox.fetchSticker(reply.sticker), { quoteRef })
                }
                if (reply.text) {
                    const { text: body, mentionJids } = renderMentions(reply)
                    await sendText(message.chatJid, body, {
                        quoteRef: hasMedia ? undefined : quoteRef,
                        mentionJids: mentionJids.length > 0 ? mentionJids : undefined
                    })
                }
            } catch (error) {
                logger.error('Failed to send reply', { chat: message.chatJid, error: String(error) })
                return
            }
        }
    }
}
