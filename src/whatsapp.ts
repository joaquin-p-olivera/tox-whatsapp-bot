import { ConsoleLogger, createStore, WaClient, type Proto, type WaClientOptions, type WaIncomingMessageEvent, type WaStore } from 'zapo-js'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Config } from './config.ts'
import { createMessageHandler, renderMentions, stripDevice, type ChatMessage, type GroupMember, type HandlerLogger } from './messageHandler.ts'
import { createPairingController } from './pairing.ts'
import { ToxClient } from './toxClient.ts'

export interface BotOptions {
    /** Overrides for WaClient (used by tests to point at the fake server). */
    clientOptions?: Partial<WaClientOptions>
    /** Replaces the persistent SQLite store (tests use an in-memory one). */
    store?: WaStore
    tox?: Pick<ToxClient, 'sendMessage' | 'fetchAudio' | 'fetchSticker' | 'fetchImage' | 'fetchPendingAlerts'>
}

export interface Bot {
    client: WaClient
    connect(): Promise<void>
    stop(): Promise<void>
}

const MAX_RECONNECT_ATTEMPTS = 10
// Group rosters change rarely; refreshing at most this often avoids a query on every command.
const GROUP_MEMBERS_TTL_MS = 5 * 60_000

/** Text lives in different fields depending on the message type. */
export function extractText(message?: Proto.IMessage | null): string | undefined {
    if (!message) return undefined
    return (
        message.conversation ??
        message.extendedTextMessage?.text ??
        message.imageMessage?.caption ??
        message.videoMessage?.caption ??
        undefined
    )
}

export function toChatMessage(event: WaIncomingMessageEvent): ChatMessage | null {
    const text = extractText(event.message)
    if (!text) return null
    const { key } = event
    return {
        chatJid: key.remoteJid,
        // In groups the sender is the participant; in 1:1 chats it is the chat itself.
        senderJid: key.participant ?? key.remoteJid,
        senderAltJid: key.participantAlt ?? key.remoteJidAlt,
        senderName: event.pushName ?? undefined,
        text,
        isGroup: key.isGroup,
        fromMe: key.fromMe,
        quoteRef: event
    }
}

function createPersistentStore(config: Config): WaStore {
    mkdirSync(config.authDir, { recursive: true, mode: 0o700 })
    return createStore({
        backends: { sqlite: createSqliteStore({ path: join(config.authDir, 'state.sqlite') }) },
        providers: {
            auth: 'sqlite',
            signal: 'sqlite',
            preKey: 'sqlite',
            session: 'sqlite',
            identity: 'sqlite',
            senderKey: 'sqlite',
            appState: 'sqlite',
            privacyToken: 'sqlite',
            // The bot only reacts to live messages, so no archive is kept.
            messages: 'none',
            threads: 'none',
            contacts: 'none'
        }
    })
}

export function createBot(config: Config, logger: ConsoleLogger, options: BotOptions = {}): Bot {
    const client = new WaClient(
        {
            store: options.store ?? createPersistentStore(config),
            sessionId: config.sessionId,
            recoverFromClientTooOld: true,
            ...options.clientOptions
        },
        logger
    )

    const tox = options.tox ?? new ToxClient(config.toxApiUrl, config.toxApiKey, config.toxApiTimeoutMs)

    const membersCache = new Map<string, { members: GroupMember[]; fetchedAt: number }>()
    async function getGroupMembers(chatJid: string): Promise<GroupMember[]> {
        const cached = membersCache.get(chatJid)
        if (cached && Date.now() - cached.fetchedAt < GROUP_MEMBERS_TTL_MS) return cached.members

        const credentials = client.getCredentials()
        const myIds = new Set([credentials?.meJid, credentials?.meLid].filter((id): id is string => !!id).map(stripDevice))
        const metadata = await client.group.queryGroupMetadata(chatJid)
        const members = metadata.participants
            .map((participant) => {
                const ids = [participant.jid, participant.lid, participant.phoneNumber]
                    .filter((id): id is string => !!id)
                    .map(stripDevice)
                return { userId: stripDevice(participant.jid), aliases: ids, name: participant.displayName }
            })
            // The bot itself is in the group but must never be mentioned.
            .filter((member) => !member.aliases.some((id) => myIds.has(id)))
        membersCache.set(chatJid, { members, fetchedAt: Date.now() })
        return members
    }

    const handleMessage = createMessageHandler({
        config,
        tox,
        logger: logger as HandlerLogger,
        getGroupMembers,
        sendAudio: async (chatJid, { data, mimetype }, { quoteRef } = {}) => {
            await client.message.send(
                chatJid,
                // Ogg/Opus is what WhatsApp shows as a voice note; m4a/mp3 go out as plain audio files.
                { type: 'audio', media: data, mimetype, ptt: mimetype.includes('ogg') },
                quoteRef ? { quote: quoteRef as WaIncomingMessageEvent } : undefined
            )
        },
        sendSticker: async (chatJid, { data, mimetype }, { quoteRef } = {}) => {
            await client.message.send(
                chatJid,
                { type: 'sticker', media: data, mimetype },
                quoteRef ? { quote: quoteRef as WaIncomingMessageEvent } : undefined
            )
        },
        sendImage: async (chatJid, { data, mimetype }, { quoteRef } = {}) => {
            await client.message.send(
                chatJid,
                { type: 'image', media: data, mimetype },
                quoteRef ? { quote: quoteRef as WaIncomingMessageEvent } : undefined
            )
        },
        sendText: async (chatJid, text, { quoteRef, mentionJids } = {}) => {
            await client.message.send(chatJid, text, {
                ...(quoteRef ? { quote: quoteRef as WaIncomingMessageEvent } : {}),
                ...(mentionJids ? { mentions: mentionJids } : {})
            })
        }
    })

    client.on('message', (event) => {
        const message = toChatMessage(event)
        if (message) {
            void handleMessage(message).catch((error) => logger.error('Unhandled error in message handler', { error: String(error) }))
        }
    })

    const pairing = createPairingController({
        phoneNumber: config.botPhoneNumber,
        requestPairingCode: (phoneNumber) => client.auth.requestPairingCode(phoneNumber),
        logger: logger as HandlerLogger
    })
    client.on('auth_qr', () => void pairing.onQr())
    client.on('auth_pairing_required', () => void pairing.onPairingRequired())
    client.on('auth_paired', ({ credentials }) => logger.info('Paired', { as: credentials.meJid }))

    let attempt = 0
    let stopping = false

    async function reconnect(): Promise<void> {
        if (stopping) return
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
            logger.error(`Giving up after ${attempt} reconnection attempts`)
            process.exitCode = 1
            return
        }
        const delayMs = Math.min(30_000, 1_000 * 2 ** attempt)
        attempt += 1
        logger.warn(`Reconnecting in ${delayMs}ms (attempt ${attempt})`)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        if (stopping) return
        try {
            await client.connect()
        } catch (error) {
            logger.error('Reconnect failed', { error: String(error) })
            void reconnect()
        }
    }

    client.on('connection', (event) => {
        if (event.status === 'open') {
            attempt = 0
            logger.info('Connected to WhatsApp', { newLogin: event.isNewLogin })
            return
        }
        if (stopping) return
        if (event.isLogout) {
            // The device was unlinked from the phone: the stored session is useless.
            logger.error('Logged out from the phone. Delete the auth directory and pair again.')
            process.exitCode = 1
            return
        }
        pairing.onConnectionClosed()
        logger.warn('Connection closed', { reason: event.reason, code: event.code })
        void reconnect()
    })

    let alertsTimer: NodeJS.Timeout | undefined
    async function pollAlerts(): Promise<void> {
        try {
            for (const alert of await tox.fetchPendingAlerts()) {
                const { text, mentionJids } = renderMentions({ text: alert.text, mentions: alert.mentions })
                await client.message.send(alert.chat_id, text, mentionJids.length ? { mentions: mentionJids } : undefined)
            }
        } catch (error) {
            logger.error('Could not poll pending alerts', { error: String(error) })
        }
    }

    return {
        client,
        async connect() {
            await client.connect()
            // Proactive alerts (e.g. !service health changes): checked on our own timer, no user message involved.
            alertsTimer = setInterval(() => void pollAlerts(), config.alertsPollIntervalMs)
        },
        async stop() {
            stopping = true
            clearInterval(alertsTimer)
            await client.disconnect()
        }
    }
}
