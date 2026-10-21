import type { BlacklistEntry } from './blacklist.ts'

export interface ToxParticipant {
    user_id: string
    user_name?: string
    /** Other IDs of the same person (LID / phone number): lets the API match mutes across both forms. */
    aliases?: string[]
    /** True when this is the bot itself (someone tagged the bot). */
    is_bot?: boolean
    /** Whether this member administers the group, as read from the roster (moderation commands need it). */
    is_group_admin?: boolean
}

export interface ToxMessage {
    platform: 'whatsapp'
    chat_id: string
    user_id: string
    user_name?: string
    text: string
    is_group: boolean
    /** Full member list, when known. Lets the API pick a random member (e.g. for !m). */
    participants?: ToxParticipant[]
    /** Users the sender tagged with @ in this message (e.g. for !gay). */
    mentioned?: ToxParticipant[]
    /** In a group: whether the sender is an administrator of THAT group (the API requires it for admin-only commands). */
    sender_is_group_admin?: boolean
    /** Other ids of this same chat (a private chat's phone-number and LID forms): one conversation for !h. */
    chat_aliases?: string[]
    /** The bot's personal mode (the owner's own number, a private chat with someone else): the API then expects the
     * `.b command` form, never treats the sender as an admin and refuses what would need a bot to deliver it later. */
    personal?: boolean
    /** The text message this one replies to (!claude hands it to Claude along with the question). */
    quoted?: ToxQuoted
    /** Base64 of the picture (or sticker) the message carries or replies to, when there is one (!sticker, !foto). */
    image?: string
}

export interface ToxQuoted {
    text: string
    /** Who wrote it, in the same form as the senders' ids. */
    user_id?: string
    /** True when the bot itself wrote it. */
    is_bot?: boolean
}

export interface ToxReply {
    text: string
    /** Users referenced by `{@0}`, `{@1}`... placeholders in `text`. */
    mentions: ToxParticipant[]
    /** Name of an audio to send (download it with `fetchAudio`). */
    audio?: string
    /** Id of a generated sticker to send (download it with `fetchSticker`). Short-lived: fetch it right away. */
    sticker?: string
    /** Id of a generated image to send (download it with `fetchImage`), e.g. !futbol -t's table. Short-lived. */
    image?: string
    /** An emoji to react to the command message with (nothing else is sent), e.g. for !uid. */
    reaction?: string
    /** User ids to remove from the chat the command ran in (!ban). The bot must be a group admin there. */
    remove?: string[]
    /** Id of a long-running job (!claude): this reply (a reaction) is delivered now and the bot polls `fetchJob` for the rest. */
    job?: string
    /** Remove everyone on the API's blacklist from every group the bot is in (sent by !permaban). */
    sweep_blacklist?: boolean
}

export interface ToxAudio {
    data: Uint8Array
    /** Straight from the API's Content-Type, e.g. "audio/mp4" or "audio/ogg; codecs=opus". */
    mimetype: string
}

export interface ToxSticker {
    data: Uint8Array
    /** Straight from the API's Content-Type — always "image/webp" today. */
    mimetype: string
}

export interface ToxImage {
    data: Uint8Array
    /** Straight from the API's Content-Type — always "image/png" today. */
    mimetype: string
}

/** A proactive message the bot must send on its own, with no user message behind it.
 * `{@0}`, `{@1}`... in `text` stand for `mentions[0]`, `mentions[1]`..., same as ToxReply. */
/** One chat with people under censorship in it, with every id each of them may appear under (LID, phone number). */
export interface CensoredChat {
    chat_id: string
    user_ids: string[]
}

export interface PendingAlert {
    chat_id: string
    text: string
    mentions: ToxParticipant[]
}

/** A message of a chat that has history turned on (!h), as the API wants it saved. */
export interface ToxHistoryMessage {
    chat_id: string
    message_id: string
    sender_id: string
    sender_name?: string
    text: string
    /** ISO 8601 */
    sent_at: string
}

export class ToxApiError extends Error {}

/** A reply as the API sent it, with only the fields that carry something. */
function normalizeReply(reply: ToxReply): ToxReply {
    return {
        text: reply.text,
        mentions: reply.mentions ?? [],
        ...(reply.audio ? { audio: reply.audio } : {}),
        ...(reply.sticker ? { sticker: reply.sticker } : {}),
        ...(reply.image ? { image: reply.image } : {}),
        // An empty reaction is kept on purpose: it means "take off the reaction you put there" (see sendReaction).
        ...(reply.reaction != null ? { reaction: reply.reaction } : {}),
        ...(reply.job ? { job: reply.job } : {}),
        ...(reply.remove?.length ? { remove: reply.remove } : {}),
        ...(reply.sweep_blacklist ? { sweep_blacklist: true } : {})
    }
}

export interface ToxJob {
    status: 'running' | 'done'
    replies: ToxReply[]
}

interface ToxResponse {
    replies: ToxReply[]
}

/** Thin HTTP client for the Tox API. All command logic lives there. */
export class ToxClient {
    private readonly baseUrl: string
    private readonly apiKey: string
    private readonly timeoutMs: number
    private readonly fetchImpl: typeof fetch

    // No parameter properties: Node runs this file with type stripping only.
    constructor(baseUrl: string, apiKey: string, timeoutMs: number, fetchImpl: typeof fetch = fetch) {
        this.baseUrl = baseUrl
        this.apiKey = apiKey
        this.timeoutMs = timeoutMs
        this.fetchImpl = fetchImpl
    }

    /** Forwards a message and returns the replies to send back (possibly none). */
    async sendMessage(message: ToxMessage): Promise<ToxReply[]> {
        let response: Response
        try {
            response = await this.fetchImpl(`${this.baseUrl}/api/v1/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
                body: JSON.stringify(message),
                signal: AbortSignal.timeout(this.timeoutMs)
            })
        } catch (error) {
            throw new ToxApiError(`Tox API unreachable: ${error instanceof Error ? error.message : String(error)}`)
        }

        if (!response.ok) {
            throw new ToxApiError(`Tox API responded ${response.status}`)
        }
        const body = (await response.json()) as ToxResponse
        return body.replies.map(normalizeReply)
    }

    /** Downloads a sound clip served by the API. */
    async fetchAudio(name: string): Promise<ToxAudio> {
        const response = await this.get(`/api/v1/audios/${encodeURIComponent(name)}`, `audio "${name}"`)
        return { data: new Uint8Array(await response.arrayBuffer()), mimetype: response.headers.get('content-type') ?? 'audio/mp4' }
    }

    /** Downloads a sticker generated by !sticker. Short-lived on the API side: fetch it right after the reply. */
    async fetchSticker(id: string): Promise<ToxSticker> {
        const response = await this.get(`/api/v1/stickers/${encodeURIComponent(id)}`, `sticker "${id}"`)
        return { data: new Uint8Array(await response.arrayBuffer()), mimetype: response.headers.get('content-type') ?? 'image/webp' }
    }

    /** Downloads a generated image (e.g. !futbol -t's table). Short-lived: fetch it right after the reply. */
    async fetchImage(id: string): Promise<ToxImage> {
        const response = await this.get(`/api/v1/images/${encodeURIComponent(id)}`, `image "${id}"`)
        return { data: new Uint8Array(await response.arrayBuffer()), mimetype: response.headers.get('content-type') ?? 'image/png' }
    }

    /** Alerts queued for this platform (e.g. by the API's background !service health check).
     * Fetch-and-delete on the API side: each call only ever returns new ones. */
    async fetchPendingAlerts(): Promise<PendingAlert[]> {
        const response = await this.get('/api/v1/alerts/pending?platform=whatsapp', 'pending alerts')
        return (await response.json()) as PendingAlert[]
    }

    /** State of a long-running job; null when the API no longer knows it (expired, or it restarted). */
    async fetchJob(id: string): Promise<ToxJob | null> {
        let response: Response
        try {
            response = await this.fetchImpl(`${this.baseUrl}/api/v1/jobs/${encodeURIComponent(id)}`, {
                headers: { 'x-api-key': this.apiKey },
                signal: AbortSignal.timeout(this.timeoutMs)
            })
        } catch (error) {
            throw new ToxApiError(`Tox API unreachable: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (response.status === 404) return null
        if (!response.ok) throw new ToxApiError(`Tox API responded ${response.status} for job "${id}"`)
        const body = (await response.json()) as ToxJob
        return { status: body.status, replies: (body.replies ?? []).map(normalizeReply) }
    }

    /** Everyone permanently banned (!permaban). Read-only: the same list comes back every time. */
    async fetchBlacklist(): Promise<BlacklistEntry[]> {
        const response = await this.get('/api/v1/blacklist?platform=whatsapp', 'blacklist')
        return (await response.json()) as BlacklistEntry[]
    }

    /** Who is under censorship (!censura), by chat: every message those people send there is deleted. */
    async fetchCensored(): Promise<CensoredChat[]> {
        const response = await this.get('/api/v1/censored?platform=whatsapp', 'censored users')
        return (await response.json()) as CensoredChat[]
    }

    /** The chat ids (aliases included) that have history turned on: only their messages are worth forwarding. */
    async fetchHistoryChats(): Promise<string[]> {
        const response = await this.get('/api/v1/history/chats?platform=whatsapp', 'history chats')
        return ((await response.json()) as { chats: string[] }).chats
    }

    /** Hands messages of chats with history on to the API (it ignores any chat that is not on). */
    async saveHistory(messages: ToxHistoryMessage[]): Promise<void> {
        let response: Response
        try {
            response = await this.fetchImpl(`${this.baseUrl}/api/v1/history`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
                body: JSON.stringify({ platform: 'whatsapp', messages }),
                signal: AbortSignal.timeout(this.timeoutMs)
            })
        } catch (error) {
            throw new ToxApiError(`Tox API unreachable: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!response.ok) throw new ToxApiError(`Tox API responded ${response.status} saving history`)
    }

    private async get(path: string, what: string): Promise<Response> {
        let response: Response
        try {
            response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                headers: { 'x-api-key': this.apiKey },
                signal: AbortSignal.timeout(this.timeoutMs)
            })
        } catch (error) {
            throw new ToxApiError(`Tox API unreachable: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!response.ok) {
            throw new ToxApiError(`Tox API responded ${response.status} for ${what}`)
        }
        return response
    }
}
