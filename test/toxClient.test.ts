import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ToxApiError, ToxClient, type ToxMessage } from '../src/toxClient.ts'

const message: ToxMessage = { platform: 'whatsapp', chat_id: 'c', user_id: 'u', text: '!ping', is_group: true }

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('posts the message with the API key and returns reply texts', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const client = new ToxClient('http://api', 'secret', 1000, async (url, init) => {
        seen = { url: String(url), init: init as RequestInit }
        return jsonResponse({ replies: [{ text: 'pong' }, { text: 'again' }] })
    })

    assert.deepEqual(await client.sendMessage(message), [
        { text: 'pong', mentions: [] },
        { text: 'again', mentions: [] }
    ])
    assert.equal(seen?.url, 'http://api/api/v1/messages')
    assert.equal((seen?.init.headers as Record<string, string>)['x-api-key'], 'secret')
    assert.deepEqual(JSON.parse(String(seen?.init.body)), message)
})

test('keeps the mentions of a reply and forwards participants', async () => {
    let body: unknown
    const client = new ToxClient('http://api', 'k', 1000, async (_url, init) => {
        body = JSON.parse(String((init as RequestInit).body))
        return jsonResponse({ replies: [{ text: 'y tu mamá donde está? {@0}', mentions: [{ user_id: '1@lid', user_name: 'Bob' }] }] })
    })
    const replies = await client.sendMessage({ ...message, participants: [{ user_id: '1@lid', user_name: 'Bob' }] })
    assert.deepEqual(replies[0]?.mentions, [{ user_id: '1@lid', user_name: 'Bob' }])
    assert.deepEqual((body as ToxMessage).participants, [{ user_id: '1@lid', user_name: 'Bob' }])
})

test('returns no replies when the API has nothing to say', async () => {
    const client = new ToxClient('http://api', 'k', 1000, async () => jsonResponse({ replies: [] }))
    assert.deepEqual(await client.sendMessage(message), [])
})

test('turns HTTP errors into ToxApiError', async () => {
    const client = new ToxClient('http://api', 'k', 1000, async () => jsonResponse({ detail: 'no' }, 401))
    await assert.rejects(client.sendMessage(message), (error) => error instanceof ToxApiError && /401/.test(error.message))
})

test('turns network failures into ToxApiError', async () => {
    const client = new ToxClient('http://api', 'k', 1000, async () => {
        throw new TypeError('fetch failed')
    })
    await assert.rejects(client.sendMessage(message), ToxApiError)
})

test('fetchAudio downloads the bytes with the API key and returns the mimetype', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const client = new ToxClient('http://api', 'secret', 1000, async (url, init) => {
        seen = { url: String(url), init: init as RequestInit }
        return new Response(new Uint8Array([9, 8, 7]), { status: 200, headers: { 'content-type': 'audio/mp4' } })
    })
    const audio = await client.fetchAudio('mi risa #1.m4a')
    assert.deepEqual([...audio.data], [9, 8, 7])
    assert.equal(audio.mimetype, 'audio/mp4')
    assert.equal(seen?.url, 'http://api/api/v1/audios/mi%20risa%20%231.m4a', 'the name is URL-encoded')
    assert.equal((seen?.init.headers as Record<string, string>)['x-api-key'], 'secret')
})

test('fetchAudio turns 404s and network failures into ToxApiError', async () => {
    const notFound = new ToxClient('http://api', 'k', 1000, async () => new Response('{}', { status: 404 }))
    await assert.rejects(notFound.fetchAudio('x.m4a'), (e) => e instanceof ToxApiError && /404/.test(e.message))
    const down = new ToxClient('http://api', 'k', 1000, async () => {
        throw new TypeError('fetch failed')
    })
    await assert.rejects(down.fetchAudio('x.m4a'), ToxApiError)
})

test('a reply with an audio keeps its name', async () => {
    const client = new ToxClient('http://api', 'k', 1000, async () => jsonResponse({ replies: [{ text: '', mentions: [], audio: 'risa.m4a' }] }))
    assert.deepEqual(await client.sendMessage(message), [{ text: '', mentions: [], audio: 'risa.m4a' }])
})

test('a reply with a sticker keeps its id', async () => {
    const client = new ToxClient('http://api', 'k', 1000, async () => jsonResponse({ replies: [{ text: '', mentions: [], sticker: 'abc123' }] }))
    assert.deepEqual(await client.sendMessage(message), [{ text: '', mentions: [], sticker: 'abc123' }])
})

test('fetchSticker downloads the bytes with the API key and returns the mimetype', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const client = new ToxClient('http://api', 'secret', 1000, async (url, init) => {
        seen = { url: String(url), init: init as RequestInit }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/webp' } })
    })
    const sticker = await client.fetchSticker('abc 123')
    assert.deepEqual([...sticker.data], [1, 2, 3])
    assert.equal(sticker.mimetype, 'image/webp')
    assert.equal(seen?.url, 'http://api/api/v1/stickers/abc%20123', 'the id is URL-encoded')
    assert.equal((seen?.init.headers as Record<string, string>)['x-api-key'], 'secret')
})

test('fetchSticker turns 404s and network failures into ToxApiError', async () => {
    const notFound = new ToxClient('http://api', 'k', 1000, async () => new Response('{}', { status: 404 }))
    await assert.rejects(notFound.fetchSticker('x'), (e) => e instanceof ToxApiError && /404/.test(e.message))
    const down = new ToxClient('http://api', 'k', 1000, async () => {
        throw new TypeError('fetch failed')
    })
    await assert.rejects(down.fetchSticker('x'), ToxApiError)
})

test('fetchPendingAlerts requests this platform and returns the alerts', async () => {
    let seen: string | undefined
    const client = new ToxClient('http://api', 'secret', 1000, async (url) => {
        seen = String(url)
        return jsonResponse([{ chat_id: 'g@g.us', text: '🔴 demo: caído. {@0}', mentions: [{ user_id: '1@lid' }] }])
    })
    assert.deepEqual(await client.fetchPendingAlerts(), [
        { chat_id: 'g@g.us', text: '🔴 demo: caído. {@0}', mentions: [{ user_id: '1@lid' }] }
    ])
    assert.equal(seen, 'http://api/api/v1/alerts/pending?platform=whatsapp')
})
