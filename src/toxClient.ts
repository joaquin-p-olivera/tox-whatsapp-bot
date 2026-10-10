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
    /** Base64 of the picture the message carries or replies to, when there is one (e.g. for !sticker). */
    image?: string
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
export interface PendingAlert {
    chat_id: string
    text: string
    mentions: ToxParticipant[]
}

export class ToxApiError extends Error {}

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
        return body.replies.map((reply) => ({
            text: reply.text,
            mentions: reply.mentions ?? [],
            ...(reply.audio ? { audio: reply.audio } : {}),
            ...(reply.sticker ? { sticker: reply.sticker } : {}),
            ...(reply.image ? { image: reply.image } : {}),
            ...(reply.reaction ? { reaction: reply.reaction } : {}),
            ...(reply.remove?.length ? { remove: reply.remove } : {}),
            ...(reply.sweep_blacklist ? { sweep_blacklist: true } : {})
        }))
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

    /** Everyone permanently banned (!permaban). Read-only: the same list comes back every time. */
    async fetchBlacklist(): Promise<BlacklistEntry[]> {
        const response = await this.get('/api/v1/blacklist?platform=whatsapp', 'blacklist')
        return (await response.json()) as BlacklistEntry[]
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
