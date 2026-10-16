import type { Config } from './config.ts'
import { ToxApiError, type ToxAudio, type ToxClient, type ToxHistoryMessage, type ToxImage, type ToxParticipant, type ToxQuoted, type ToxReply, type ToxSticker } from './toxClient.ts'

/** A chat message, normalised so this module knows nothing about the WhatsApp library. */
export interface ChatMessage {
    chatJid: string
    senderJid: string
    /** The sender's alternate addressing (phone number <-> LID), when WhatsApp shares it. */
    senderAltJid?: string
    senderName?: string
    text: string
    /** JIDs the sender tagged with @ in the message (as WhatsApp reports them). */
    mentionedJids?: string[]
    isGroup: boolean
    fromMe: boolean
    /** WhatsApp's id of the message and when it was sent (ms since epoch), for the saved history. */
    messageId?: string
    sentAtMs?: number
    /** The chat's alternate addressing (phone number <-> LID, private chats), when WhatsApp shares it. */
    chatAltJid?: string
    /** The text message this one replies to, and who wrote it (!claude hands it to Claude along with the question). */
    quoted?: { text: string; senderJid?: string }
    /** Opaque handle the sender uses to quote the original message. */
    quoteRef: unknown
    /** Downloads the picture this message carries or replies to (undefined when there is none or it is too big). Only
     * called for messages that are going to be forwarded, so ordinary chatter never costs a download. */
    getImage?: () => Promise<Uint8Array | undefined>
}

/** A group member. `aliases` are the other JIDs the same person can appear under. */
export interface GroupMember {
    userId: string
    aliases: string[]
    name?: string
    /** Administrator (or creator) of the group, as WhatsApp reports it. */
    isAdmin?: boolean
}

export interface SendOptions {
    quoteRef?: unknown
    mentionJids?: string[]
}

export type SendText = (chatJid: string, text: string, options?: SendOptions) => Promise<void>
export type SendAudio = (chatJid: string, audio: ToxAudio, options?: SendOptions) => Promise<void>
export type SendSticker = (chatJid: string, sticker: ToxSticker, options?: SendOptions) => Promise<void>
export type SendImage = (chatJid: string, image: ToxImage, options?: SendOptions) => Promise<void>
export type SendReaction = (chatJid: string, emoji: string, target: unknown) => Promise<void>
/** Removes members (by the ids the API knows them under) from a group. Throws when it can't (e.g. the bot is not an admin). */
export type RemoveMembers = (chatJid: string, userIds: string[]) => Promise<void>
export type GetGroupMembers = (chatJid: string) => Promise<GroupMember[]>

export interface HandlerLogger {
    info(message: string, context?: Record<string, unknown>): void
    warn(message: string, context?: Record<string, unknown>): void
    error(message: string, context?: Record<string, unknown>): void
    debug(message: string, context?: Record<string, unknown>): void
}

export const REMOVE_FAILED_REPLY = '⚠️ No pude sacarlo del grupo. ¿Soy admin del grupo?'
export const JOB_LOST_REPLY = '⚠️ No pude obtener la respuesta (se perdió la consulta).'
export const API_DOWN_REPLY = '⚠️ Tox no está disponible en este momento. Probá de nuevo en un rato.'

interface Deps {
    config: Config
    tox: Pick<ToxClient, 'sendMessage' | 'fetchAudio' | 'fetchSticker' | 'fetchImage'> &
        Partial<Pick<ToxClient, 'fetchJob' | 'fetchHistoryChats' | 'saveHistory'>>
    sendText: SendText
    sendAudio: SendAudio
    sendSticker: SendSticker
    sendImage: SendImage
    sendReaction: SendReaction
    logger: HandlerLogger
    /** Optional: lets the API pick a random member. Failures are tolerated. */
    getGroupMembers?: GetGroupMembers
    /** Optional: removes members from the group (!ban). Without it the removal is reported as not possible. */
    removeMembers?: RemoveMembers
    /** Optional: removes everyone on the blacklist from every group the bot is in (!permaban). Failures are logged. */
    sweepBlacklist?: () => Promise<void>
    /** Optional (tests): how long to wait between checks of a long-running job, and the most it is followed. */
    jobPollMs?: number
    jobMaxWaitMs?: number
    sleep?: (ms: number) => Promise<void>
    /** Optional: the bot's own JIDs, so a tag of the bot itself is flagged for the API (e.g. `!gay @bot`). */
    getSelfJids?: () => string[]
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

/** What starts a command in the personal mode: ".b sticker hola" (the API parses it, this is only the cheap filter). */
export const PERSONAL_PREFIX = '.b '

/** The chats of a person (not a group, a broadcast list, a status or a channel). */
function isPrivateChat(chatJid: string): boolean {
    return chatJid.endsWith('@s.whatsapp.net') || chatJid.endsWith('@lid')
}

/** The replied-to message for the API. In the personal mode the own account is the owner, not the bot. */
function quotedOf(quoted: { text: string; senderJid?: string }, selfJids: Set<string>, personal: boolean): ToxQuoted {
    const id = quoted.senderJid ? stripDevice(quoted.senderJid) : undefined
    return {
        text: quoted.text,
        ...(id ? { user_id: id } : {}),
        ...(!personal && id && selfJids.has(id) ? { is_bot: true } : {})
    }
}

export function createMessageHandler({ config, tox, sendText, sendAudio, sendSticker, sendImage, sendReaction, logger, getGroupMembers, getSelfJids, removeMembers, sweepBlacklist, jobPollMs = 2_000, jobMaxWaitMs = 15 * 60_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: Deps) {
    const startsWithPrefix = (text: string) => config.commandPrefixes.some((prefix) => text.startsWith(prefix))

    /** The group's member list for the API, plus whether the sender administers this group. When the roster can't be
     * read, the sender is reported as NOT an admin: an admin-only command is refused rather than guessed. */
    async function inspectGroup(
        message: ChatMessage,
        senderId: string
    ): Promise<{ participants?: ToxParticipant[]; senderIsGroupAdmin?: boolean; roster?: GroupMember[] }> {
        if (!message.isGroup || !getGroupMembers) return {}
        try {
            const senderIds = new Set([senderId, message.senderAltJid && stripDevice(message.senderAltJid)])
            const members = await getGroupMembers(message.chatJid)
            const candidates = members
                // The sender must never be a candidate, whichever form of their JID the group uses.
                .filter((member) => ![member.userId, ...member.aliases].some((id) => senderIds.has(id)))
                .map((member) => ({
                    user_id: member.userId,
                    user_name: member.name,
                    aliases: member.aliases,
                    is_group_admin: Boolean(member.isAdmin)
                }))
            if (candidates.length === 0) {
                logger.warn('No one to mention: the group has no members besides the sender and the bot', {
                    chat: message.chatJid,
                    membersExcludingBot: members.length
                })
            }
            const sender = members.find((member) => [member.userId, ...member.aliases].some((id) => senderIds.has(id)))
            return { participants: candidates, senderIsGroupAdmin: Boolean(sender?.isAdmin), roster: members }
        } catch (error) {
            logger.warn('Could not list group members; the API will use who it has seen', { error: String(error) })
            return { senderIsGroupAdmin: false }
        }
    }

    /** The picture of the message (its own or the one it replies to), for commands that work on one (!sticker, !foto). A
     * failed download is not worth failing the command for: the API answers without it. */
    async function loadImage(message: ChatMessage): Promise<Uint8Array | undefined> {
        if (!message.getImage) return undefined
        try {
            return await message.getImage()
        } catch (error) {
            logger.warn('Could not download the message picture', { error: String(error) })
            return undefined
        }
    }

    async function deliver(message: ChatMessage, replies: ToxReply[]): Promise<boolean> {
        for (const [index, reply] of replies.entries()) {
            // Only the first reply quotes the command, so multi-part answers stay readable.
            const quoteRef = index === 0 ? message.quoteRef : undefined
            const hasMedia = Boolean(reply.audio) || Boolean(reply.sticker) || Boolean(reply.image)
            try {
                if (reply.remove?.length) {
                    try {
                        if (!removeMembers) throw new Error('removing members is not available')
                        await removeMembers(message.chatJid, reply.remove)
                    } catch (error) {
                        logger.error('Could not remove members', { chat: message.chatJid, error: String(error) })
                        // The reply text announces the ban as done: it would be a lie.
                        await sendText(message.chatJid, REMOVE_FAILED_REPLY, { quoteRef })
                        continue
                    }
                }
                if (reply.reaction) {
                    // Always reacts to the command message itself, whichever reply of the list carries it.
                    await sendReaction(message.chatJid, reply.reaction, message.quoteRef)
                }
                if (reply.audio) {
                    await sendAudio(message.chatJid, await tox.fetchAudio(reply.audio), { quoteRef })
                }
                if (reply.sticker) {
                    await sendSticker(message.chatJid, await tox.fetchSticker(reply.sticker), { quoteRef })
                }
                if (reply.image) {
                    await sendImage(message.chatJid, await tox.fetchImage(reply.image), { quoteRef })
                }
                if (reply.text) {
                    const { text: body, mentionJids } = renderMentions(reply)
                    if (personal) rememberOwnReply(message.chatJid, body)
                    await sendText(message.chatJid, body, {
                        quoteRef: hasMedia ? undefined : quoteRef,
                        mentionJids: mentionJids.length > 0 ? mentionJids : undefined
                    })
                }
            } catch (error) {
                logger.error('Failed to send reply', { chat: message.chatJid, error: String(error) })
                return false
            }
            if (reply.sweep_blacklist && sweepBlacklist) {
                void sweepBlacklist().catch((error) => logger.error('Blacklist sweep failed', { error: String(error) }))
            }
        }
        return true
    }

    /** Polls a long-running job and, once it is done, sends its replies to the chat that asked (quoting the command). */
    async function followJob(message: ChatMessage, jobId: string): Promise<void> {
        if (!tox.fetchJob) return
        const deadline = Date.now() + jobMaxWaitMs
        try {
            while (Date.now() < deadline) {
                await sleep(jobPollMs)
                let job
                try {
                    job = await tox.fetchJob(jobId)
                } catch (error) {
                    logger.warn('Could not check a job, will retry', { error: String(error) })
                    continue
                }
                if (job === null) break // the API forgot it (it restarted, or it expired)
                if (job.status === 'done') {
                    await deliver(message, job.replies)
                    return
                }
            }
            await sendText(message.chatJid, JOB_LOST_REPLY, { quoteRef: message.quoteRef })
        } catch (error) {
            logger.error('Could not deliver a job result', { chat: message.chatJid, error: String(error) })
        }
    }

    const personal = config.mode === 'personal'

    // --- History: the text of the chats that have it turned on (!h, .b h) goes to the API, in both modes. ---
    const HISTORY_REFRESH_MS = 15_000
    const OWN_REPLY_MEMORY_MS = 2 * 60_000
    let historyChats = new Set<string>()
    let historyFetchedAt = 0
    // Personal mode: what the bot itself just wrote (as the owner) comes back as a message of the owner, which is not
    // theirs to save. (In the groups mode the bot's own messages are simply never looked at.)
    const ownReplies = new Map<string, number>()

    function rememberOwnReply(chatJid: string, text: string): void {
        const now = Date.now()
        for (const [key, at] of ownReplies) if (now - at > OWN_REPLY_MEMORY_MS) ownReplies.delete(key)
        ownReplies.set(`${chatJid}\n${text}`, now)
    }

    async function saveIfWanted(message: ChatMessage, selfIds: string[]): Promise<void> {
        const text = message.text.trim()
        if (!text || !message.messageId || !tox.fetchHistoryChats || !tox.saveHistory) return
        // A command is not conversation (".b res", "!claude ...")
        if (personal ? text.toLowerCase().startsWith(PERSONAL_PREFIX) : startsWithPrefix(text)) return
        if (message.fromMe) {
            if (!personal) return // the bot's own words
            if (ownReplies.delete(`${message.chatJid}\n${message.text}`)) return // its answer, back as the owner's message
        }

        if (Date.now() - historyFetchedAt > HISTORY_REFRESH_MS) {
            historyChats = new Set(await tox.fetchHistoryChats())
            historyFetchedAt = Date.now()
        }
        const chatId = [message.chatJid, message.chatAltJid].find((id) => id && historyChats.has(id))
        if (!chatId) return

        const sender = message.fromMe ? (selfIds.find((id) => id.endsWith('@lid')) ?? selfIds[0]) : stripDevice(message.senderJid)
        if (!sender) return
        const entry: ToxHistoryMessage = {
            chat_id: chatId,
            message_id: message.messageId,
            sender_id: sender,
            sender_name: message.senderName ?? (message.fromMe ? 'Yo' : undefined),
            text: message.text,
            sent_at: new Date(message.sentAtMs ?? Date.now()).toISOString()
        }
        await tox.saveHistory([entry])
    }

    /** Who the sender is. In the personal mode every command is the owner's own message, and in a private chat WhatsApp
     * names the OTHER person as its "sender": the owner is the account itself, in the LID form groups use for them. */
    function senderOf(message: ChatMessage, selfIds: string[]): string | undefined {
        if (!personal) return stripDevice(message.senderJid)
        return selfIds.find((id) => id.endsWith('@lid')) ?? selfIds[0]
    }

    return async function handleMessage(message: ChatMessage): Promise<void> {
        const text = message.text.trim()
        // Before (and apart from) the commands: every message of a chat with history on, whoever wrote it.
        void saveIfWanted(message, (getSelfJids?.() ?? []).map(stripDevice)).catch((error) =>
            logger.warn('Could not save a message of the history', { error: String(error) })
        )
        if (personal) {
            // Only what the owner types, as ".b <command>", in a private chat or in a group they listed: nothing else
            // ever reaches the API.
            if (!message.fromMe || !text.toLowerCase().startsWith(PERSONAL_PREFIX)) return
            if (message.isGroup) {
                if (!config.personalGroupJids.has(message.chatJid)) {
                    logger.info('Ignoring a command from a group that is not listed (add it to PERSONAL_GROUP_JIDS)', {
                        chat: message.chatJid
                    })
                    return
                }
            } else if (!isPrivateChat(message.chatJid)) return
        } else {
            if (message.fromMe) return
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
        }

        const selfIds = (getSelfJids?.() ?? []).map(stripDevice)
        const senderId = senderOf(message, selfIds)
        if (!senderId) {
            logger.warn('Ignoring a personal command: the own account is not known yet')
            return
        }
        const selfJids = new Set(selfIds)
        let replies: ToxReply[]
        try {
            const image = await loadImage(message)
            const group = await inspectGroup(message, senderId)
            replies = await tox.sendMessage({
                platform: 'whatsapp',
                chat_id: message.chatJid,
                user_id: senderId,
                user_name: message.senderName,
                // ".B x" is accepted too; the API only knows the lowercase prefix.
                text: personal ? PERSONAL_PREFIX + text.slice(PERSONAL_PREFIX.length) : text,
                is_group: message.isGroup,
                ...(personal ? { personal: true } : {}),
                ...(personal && message.chatAltJid ? { chat_aliases: [stripDevice(message.chatAltJid)] } : {}),
                participants: group.participants,
                sender_is_group_admin: group.senderIsGroupAdmin,
                mentioned: message.mentionedJids?.length
                    ? message.mentionedJids.map((jid) => {
                          const id = stripDevice(jid)
                          // What the roster knows about the tagged person (their other ids, whether they administer the
                          // group): moderation commands rely on it. Absent when the roster couldn't be read.
                          const member = group.roster?.find((m) => [m.userId, ...m.aliases].includes(id))
                          return {
                              user_id: id,
                              // In the personal mode the own account is the owner, not a bot someone tagged.
                              ...(!personal && selfJids.has(id) ? { is_bot: true } : {}),
                              ...(member
                                  ? { user_name: member.name, aliases: member.aliases, is_group_admin: Boolean(member.isAdmin) }
                                  : {})
                          }
                      })
                    : undefined,
                ...(message.quoted ? { quoted: quotedOf(message.quoted, selfJids, personal) } : {}),
                ...(image ? { image: Buffer.from(image).toString('base64') } : {})
            })
        } catch (error) {
            logger.error('Tox API call failed', { error: error instanceof ToxApiError ? error.message : String(error) })
            replies = [{ text: API_DOWN_REPLY, mentions: [] }]
        }

        // A command may have turned the history of this chat on or off: look at the list again with the next message.
        historyFetchedAt = 0
        if (!(await deliver(message, replies))) return
        // A long-running command (!claude) answered with just a reaction: the real answer is picked up when it is ready,
        // without holding this handler (other commands keep working meanwhile).
        for (const reply of replies) {
            if (reply.job) void followJob(message, reply.job)
        }
    }
}
