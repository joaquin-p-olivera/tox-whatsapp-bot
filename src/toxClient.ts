export interface ToxParticipant {
    user_id: string
    user_name?: string
    /** Other IDs of the same person (LID / phone number): lets the API match mutes across both forms. */
    aliases?: string[]
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
}

export interface ToxReply {
    text: string
    /** Users referenced by `{@0}`, `{@1}`... placeholders in `text`. */
    mentions: ToxParticipant[]
    /** Name of an audio to send (download it with `fetchAudio`). */
    audio?: string
}

export interface ToxAudio {
    data: Uint8Array
    /** Straight from the API's Content-Type, e.g. "audio/mp4" or "audio/ogg; codecs=opus". */
    mimetype: string
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
            ...(reply.audio ? { audio: reply.audio } : {})
        }))
    }

    /** Downloads a sound clip served by the API. */
    async fetchAudio(name: string): Promise<ToxAudio> {
        let response: Response
        try {
            response = await this.fetchImpl(`${this.baseUrl}/api/v1/audios/${encodeURIComponent(name)}`, {
                headers: { 'x-api-key': this.apiKey },
                signal: AbortSignal.timeout(this.timeoutMs)
            })
        } catch (error) {
            throw new ToxApiError(`Tox API unreachable: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!response.ok) {
            throw new ToxApiError(`Tox API responded ${response.status} for audio "${name}"`)
        }
        return {
            data: new Uint8Array(await response.arrayBuffer()),
            mimetype: response.headers.get('content-type') ?? 'audio/mp4'
        }
    }
}
