import type { Config } from './config.ts'
import { ToxApiError, type ToxAudio, type ToxClient, type ToxHistoryMessage, type ToxImage, type ToxParticipant, type ToxQuoted, type ToxReply, type ToxSticker, type ToxVideo } from './toxClient.ts'

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
export type SendVideo = (chatJid: string, video: ToxVideo, options?: SendOptions) => Promise<void>
/** An empty `emoji` revokes the reaction the bot left on that message. */
export type SendReaction = (chatJid: string, emoji: string, target: unknown) => Promise<void>
/** Removes members (by the ids the API knows them under) from a group. Throws when it can't (e.g. the bot is not an admin). */
export type RemoveMembers = (chatJid: string, userIds: string[]) => Promise<void>
/** Deletes a message for everyone (!censura). Throws when WhatsApp refuses, which is what happens to somebody
 * else's message when the bot is not an admin of the group. */
export type DeleteMessage = (chatJid: string, target: unknown) => Promise<void>
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
/** Said once per group (per run): a censored message could not be deleted, and silence would look like the
 * censorship simply not working. */
export const CENSORSHIP_FAILED_REPLY = '⚠️ No pude borrar el mensaje de alguien que está censurado. ¿Soy admin del grupo?'

interface Deps {
    config: Config
    tox: Pick<ToxClient, 'sendMessage' | 'fetchAudio' | 'fetchSticker' | 'fetchImage' | 'fetchVideo'> &
        Partial<Pick<ToxClient, 'fetchJob' | 'fetchHistoryChats' | 'saveHistory' | 'fetchCensored'>>
    sendText: SendText
    sendAudio: SendAudio
    sendSticker: SendSticker
    sendImage: SendImage
    sendVideo: SendVideo
    sendReaction: SendReaction
    logger: HandlerLogger
    /** Optional: lets the API pick a random member. Failures are tolerated. */
    getGroupMembers?: GetGroupMembers
    /** Optional: removes members from the group (!ban). Without it the removal is reported as not possible. */
    removeMembers?: RemoveMembers
    /** Optional: removes everyone on the blacklist from every group the bot is in (!permaban). Failures are logged. */
    sweepBlacklist?: () => Promise<void>
    /** Optional: deletes a message for everyone (!censura). Without it nothing is ever deleted. */
    deleteMessage?: DeleteMessage
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

/** Whether the message replies to one of the bot's own messages. That is another way of asking Claude (the API decides,
 * see CLAUDE_ON_REPLY): no prefix needed, the reply itself is the question. WhatsApp names the author of the quoted
 * message in groups; when it doesn't, the reply is treated as ordinary chatter. */
function repliesToBot(message: ChatMessage, selfJids: Set<string>): boolean {
    const author = message.quoted?.senderJid
    return Boolean(author && selfJids.has(stripDevice(author)))
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

export function createMessageHandler({ config, tox, sendText, sendAudio, sendSticker, sendImage, sendVideo, sendReaction, logger, getGroupMembers, getSelfJids, removeMembers, sweepBlacklist, deleteMessage, jobPollMs = 2_000, jobMaxWaitMs = 15 * 60_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: Deps) {
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
            const hasMedia = Boolean(reply.audio) || Boolean(reply.sticker) || Boolean(reply.image) || Boolean(reply.video)
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
                if (reply.reaction !== undefined) {
                    // Always reacts to the command message itself, whichever reply of the list carries it. An empty
                    // emoji takes the reaction off again (that is how !claude clears its ⏳ once the answer is sent).
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
                if (reply.video) {
                    await sendVideo(message.chatJid, await tox.fetchVideo(reply.video), { quoteRef })
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

    /** The chats the API keeps the history of, looked up again at most every HISTORY_REFRESH_MS. */
    async function refreshHistoryChats(): Promise<void> {
        if (!tox.fetchHistoryChats || Date.now() - historyFetchedAt <= HISTORY_REFRESH_MS) return
        historyChats = new Set(await tox.fetchHistoryChats())
        historyFetchedAt = Date.now()
    }

    /** Whether this chat is one of those, which is also the only kind the API can read: ordinary chatter is forwarded
     * from those alone, since they are the only ones it has any context to butt into. */
    function historyIsOn(message: ChatMessage): boolean {
        return [message.chatJid, message.chatAltJid].some((id) => !!id && historyChats.has(id))
    }

    // --- Censorship: whose messages are deleted on sight (!censura). Groups mode only. ---
    // Polled like the history list, and for the same reason: a censored person's ordinary chatter never reaches the
    // API unless that chat has history on, so the deletion cannot be the API's answer to a forwarded message.
    const CENSORED_REFRESH_MS = 15_000
    let censoredChats = new Map<string, Set<string>>()
    let censoredFetchedAt = 0
    // Groups already told the bot cannot delete, so the notice is not repeated with every message.
    const warnedCannotDelete = new Set<string>()

    async function refreshCensored(): Promise<void> {
        if (!tox.fetchCensored || Date.now() - censoredFetchedAt <= CENSORED_REFRESH_MS) return
        try {
            censoredChats = new Map((await tox.fetchCensored()).map((entry) => [entry.chat_id, new Set(entry.user_ids)]))
            censoredFetchedAt = Date.now()
        } catch (error) {
            // The last list stays in force: an API restart must not quietly lift everyone's censorship. Until the
            // first successful read it is empty, so nothing is deleted on a guess.
            logger.warn('Could not read who is censored; keeping the last list', { error: String(error) })
        }
    }

    /** Whether this message is from somebody under censorship in this chat, under any of their ids. */
    function isCensored(message: ChatMessage): boolean {
        const here = [message.chatJid, message.chatAltJid].flatMap((chat) => {
            const censored = chat ? censoredChats.get(chat) : undefined
            return censored ? [censored] : []
        })
        const sender = [message.senderJid, message.senderAltJid].filter((jid): jid is string => !!jid).map(stripDevice)
        return here.some((censored) => sender.some((id) => censored.has(id)))
    }

    /** Deletes the message and reports whether it is gone. The group is told once per run when it cannot be done,
     * since otherwise the censorship would look broken for no visible reason. */
    async function censor(message: ChatMessage): Promise<void> {
        try {
            if (!deleteMessage) throw new Error('deleting messages is not available')
            await deleteMessage(message.chatJid, message.quoteRef)
            logger.info('Censored: message deleted', { chat: message.chatJid, sender: stripDevice(message.senderJid) })
        } catch (error) {
            logger.warn('Could not delete the message of a censored user (is the bot an admin there?)', {
                chat: message.chatJid,
                error: String(error)
            })
            if (warnedCannotDelete.has(message.chatJid)) return
            warnedCannotDelete.add(message.chatJid)
            await sendText(message.chatJid, CENSORSHIP_FAILED_REPLY).catch((sendError) =>
                logger.warn('Could not say that the message could not be deleted', { error: String(sendError) })
            )
        }
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

        await refreshHistoryChats()
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
        const selfIds = (getSelfJids?.() ?? []).map(stripDevice)
        const selfJids = new Set(selfIds)
        // Nobody asked the bot anything with this message: it is forwarded for the API to read, not to act on.
        let chatter = false
        // Censorship comes before everything else, the history included: a message that is being deleted is not
        // conversation to save, and a command from a censored person is not a command to run.
        if (!personal && message.isGroup && !message.fromMe) {
            await refreshCensored()
            if (isCensored(message)) {
                await censor(message)
                return
            }
        }
        // Before (and apart from) the commands: every message of a chat with history on, whoever wrote it.
        void saveIfWanted(message, selfIds).catch((error) =>
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
            // Cheap local filter: a command, or a reply to the bot (a question for Claude, prefix or not), always goes
            // to the API. So does ordinary chatter of a group whose history is on, which is the only thing the API can
            // read: now and then it butts in with a remark of its own (CLAUDE_INTERJECT_CHANCE), and otherwise says
            // nothing. Anything else stops here.
            if (!text) return
            chatter = !startsWithPrefix(text) && !repliesToBot(message, selfJids)
            if (chatter) {
                if (!message.isGroup) return
                await refreshHistoryChats()
                if (!historyIsOn(message)) return
            }

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

        const senderId = senderOf(message, selfIds)
        if (!senderId) {
            logger.warn('Ignoring a personal command: the own account is not known yet')
            return
        }
        let replies: ToxReply[]
        try {
            // Chatter is forwarded to be read: downloading the picture of every photo somebody sends would be waste.
            const image = chatter ? undefined : await loadImage(message)
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

        // A command may have turned the history of this chat on or off, or censored somebody: look at both lists
        // again with the next message instead of waiting for them to go stale.
        historyFetchedAt = 0
        censoredFetchedAt = 0
        if (!(await deliver(message, replies))) return
        // A long-running command (!claude) answered with just a reaction: the real answer is picked up when it is ready,
        // without holding this handler (other commands keep working meanwhile).
        for (const reply of replies) {
            if (reply.job) void followJob(message, reply.job)
        }
    }
}
