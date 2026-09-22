import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
    API_DOWN_REPLY,
    createMessageHandler,
    jidUser,
    renderMentions,
    stripDevice,
    type GroupMember,
    type SendOptions
} from '../src/messageHandler.ts'
import type { ToxAudio, ToxMessage, ToxReply } from '../src/toxClient.ts'
import { makeConfig, makeMessage, silentLogger } from './helpers.ts'

const plain = (text: string): ToxReply => ({ text, mentions: [] })

interface SetupOptions {
    config?: Parameters<typeof makeConfig>[0]
    replies?: ToxReply[]
    fail?: boolean
    members?: GroupMember[] | Error
    audioFails?: boolean
}

function setup(options: SetupOptions = {}) {
    const apiCalls: ToxMessage[] = []
    const sent: { jid: string; text: string; options: SendOptions | undefined }[] = []
    const audiosFetched: string[] = []
    const audiosSent: { jid: string; audio: ToxAudio; options: SendOptions | undefined }[] = []
    const { members } = options
    const handle = createMessageHandler({
        config: makeConfig(options.config),
        logger: silentLogger,
        tox: {
            async sendMessage(message) {
                apiCalls.push(message)
                if (options.fail) throw new Error('boom')
                return options.replies ?? [plain('pong')]
            },
            async fetchAudio(name) {
                audiosFetched.push(name)
                if (options.audioFails) throw new Error('audio 404')
                return { data: new Uint8Array([1, 2, 3]), mimetype: 'audio/mp4' }
            }
        },
        getGroupMembers: members
            ? async () => {
                  if (members instanceof Error) throw members
                  return members
              }
            : undefined,
        async sendText(jid, text, sendOptions) {
            sent.push({ jid, text, options: sendOptions })
        },
        async sendAudio(jid, audio, sendOptions) {
            audiosSent.push({ jid, audio, options: sendOptions })
        }
    })
    return { handle, apiCalls, sent, audiosFetched, audiosSent }
}

const member = (id: string, extra: Partial<GroupMember> = {}): GroupMember => ({ userId: id, aliases: [id], ...extra })

test('forwards a command and quotes the original message in the reply', async () => {
    const { handle, apiCalls, sent } = setup()
    const message = makeMessage()
    await handle(message)

    assert.deepEqual(apiCalls, [
        {
            platform: 'whatsapp',
            chat_id: message.chatJid,
            user_id: '198765432100@lid', // device segment stripped
            user_name: 'Alice',
            text: '!ping',
            is_group: true,
            participants: undefined
        }
    ])
    assert.deepEqual(sent, [{ jid: message.chatJid, text: 'pong', options: { quoteRef: message.quoteRef, mentionJids: undefined } }])
})

test('ignores normal chatter without calling the API', async () => {
    const { handle, apiCalls, sent } = setup()
    await handle(makeMessage({ text: 'hey, ¿cómo andan todos?' }))
    await handle(makeMessage({ text: '   ' }))
    assert.equal(apiCalls.length + sent.length, 0)
})

test('ignores its own messages (multi-device echoes)', async () => {
    const { handle, apiCalls } = setup()
    await handle(makeMessage({ fromMe: true }))
    assert.equal(apiCalls.length, 0)
})

test('supports the / prefix too', async () => {
    const { handle, apiCalls } = setup()
    await handle(makeMessage({ text: '/ping' }))
    assert.equal(apiCalls.length, 1)
})

test('only answers in allowed groups when an allowlist is set', async () => {
    const { handle, apiCalls } = setup({ config: { allowedGroupJids: new Set(['allowed@g.us']) } })
    await handle(makeMessage({ chatJid: 'stranger@g.us' }))
    assert.equal(apiCalls.length, 0)
    await handle(makeMessage({ chatJid: 'allowed@g.us' }))
    assert.equal(apiCalls.length, 1)
})

test('answers in any group when the allowlist is empty', async () => {
    const { handle, apiCalls } = setup()
    await handle(makeMessage({ chatJid: 'any@g.us' }))
    assert.equal(apiCalls.length, 1)
})

test('private chats are ignored unless enabled', async () => {
    const dm = makeMessage({ isGroup: false, chatJid: '59899123456@s.whatsapp.net', senderJid: '59899123456@s.whatsapp.net' })

    const blocked = setup()
    await blocked.handle(dm)
    assert.equal(blocked.apiCalls.length, 0)

    const allowed = setup({ config: { allowPrivateChats: true } })
    await allowed.handle(dm)
    assert.equal(allowed.apiCalls.length, 1)
    assert.equal(allowed.apiCalls[0]?.is_group, false)
})

test('sends every reply, quoting only the first', async () => {
    const { handle, sent } = setup({ replies: [plain('first'), plain('second')] })
    const message = makeMessage()
    await handle(message)
    assert.deepEqual(
        sent.map((s) => [s.text, s.options?.quoteRef]),
        [
            ['first', message.quoteRef],
            ['second', undefined]
        ]
    )
})

test('sends nothing when the API returns no replies (unknown command)', async () => {
    const { handle, sent } = setup({ replies: [] })
    await handle(makeMessage({ text: '!nada' }))
    assert.equal(sent.length, 0)
})

test('tells the chat (in Spanish) when the API is down', async () => {
    const { handle, sent } = setup({ fail: true })
    await handle(makeMessage())
    assert.deepEqual(sent.map((s) => s.text), [API_DOWN_REPLY])
    assert.match(API_DOWN_REPLY, /no está disponible/)
})

test('a failing send does not throw', async () => {
    const handle = createMessageHandler({
        config: makeConfig(),
        logger: silentLogger,
        tox: { sendMessage: async () => [plain('a'), plain('b')], fetchAudio: async () => ({ data: new Uint8Array(), mimetype: 'audio/mp4' }) },
        sendText: async () => {
            throw new Error('socket closed')
        },
        sendAudio: async () => {}
    })
    await assert.doesNotReject(handle(makeMessage()))
})

test('sends the group members to the API, without the sender', async () => {
    const { handle, apiCalls } = setup({
        members: [
            member('198765432100@lid', { name: 'Alice' }), // the sender
            member('111@lid', { name: 'Bob' }),
            member('222@lid')
        ]
    })
    await handle(makeMessage({ text: '!m' }))
    assert.deepEqual(apiCalls[0]?.participants, [
        { user_id: '111@lid', user_name: 'Bob', aliases: ['111@lid'] },
        { user_id: '222@lid', user_name: undefined, aliases: ['222@lid'] }
    ])
})

test('excludes the sender even when the group lists them under another JID form', async () => {
    const { handle, apiCalls } = setup({
        members: [
            // Same person: the group knows them by phone number, the message came from their LID.
            { userId: '59899111111@s.whatsapp.net', aliases: ['59899111111@s.whatsapp.net', '198765432100@lid'] },
            member('59899222222@s.whatsapp.net')
        ]
    })
    await handle(makeMessage({ text: '!m', senderAltJid: '59899111111:3@s.whatsapp.net' }))
    assert.deepEqual(apiCalls[0]?.participants, [
        { user_id: '59899222222@s.whatsapp.net', user_name: undefined, aliases: ['59899222222@s.whatsapp.net'] }
    ])
})

test('does not list members in private chats', async () => {
    const { handle, apiCalls } = setup({ members: [member('111@lid')], config: { allowPrivateChats: true } })
    await handle(makeMessage({ isGroup: false, chatJid: '59899@s.whatsapp.net', senderJid: '59899@s.whatsapp.net' }))
    assert.equal(apiCalls[0]?.participants, undefined)
})

test('still answers when the member list cannot be fetched', async () => {
    const { handle, apiCalls, sent } = setup({ members: new Error('not-authorized') })
    await handle(makeMessage())
    assert.equal(apiCalls[0]?.participants, undefined)
    assert.equal(sent.length, 1)
})

test('renders a mention with the real @user text and the JID to tag', async () => {
    const { handle, sent } = setup({
        replies: [{ text: 'y tu mamá donde está? {@0}', mentions: [{ user_id: '59899222222@s.whatsapp.net', user_name: 'Bob' }] }]
    })
    await handle(makeMessage({ text: '!m' }))
    assert.equal(sent[0]?.text, 'y tu mamá donde está? @59899222222')
    assert.deepEqual(sent[0]?.options?.mentionJids, ['59899222222@s.whatsapp.net'])
})

test('renderMentions leaves unknown placeholders alone', () => {
    assert.deepEqual(renderMentions({ text: 'hola {@3}', mentions: [] }), { text: 'hola {@3}', mentionJids: [] })
    assert.deepEqual(renderMentions(plain('sin menciones')), { text: 'sin menciones', mentionJids: [] })
    assert.deepEqual(
        renderMentions({ text: '{@0} y {@1}', mentions: [{ user_id: '1@lid' }, { user_id: '2:5@lid' }] }),
        { text: '@1 y @2', mentionJids: ['1@lid', '2:5@lid'] }
    )
})

test('stripDevice / jidUser', () => {
    assert.equal(stripDevice('5989:12@s.whatsapp.net'), '5989@s.whatsapp.net')
    assert.equal(stripDevice('5989@s.whatsapp.net'), '5989@s.whatsapp.net')
    assert.equal(jidUser('5989:12@s.whatsapp.net'), '5989')
    assert.equal(jidUser('198765@lid'), '198765')
})

test('warns when the group has nobody to mention besides the sender', async () => {
    const warnings: string[] = []
    const handle = createMessageHandler({
        config: makeConfig(),
        logger: { ...silentLogger, warn: (message) => void warnings.push(message) },
        tox: { sendMessage: async () => [plain('ok')], fetchAudio: async () => ({ data: new Uint8Array(), mimetype: 'audio/mp4' }) },
        getGroupMembers: async () => [member('198765432100@lid')], // only the sender (the bot is already excluded)
        sendText: async () => {},
        sendAudio: async () => {}
    })
    await handle(makeMessage({ text: '!m' }))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /No one to mention/)
})

test('an audio reply downloads the audio and sends it, quoting the command', async () => {
    const { handle, sent, audiosFetched, audiosSent } = setup({ replies: [{ text: '', mentions: [], audio: 'risa.m4a' }] })
    const message = makeMessage({ text: '!m' })
    await handle(message)

    assert.deepEqual(audiosFetched, ['risa.m4a'])
    assert.equal(audiosSent.length, 1)
    assert.deepEqual([...(audiosSent[0]?.audio.data ?? [])], [1, 2, 3])
    assert.equal(audiosSent[0]?.audio.mimetype, 'audio/mp4')
    assert.equal(audiosSent[0]?.options?.quoteRef, message.quoteRef)
    assert.equal(sent.length, 0, 'no text is sent along with a pure audio reply')
})

test('a text reply never touches the audio endpoint', async () => {
    const { handle, audiosFetched, audiosSent } = setup()
    await handle(makeMessage())
    assert.equal(audiosFetched.length + audiosSent.length, 0)
})

test('if the audio cannot be downloaded, it logs and sends nothing (no crash, no broken message)', async () => {
    const errors: string[] = []
    const apiCalls: ToxMessage[] = []
    const handle = createMessageHandler({
        config: makeConfig(),
        logger: { ...silentLogger, error: (m) => void errors.push(m) },
        tox: {
            sendMessage: async (m) => (apiCalls.push(m), [{ text: '', mentions: [], audio: 'risa.m4a' }]),
            fetchAudio: async () => {
                throw new Error('404')
            }
        },
        sendText: async () => assert.fail('nothing should be sent'),
        sendAudio: async () => assert.fail('nothing should be sent')
    })
    await assert.doesNotReject(handle(makeMessage({ text: '!m' })))
    assert.deepEqual(errors, ['Failed to send reply'])
})

test('sends every alias of a member (LID and phone number) so the API can match mutes', async () => {
    const { handle, apiCalls } = setup({
        members: [
            member('198765432100@lid'), // the sender
            { userId: '59899222222@s.whatsapp.net', aliases: ['59899222222@s.whatsapp.net', '222@lid'], name: 'Bob' }
        ]
    })
    await handle(makeMessage({ text: '!m' }))
    assert.deepEqual(apiCalls[0]?.participants?.[0]?.aliases, ['59899222222@s.whatsapp.net', '222@lid'])
})
