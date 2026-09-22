// End-to-end: real zapo-js client <-> in-process fake WhatsApp server (real Noise/Signal
// crypto, no phone or network) <-> real ToxClient <-> a stub of the Tox HTTP API.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'

import { FakeWaServer, parsePairingQrString, type FakePeer } from '@zapo-js/fake-server'
import { ConsoleLogger, createStore } from 'zapo-js'
import type { WaFakeConnectionPipeline } from '@zapo-js/fake-server'

import { createBot, type Bot } from '../src/whatsapp.ts'
import { makeConfig } from './helpers.ts'

const GROUP = '120363000000000001@g.us'
const BOT = '59800000000:1@s.whatsapp.net'
const ALICE = '59899111111@s.whatsapp.net'
const BOB = '59899222222@s.whatsapp.net'

let whatsapp: FakeWaServer
let api: Server
let bot: Bot
let pipeline: WaFakeConnectionPipeline
// Created once: the bot hands its group key to each member only the first time it writes to the group.
let alice: FakePeer
let bob: FakePeer
const apiRequests: Record<string, unknown>[] = []
const audioRequests: { url: string; apiKey?: string }[] = []
const FAKE_M4A = Buffer.from('not-really-an-m4a-but-bytes-are-bytes'.repeat(20))

before(async () => {
    // Stub of the Tox API: "!ping" -> pong, "!m" -> mentions the first participant it was given,
    // "!fail" -> 500, anything else -> no reply.
    api = createServer((req, res) => {
        // GET /api/v1/audios/<name>: serve a fake m4a
        if (req.method === 'GET' && req.url?.startsWith('/api/v1/audios/')) {
            audioRequests.push({ url: req.url, apiKey: req.headers['x-api-key'] as string | undefined })
            res.setHeader('content-type', req.url.endsWith('.ogg') ? 'audio/ogg; codecs=opus' : 'audio/mp4')
            res.end(FAKE_M4A)
            return
        }
        let raw = ''
        req.on('data', (chunk) => (raw += chunk))
        req.on('end', () => {
            const body = JSON.parse(raw)
            apiRequests.push({ ...body, apiKey: req.headers['x-api-key'] })
            res.setHeader('content-type', 'application/json')
            if (body.text === '!fail') {
                res.statusCode = 500
                res.end('{}')
                return
            }
            if (body.text === '!voz') {
                res.end(JSON.stringify({ replies: [{ text: '', mentions: [], audio: '1.ogg' }] }))
                return
            }
            if (body.text === '!audio') {
                res.end(JSON.stringify({ replies: [{ text: '', mentions: [], audio: 'risa.m4a' }] }))
                return
            }
            if (body.text === '!m') {
                const [target] = body.participants ?? []
                res.end(JSON.stringify({ replies: target ? [{ text: 'y tu mamá donde está? {@0}', mentions: [target] }] : [] }))
                return
            }
            res.end(JSON.stringify({ replies: body.text === '!ping' ? [{ text: 'pong' }] : [] }))
        })
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    const { port } = api.address() as AddressInfo

    whatsapp = await FakeWaServer.start()
    const config = makeConfig({ toxApiUrl: `http://127.0.0.1:${port}`, toxApiKey: 'e2e-key', botPhoneNumber: null })
    bot = createBot(config, new ConsoleLogger((process.env.E2E_LOG as 'debug' | undefined) ?? 'error'), {
        // In-memory store: every run starts unpaired and leaves nothing on disk.
        store: createStore({}),
        clientOptions: {
            chatSocketUrls: [whatsapp.url],
            testHooks: { noiseRootCa: whatsapp.noiseRootCa },
            proxy: { mediaUpload: whatsapp.mediaProxyAgent, mediaDownload: whatsapp.mediaProxyAgent }
        }
    })

    // Pair the (unpaired) bot the way a phone would. runPairing makes the server push
    // pair-device; the client turns it into a QR (auth_qr), whose keys we hand back to the
    // server; the client then reconnects as a registered device.
    const registration = whatsapp.waitForAuthenticatedPipeline()
    const qrKeys = new Promise<ReturnType<typeof parsePairingQrString>>((resolve) => {
        bot.client.once('auth_qr', ({ qr }) => resolve(parsePairingQrString(qr)))
    })
    await bot.connect()
    const registrationPipeline = await registration
    const paired = whatsapp.waitForNextAuthenticatedPipeline()
    await whatsapp.runPairing(registrationPipeline, { deviceJid: BOT }, async () => {
        const { advSecretKey, identityPublicKey } = await qrKeys
        return { advSecretKey, identityPublicKey }
    })
    pipeline = await paired
    // Peers encrypt to the bot, so the server needs the bot's prekey bundle first.
    await whatsapp.triggerPreKeyUpload(pipeline)

    alice = await whatsapp.createFakePeer({ jid: ALICE, displayName: 'Alice' }, pipeline)
    bob = await whatsapp.createFakePeer({ jid: BOB, displayName: 'Bob' }, pipeline)
    whatsapp.createFakeGroup({ groupJid: GROUP, subject: 'Friends', participants: [alice, bob] })
})

after(async () => {
    await bot?.stop()
    await whatsapp?.stop()
    await new Promise((resolve) => api?.close(resolve))
})

test('answers !ping in a group with pong', async () => {

    await alice.sendGroupConversation(GROUP, '!ping')
    const reply = await bob.expectGroupMessage(GROUP, { senderJid: BOT, timeoutMs: 10_000 })

    assert.equal(reply.message.conversation ?? reply.message.extendedTextMessage?.text, 'pong')
    const request = apiRequests.find((r) => r.text === '!ping')
    assert.ok(request, 'the API received the command')
    assert.equal(request.platform, 'whatsapp')
    assert.equal(request.chat_id, GROUP)
    assert.equal(request.is_group, true)
    assert.equal(request.apiKey, 'e2e-key')
    assert.match(String(request.user_id), /^59899111111/)
})

test('does not call the API for ordinary chat', async () => {
    const before = apiRequests.length
    await alice.sendGroupConversation(GROUP, 'good morning everyone')
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(apiRequests.length, before)
})

test('!m: reads the group members, excludes the sender and sends a real mention', async () => {

    await alice.sendGroupConversation(GROUP, '!m')
    const reply = await bob.expectGroupMessage(GROUP, { senderJid: BOT, timeoutMs: 10_000 })

    const request = apiRequests.findLast((r) => r.text === '!m')
    const participants = (request?.participants ?? []) as { user_id: string }[]
    assert.deepEqual(participants.map((p) => p.user_id), [BOB], 'only Bob: the sender (Alice) is excluded')

    const text = reply.message.extendedTextMessage?.text ?? reply.message.conversation
    assert.equal(text, 'y tu mamá donde está? @59899222222')
    assert.deepEqual(reply.message.extendedTextMessage?.contextInfo?.mentionedJid, [BOB])
})

test('an audio reply: downloads it from the API and delivers it to the group', async () => {
    await alice.sendGroupConversation(GROUP, '!audio')
    const reply = await bob.expectGroupMessage(GROUP, { senderJid: BOT, timeoutMs: 15_000 })

    assert.deepEqual(audioRequests.map((r) => [r.url, r.apiKey]), [['/api/v1/audios/risa.m4a', 'e2e-key']])
    const audio = reply.message.audioMessage
    assert.ok(audio, 'Bob received an audioMessage')
    assert.equal(audio.mimetype, 'audio/mp4')
    assert.equal(Number(audio.fileLength), FAKE_M4A.length)
    assert.notEqual(audio.ptt, true, 'm4a goes out as a regular audio file, not as a voice note')
})

test('an Ogg/Opus audio reply is delivered as a voice note (ptt)', async () => {
    await alice.sendGroupConversation(GROUP, '!voz')
    const reply = await bob.expectGroupMessage(GROUP, { senderJid: BOT, timeoutMs: 15_000 })

    const audio = reply.message.audioMessage
    assert.ok(audio, 'Bob received an audioMessage')
    assert.equal(audio.ptt, true, 'Ogg/Opus goes out as a voice note')
    assert.match(String(audio.mimetype), /^audio\/ogg/)
})
