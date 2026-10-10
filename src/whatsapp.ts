import { ConsoleLogger, createStore, downloadMediaMessage, WaClient, type Proto, type WaClientOptions, type WaGroupMetadata, type WaIncomingMessageEvent, type WaStore } from 'zapo-js'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { BlacklistEntry } from './blacklist.ts'
import type { Config } from './config.ts'
import { findBlacklisted, type SweepMember } from './blacklist.ts'
import { createMessageHandler, renderMentions, stripDevice, type ChatMessage, type GroupMember, type HandlerLogger } from './messageHandler.ts'
import { findPrivateLink } from './links.ts'
import { createPairingController } from './pairing.ts'
import { ToxClient } from './toxClient.ts'

export interface BotOptions {
    /** Overrides for WaClient (used by tests to point at the fake server). */
    clientOptions?: Partial<WaClientOptions>
    /** Replaces the persistent SQLite store (tests use an in-memory one). */
    store?: WaStore
    tox?: Pick<ToxClient, 'sendMessage' | 'fetchAudio' | 'fetchSticker' | 'fetchImage' | 'fetchPendingAlerts' | 'fetchBlacklist'>
}

export interface Bot {
    client: WaClient
    connect(): Promise<void>
    stop(): Promise<void>
}

const MAX_RECONNECT_ATTEMPTS = 10

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

/** Pictures bigger than this are not forwarded (the API's own limit is a little higher once base64-encoded). */
export const MAX_IMAGE_BYTES = 5_000_000

/** The message holding the picture: the one itself (an image sent with the command as caption) or the one it replies to. */
export function imageSource(message?: Proto.IMessage | null, event?: WaIncomingMessageEvent): Proto.IMessage | WaIncomingMessageEvent | undefined {
    if (message?.imageMessage) return event ?? message
    const quoted = message?.extendedTextMessage?.contextInfo?.quotedMessage
    return quoted?.imageMessage ? quoted : undefined
}

async function downloadImage(source: Proto.IMessage | WaIncomingMessageEvent): Promise<Uint8Array | undefined> {
    const stream = await downloadMediaMessage(source)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of stream) {
        size += chunk.length
        if (size > MAX_IMAGE_BYTES) {
            stream.destroy()
            return undefined
        }
        chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
}

export function toChatMessage(event: WaIncomingMessageEvent): ChatMessage | null {
    const text = extractText(event.message)
    if (!text) return null
    const { key } = event
    const source = imageSource(event.message, event)
    return {
        chatJid: key.remoteJid,
        // In groups the sender is the participant; in 1:1 chats it is the chat itself.
        senderJid: key.participant ?? key.remoteJid,
        senderAltJid: key.participantAlt ?? key.remoteJidAlt,
        senderName: event.pushName ?? undefined,
        text,
        mentionedJids: [...(event.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [])],
        isGroup: key.isGroup,
        fromMe: key.fromMe,
        quoteRef: event,
        ...(source ? { getImage: () => downloadImage(source) } : {})
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

    // Deliberately NOT cached: who administers a group can change at any moment, and the API trusts this roster to
    // decide who may run admin-only commands, so it is read from WhatsApp for every command sent in a group.
    async function getGroupMembers(chatJid: string): Promise<GroupMember[]> {
        const credentials = client.getCredentials()
        const myIds = new Set([credentials?.meJid, credentials?.meLid].filter((id): id is string => !!id).map(stripDevice))
        const metadata = await client.group.queryGroupMetadata(chatJid)
        const members = metadata.participants
            .map((participant) => {
                const ids = [participant.jid, participant.lid, participant.phoneNumber]
                    .filter((id): id is string => !!id)
                    .map(stripDevice)
                return {
                    userId: stripDevice(participant.jid),
                    aliases: ids,
                    name: participant.displayName,
                    isAdmin: participant.isAdmin || participant.isSuperAdmin
                }
            })
            // The bot itself is in the group but must never be mentioned.
            .filter((member) => !member.aliases.some((id) => myIds.has(id)))
        return members
    }

    /** Removes members from a group, given the ids the API knows them under. Throws unless every one was removed. */
    async function removeMembers(chatJid: string, userIds: string[]): Promise<void> {
        const members = await getGroupMembers(chatJid)
        const jids = userIds.map((id) => {
            const member = members.find((m) => [m.userId, ...m.aliases].includes(id))
            if (!member) throw new Error(`${id} is not in the group`)
            return member.userId
        })
        const results = await client.group.removeParticipants(chatJid, jids)
        const failed = results.filter((result) => result.status !== 'ok')
        if (failed.length > 0) throw new Error(`WhatsApp refused: ${failed.map((r) => `${r.jid} (${r.code})`).join(', ')}`)
    }

    /** Removes everyone of the blacklist who is in this group. Returns who was removed. A group where the bot is not an
     * admin is skipped with a warning (nothing else to do there). */
    async function sweepGroup(chatJid: string, blacklist: BlacklistEntry[]): Promise<SweepMember[]> {
        return sweepMetadata(await client.group.queryGroupMetadata(chatJid), blacklist)
    }

    async function sweepMetadata(metadata: WaGroupMetadata, blacklist: BlacklistEntry[]): Promise<SweepMember[]> {
        const chatJid = metadata.jid
        const members: SweepMember[] = metadata.participants.map((participant) => ({
            jid: participant.jid,
            ids: [participant.jid, participant.lid, participant.phoneNumber].filter((id): id is string => !!id).map(stripDevice)
        }))
        const banned = findBlacklisted(members, blacklist)
        if (banned.length === 0) return []
        try {
            const results = await client.group.removeParticipants(chatJid, banned.map((m) => m.jid))
            const removed = banned.filter((m) => results.find((r) => r.jid === m.jid)?.status !== 'error')
            logger.info('Blacklist: removed members', { chat: chatJid, removed: removed.length, wanted: banned.length })
            return removed
        } catch (error) {
            logger.warn('Blacklist: could not remove members (is the bot an admin there?)', { chat: chatJid, error: String(error) })
            return []
        }
    }

    async function sweepAllGroups(): Promise<void> {
        const blacklist = await tox.fetchBlacklist()
        if (blacklist.length === 0) return
        for (const group of await client.group.queryAllGroups()) {
            await sweepMetadata(group, blacklist).catch((error) =>
                logger.warn('Blacklist: could not check a group', { error: String(error) })
            )
        }
    }

    const handleMessage = createMessageHandler({
        config,
        tox,
        logger: logger as HandlerLogger,
        getGroupMembers,
        removeMembers,
        sweepBlacklist: sweepAllGroups,
        getSelfJids: () => {
            const credentials = client.getCredentials()
            return [credentials?.meJid, credentials?.meLid].filter((id): id is string => !!id)
        },
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
        sendReaction: async (chatJid, emoji, target) => {
            await client.message.send(chatJid, { type: 'reaction', emoji, target: target as WaIncomingMessageEvent })
        },
        sendText: async (chatJid, text, { quoteRef, mentionJids } = {}) => {
            // A URL on a private address (e.g. !fred's http://192.168.1.21:5200) only becomes tappable if the message carries
            // it as link data, which the plain-string form never does (see links.ts): use the object form for those.
            const link = findPrivateLink(text)
            const content = link ? { type: 'text' as const, text, linkPreview: { matchedText: link, title: new URL(link).host } } : text
            await client.message.send(chatJid, content, {
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

    // Someone (re)joined a group: if they are on the blacklist they are taken out again right away.
    client.on('group', (event) => {
        const chatJid = event.groupJid ?? event.chatJid
        if (event.action !== 'add' || !chatJid) return
        void (async () => {
            const blacklist = await tox.fetchBlacklist()
            if (blacklist.length === 0) return
            const removed = await sweepGroup(chatJid, blacklist)
            if (removed.length > 0 && (config.allowedGroupJids.size === 0 || config.allowedGroupJids.has(chatJid))) {
                await client.message.send(chatJid, '⛔ Estaba en la lista negra: lo saqué del grupo.')
            }
        })().catch((error) => logger.error('Blacklist check on join failed', { error: String(error) }))
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
            // Anyone blacklisted who joined a group while the bot was offline.
            void sweepAllGroups().catch((error) => logger.warn('Blacklist sweep on connect failed', { error: String(error) }))
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
