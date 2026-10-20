import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
    API_DOWN_REPLY,
    JOB_LOST_REPLY,
    REMOVE_FAILED_REPLY,
    createMessageHandler,
    jidUser,
    renderMentions,
    stripDevice,
    type GroupMember,
    type SendOptions
} from '../src/messageHandler.ts'
import type { ToxAudio, ToxHistoryMessage, ToxImage, ToxMessage, ToxReply, ToxSticker } from '../src/toxClient.ts'
import { makeConfig, makeMessage, silentLogger } from './helpers.ts'

const plain = (text: string): ToxReply => ({ text, mentions: [] })

interface SetupOptions {
    config?: Parameters<typeof makeConfig>[0]
    replies?: ToxReply[]
    fail?: boolean
    members?: GroupMember[] | Error
    audioFails?: boolean
    stickerFails?: boolean
    imageFails?: boolean
    /** Chat ids the API says have history turned on (enables the history calls of the fake API). */
    history?: string[]
}

function setup(options: SetupOptions = {}) {
    const apiCalls: ToxMessage[] = []
    const sent: { jid: string; text: string; options: SendOptions | undefined }[] = []
    const audiosFetched: string[] = []
    const audiosSent: { jid: string; audio: ToxAudio; options: SendOptions | undefined }[] = []
    const stickersFetched: string[] = []
    const stickersSent: { jid: string; sticker: ToxSticker; options: SendOptions | undefined }[] = []
    const imagesFetched: string[] = []
    const imagesSent: { jid: string; image: ToxImage; options: SendOptions | undefined }[] = []
    const reactionsSent: { jid: string; emoji: string; target: unknown }[] = []
    const historySaved: ToxHistoryMessage[] = []
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
            },
            async fetchSticker(id) {
                stickersFetched.push(id)
                if (options.stickerFails) throw new Error('sticker 404')
                return { data: new Uint8Array([4, 5, 6]), mimetype: 'image/webp' }
            },
            async fetchImage(id) {
                imagesFetched.push(id)
                if (options.imageFails) throw new Error('image 404')
                return { data: new Uint8Array([7, 8, 9]), mimetype: 'image/png' }
            },
            async fetchHistoryChats() {
                return options.history ?? []
            },
            async saveHistory(messages) {
                historySaved.push(...messages)
            }
        },
        getSelfJids: () => ['999:3@lid', '598000:3@s.whatsapp.net'],
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
        },
        async sendSticker(jid, sticker, sendOptions) {
            stickersSent.push({ jid, sticker, options: sendOptions })
        },
        async sendImage(jid, image, sendOptions) {
            imagesSent.push({ jid, image, options: sendOptions })
        },
        async sendReaction(jid, emoji, target) {
            reactionsSent.push({ jid, emoji, target })
        }
    })
    return { handle, apiCalls, sent, audiosFetched, audiosSent, stickersFetched, stickersSent, imagesFetched, imagesSent, reactionsSent, historySaved }
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
            participants: undefined,
            sender_is_group_admin: undefined,
            mentioned: undefined
        }
    ])
    assert.deepEqual(sent, [{ jid: message.chatJid, text: 'pong', options: { quoteRef: message.quoteRef, mentionJids: undefined } }])
})

test('forwards the picture of the message as base64, and still answers when it cannot be downloaded', async () => {
    const { handle, apiCalls } = setup()
    await handle(makeMessage({ text: '!sticker', getImage: async () => new Uint8Array([1, 2, 3]) }))
    assert.equal(apiCalls[0]?.image, 'AQID')

    await handle(makeMessage({ text: '!sticker', getImage: async () => { throw new Error('expired') } }))
    assert.equal(apiCalls[1]?.image, undefined)
    assert.equal(apiCalls.length, 2)
})

test('does not download any picture for a message that is not a command', async () => {
    const { handle, apiCalls } = setup()
    let downloads = 0
    await handle(makeMessage({ text: 'mirá esto', getImage: async () => { downloads += 1; return new Uint8Array([1]) } }))
    assert.equal(downloads, 0)
    assert.equal(apiCalls.length, 0)
})

test('forwards the users tagged with @ in the message (device segment stripped)', async () => {
    const { handle, apiCalls } = setup()
    await handle(makeMessage({ text: '!gay @Bob', mentionedJids: ['111:7@lid'] }))
    assert.deepEqual(apiCalls[0]?.mentioned, [{ user_id: '111@lid' }])
})

test('a reaction reply reacts to the command message and sends nothing else', async () => {
    const { handle, sent, reactionsSent } = setup({ replies: [{ text: '', mentions: [], reaction: '👍' }] })
    const message = makeMessage({ text: '!uid' })
    await handle(message)
    assert.deepEqual(reactionsSent, [{ jid: message.chatJid, emoji: '👍', target: message.quoteRef }])
    assert.equal(sent.length, 0)
})

test('an empty reaction takes the earlier one off, and no reaction field leaves them alone', async () => {
    const cleared = setup({ replies: [plain('Listo.'), { text: '', mentions: [], reaction: '' }] })
    const message = makeMessage({ text: '!claude dale' })
    await cleared.handle(message)
    assert.deepEqual(cleared.reactionsSent, [{ jid: message.chatJid, emoji: '', target: message.quoteRef }])
    assert.deepEqual(cleared.sent.map((s) => s.text), ['Listo.'])

    const plainReply = setup()
    await plainReply.handle(makeMessage({ text: '!ping' }))
    assert.deepEqual(plainReply.reactionsSent, [])
})

test('a tag of the bot itself is flagged as is_bot, whichever form of its JID was used', async () => {
    const calls: ToxMessage[] = []
    const handle = createMessageHandler({
        config: makeConfig(),
        logger: silentLogger,
        tox: {
            sendMessage: async (m) => (calls.push(m), []),
            fetchAudio: async () => ({ data: new Uint8Array(), mimetype: 'audio/mp4' }),
            fetchSticker: async () => ({ data: new Uint8Array(), mimetype: 'image/webp' }),
            fetchImage: async () => ({ data: new Uint8Array(), mimetype: 'image/png' })
        },
        getSelfJids: () => ['999:3@lid', '598000@s.whatsapp.net'],
        sendText: async () => {},
        sendAudio: async () => {},
        sendSticker: async () => {},
        sendImage: async () => {},
        sendReaction: async () => {}
    })
    await handle(makeMessage({ text: '!gay @bot @Bob', mentionedJids: ['999@lid', '111@lid'] }))
    assert.deepEqual(calls[0]?.mentioned, [{ user_id: '999@lid', is_bot: true }, { user_id: '111@lid' }])
})

test('forwards the replied-to text with who wrote it, and marks the bot\'s own message', async () => {
    const { handle, apiCalls } = setup()
    await handle(makeMessage({ text: '!claude qué opinás?', quoted: { text: 'Mañana no llego', senderJid: '111:7@lid' } }))
    await handle(makeMessage({ text: '!claude y esto?', quoted: { text: 'Hola', senderJid: '999:3@lid' } }))
    await handle(makeMessage({ text: '!claude sin cita' }))

    assert.deepEqual(apiCalls[0]?.quoted, { text: 'Mañana no llego', user_id: '111@lid' })
    assert.deepEqual(apiCalls[1]?.quoted, { text: 'Hola', user_id: '999@lid', is_bot: true })
    assert.equal(apiCalls[2]?.quoted, undefined)
})

test('a reply to the bot goes to the API with no prefix at all (it is a question for Claude)', async () => {
    const { handle, apiCalls } = setup()
    await handle(makeMessage({ text: 'y eso qué quiere decir?', quoted: { text: 'Listo.', senderJid: '999:3@lid' } }))
    assert.equal(apiCalls[0]?.text, 'y eso qué quiere decir?')
    assert.deepEqual(apiCalls[0]?.quoted, { text: 'Listo.', user_id: '999@lid', is_bot: true })
})

test('a reply to the bot with no text in it (a voice note) still reaches the API', async () => {
    const { handle, apiCalls } = setup()
    await handle(makeMessage({ text: 'jajaja', quoted: { text: '', senderJid: '598000:3@s.whatsapp.net' } }))
    assert.equal(apiCalls.length, 1)
    assert.deepEqual(apiCalls[0]?.quoted, { text: '', user_id: '598000@s.whatsapp.net', is_bot: true })
})

test('a prefix-less reply to somebody else is ordinary chatter: the API is never called', async () => {
    const { handle, apiCalls } = setup()
    await handle(makeMessage({ text: 'jajaja', quoted: { text: 'Mañana no llego', senderJid: '111:7@lid' } }))
    await handle(makeMessage({ text: 'jajaja' })) // no reply at all
    await handle(makeMessage({ text: 'y eso?', quoted: { text: 'Listo.' } })) // WhatsApp didn't say who wrote it
    assert.deepEqual(apiCalls, [])
})

test('in the personal mode a reply to an own message is still not a command', async () => {
    const { handle, apiCalls } = setup({ config: { mode: 'personal' } })
    await handle(makeMessage({ text: 'y eso?', fromMe: true, isGroup: false, chatJid: '59899111111@s.whatsapp.net',
        quoted: { text: 'Listo.', senderJid: '999:3@lid' } }))
    assert.deepEqual(apiCalls, [])
})

test('reports whether the sender administers THIS group, by any of their JIDs', async () => {
    const group = (senderIsAdmin: boolean) => [
        member('198765432100@lid', { isAdmin: senderIsAdmin, aliases: ['198765432100@lid', '59899111111@s.whatsapp.net'] }),
        member('111@lid', { isAdmin: !senderIsAdmin })
    ]
    const admin = setup({ members: group(true) })
    await admin.handle(makeMessage({ text: '!service' }))
    assert.equal(admin.apiCalls[0]?.sender_is_group_admin, true)

    const notAdmin = setup({ members: group(false) })
    await notAdmin.handle(makeMessage({ text: '!service' }))
    assert.equal(notAdmin.apiCalls[0]?.sender_is_group_admin, false, 'someone else being admin does not count')
})

test('if the roster cannot be read, the sender is reported as NOT an admin (never guessed)', async () => {
    const { handle, apiCalls } = setup({ members: new Error('no metadata') })
    await handle(makeMessage({ text: '!service' }))
    assert.equal(apiCalls[0]?.sender_is_group_admin, false)
})

test('a private chat reports nothing about group admins', async () => {
    const { handle, apiCalls } = setup({ config: { allowPrivateChats: true }, members: [member('1@lid', { isAdmin: true })] })
    await handle(makeMessage({ isGroup: false, chatJid: '59899123456@s.whatsapp.net', senderJid: '59899123456@s.whatsapp.net' }))
    assert.equal(apiCalls[0]?.sender_is_group_admin, undefined)
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
        tox: {
            sendMessage: async () => [plain('a'), plain('b')],
            fetchAudio: async () => ({ data: new Uint8Array(), mimetype: 'audio/mp4' }),
            fetchSticker: async () => ({ data: new Uint8Array(), mimetype: 'image/webp' }),
            fetchImage: async () => ({ data: new Uint8Array(), mimetype: 'image/png' })
        },
        sendText: async () => {
            throw new Error('socket closed')
        },
        sendAudio: async () => {},
        sendSticker: async () => {},
        sendImage: async () => {},
        sendReaction: async () => {}
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
        { user_id: '111@lid', user_name: 'Bob', aliases: ['111@lid'], is_group_admin: false },
        { user_id: '222@lid', user_name: undefined, aliases: ['222@lid'], is_group_admin: false }
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
        { user_id: '59899222222@s.whatsapp.net', user_name: undefined, aliases: ['59899222222@s.whatsapp.net'], is_group_admin: false }
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
        tox: {
            sendMessage: async () => [plain('ok')],
            fetchAudio: async () => ({ data: new Uint8Array(), mimetype: 'audio/mp4' }),
            fetchSticker: async () => ({ data: new Uint8Array(), mimetype: 'image/webp' }),
            fetchImage: async () => ({ data: new Uint8Array(), mimetype: 'image/png' })
        },
        getGroupMembers: async () => [member('198765432100@lid')], // only the sender (the bot is already excluded)
        sendText: async () => {},
        sendAudio: async () => {},
        sendSticker: async () => {},
        sendImage: async () => {},
        sendReaction: async () => {}
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
            },
            fetchSticker: async () => ({ data: new Uint8Array(), mimetype: 'image/webp' }),
            fetchImage: async () => ({ data: new Uint8Array(), mimetype: 'image/png' })
        },
        sendText: async () => assert.fail('nothing should be sent'),
        sendAudio: async () => assert.fail('nothing should be sent'),
        sendSticker: async () => assert.fail('nothing should be sent'),
        sendImage: async () => assert.fail('nothing should be sent'),
        sendReaction: async () => assert.fail('nothing should be sent')
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

test('a sticker reply downloads the sticker and sends it, quoting the command', async () => {
    const { handle, sent, stickersFetched, stickersSent } = setup({ replies: [{ text: '', mentions: [], sticker: 'abc123' }] })
    const message = makeMessage({ text: '!sticker hola' })
    await handle(message)

    assert.deepEqual(stickersFetched, ['abc123'])
    assert.equal(stickersSent.length, 1)
    assert.deepEqual([...(stickersSent[0]?.sticker.data ?? [])], [4, 5, 6])
    assert.equal(stickersSent[0]?.sticker.mimetype, 'image/webp')
    assert.equal(stickersSent[0]?.options?.quoteRef, message.quoteRef)
    assert.equal(sent.length, 0, 'no text is sent along with a pure sticker reply')
})

test('a text reply never touches the sticker endpoint', async () => {
    const { handle, stickersFetched, stickersSent } = setup()
    await handle(makeMessage())
    assert.equal(stickersFetched.length + stickersSent.length, 0)
})

test('an image reply downloads it and sends it, quoting the command', async () => {
    const { handle, sent, imagesFetched, imagesSent } = setup({ replies: [{ text: '', mentions: [], image: 'tabla123' }] })
    const message = makeMessage({ text: '!futbol argentina -t' })
    await handle(message)

    assert.deepEqual(imagesFetched, ['tabla123'])
    assert.equal(imagesSent.length, 1)
    assert.deepEqual([...(imagesSent[0]?.image.data ?? [])], [7, 8, 9])
    assert.equal(imagesSent[0]?.image.mimetype, 'image/png')
    assert.equal(imagesSent[0]?.options?.quoteRef, message.quoteRef)
    assert.equal(sent.length, 0, 'no text is sent along with a pure image reply')
})

test('a text reply never touches the image endpoint', async () => {
    const { handle, imagesFetched, imagesSent } = setup()
    await handle(makeMessage())
    assert.equal(imagesFetched.length + imagesSent.length, 0)
})

test('if the image cannot be downloaded, it logs and sends nothing (no crash, no broken message)', async () => {
    const errors: string[] = []
    const handle = createMessageHandler({
        config: makeConfig(),
        logger: { ...silentLogger, error: (m) => void errors.push(m) },
        tox: {
            sendMessage: async () => [{ text: '', mentions: [], image: 'tabla123' }],
            fetchAudio: async () => ({ data: new Uint8Array(), mimetype: 'audio/mp4' }),
            fetchSticker: async () => ({ data: new Uint8Array(), mimetype: 'image/webp' }),
            fetchImage: async () => {
                throw new Error('404')
            }
        },
        sendText: async () => assert.fail('nothing should be sent'),
        sendAudio: async () => assert.fail('nothing should be sent'),
        sendSticker: async () => assert.fail('nothing should be sent'),
        sendImage: async () => assert.fail('nothing should be sent'),
        sendReaction: async () => assert.fail('nothing should be sent')
    })
    await assert.doesNotReject(handle(makeMessage({ text: '!futbol argentina -t' })))
    assert.deepEqual(errors, ['Failed to send reply'])
})

test('if the sticker cannot be downloaded, it logs and sends nothing (no crash, no broken message)', async () => {
    const errors: string[] = []
    const apiCalls: ToxMessage[] = []
    const handle = createMessageHandler({
        config: makeConfig(),
        logger: { ...silentLogger, error: (m) => void errors.push(m) },
        tox: {
            sendMessage: async (m) => (apiCalls.push(m), [{ text: '', mentions: [], sticker: 'abc123' }]),
            fetchAudio: async () => ({ data: new Uint8Array(), mimetype: 'audio/mp4' }),
            fetchSticker: async () => {
                throw new Error('404')
            },
            fetchImage: async () => ({ data: new Uint8Array(), mimetype: 'image/png' })
        },
        sendText: async () => assert.fail('nothing should be sent'),
        sendAudio: async () => assert.fail('nothing should be sent'),
        sendSticker: async () => assert.fail('nothing should be sent'),
        sendImage: async () => assert.fail('nothing should be sent'),
        sendReaction: async () => assert.fail('nothing should be sent')
    })
    await assert.doesNotReject(handle(makeMessage({ text: '!sticker hola' })))
    assert.deepEqual(errors, ['Failed to send reply'])
})

test('a ban reply removes the members first and only then announces it', async () => {
    const removed: { jid: string; ids: string[] }[] = []
    const { handle, sent } = setup({ replies: [{ text: '🔨 Baneado: {@0}.', mentions: [{ user_id: '111@lid' }], remove: ['111@lid'] }] })
    // setup() has no removeMembers: that is the "cannot remove" path
    await handle(makeMessage({ text: '!ban @Bob' }))
    assert.deepEqual(removed, [])
    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.text, REMOVE_FAILED_REPLY)
})

test('a ban reply with a working removal sends the announcement and asks for the blacklist sweep', async () => {
    const calls: string[] = []
    const handle = createMessageHandler({
        config: makeConfig(),
        logger: silentLogger,
        tox: {
            async sendMessage() {
                return [{ text: '⛔ {@0}', mentions: [{ user_id: '111@lid' }], remove: ['111@lid'], sweep_blacklist: true }]
            },
            async fetchAudio() { throw new Error('unused') },
            async fetchSticker() { throw new Error('unused') },
            async fetchImage() { throw new Error('unused') }
        },
        async sendText(_jid, text) { calls.push(`text:${text}`) },
        async sendAudio() {},
        async sendSticker() {},
        async sendImage() {},
        async sendReaction() {},
        async removeMembers(_jid, ids) { calls.push(`remove:${ids.join(',')}`) },
        async sweepBlacklist() { calls.push('sweep') }
    })
    await handle(makeMessage({ text: '!permaban @Bob' }))
    assert.deepEqual(calls, ['remove:111@lid', 'text:⛔ @111', 'sweep'])
})

test('the tagged people are forwarded with what the roster knows about them', async () => {
    const { handle, apiCalls } = setup({
        members: [
            member('198765432100@lid', { name: 'Alice' }),
            member('111@lid', { name: 'Bob', isAdmin: true, aliases: ['111@lid', '59899@s.whatsapp.net'] })
        ]
    })
    await handle(makeMessage({ text: '!ban @Bob', mentionedJids: ['111:4@lid'] }))
    assert.deepEqual(apiCalls[0]?.mentioned, [
        { user_id: '111@lid', user_name: 'Bob', aliases: ['111@lid', '59899@s.whatsapp.net'], is_group_admin: true }
    ])
})

function jobHandler(fetchJob: (id: string) => Promise<{ status: 'running' | 'done'; replies: ToxReply[] } | null>) {
    const sent: { text: string; quoted: unknown }[] = []
    const reactions: string[] = []
    const handle = createMessageHandler({
        config: makeConfig(),
        logger: silentLogger,
        tox: {
            async sendMessage() {
                // what !claude answers: a reaction to the command (no text) and the job to follow
                return [{ text: '', mentions: [], reaction: '⏳', job: 'job-1' }]
            },
            async fetchAudio() { throw new Error('unused') },
            async fetchSticker() { throw new Error('unused') },
            async fetchImage() { throw new Error('unused') },
            fetchJob
        },
        async sendText(_jid, text, options) { sent.push({ text, quoted: options?.quoteRef }) },
        async sendAudio() {},
        async sendSticker() {},
        async sendImage() {},
        async sendReaction(_jid, emoji) { reactions.push(emoji) },
        jobPollMs: 1,
        jobMaxWaitMs: 5_000,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2)))
    })
    return { handle, sent, reactions }
}

/** Waits (up to 3 s) until `sent` has `count` messages: the follow-up runs in the background. */
async function settle(sent: unknown[], count: number): Promise<void> {
    const deadline = Date.now() + 3_000
    while (sent.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
}

test('a job reply reacts now and sends the answer when the job is done, quoting the command', async () => {
    let polls = 0
    const { handle, sent, reactions } = jobHandler(async () => {
        polls += 1
        return polls < 3 ? { status: 'running', replies: [] } : { status: 'done', replies: [{ text: 'Todo bien.', mentions: [] }] }
    })
    const message = makeMessage({ text: '!claude hola' })
    await handle(message)
    assert.deepEqual(reactions, ['⏳'])
    assert.equal(sent.length, 0) // no placeholder message
    await settle(sent, 1)
    assert.deepEqual(sent.map((s) => s.text), ['Todo bien.'])
    assert.equal(sent[0]?.quoted, message.quoteRef)
})

test('a job the API no longer knows is reported instead of waiting forever', async () => {
    const { handle, sent } = jobHandler(async () => null)
    await handle(makeMessage({ text: '!claude hola' }))
    await settle(sent, 1)
    assert.equal(sent.at(-1)?.text, JOB_LOST_REPLY)
})

test('a failing job check is retried', async () => {
    let calls = 0
    const { handle, sent } = jobHandler(async () => {
        calls += 1
        if (calls === 1) throw new Error('temporary')
        return { status: 'done', replies: [{ text: 'listo', mentions: [] }] }
    })
    await handle(makeMessage({ text: '!claude hola' }))
    await settle(sent, 1)
    assert.equal(sent.at(-1)?.text, 'listo')
})

// Personal mode: the bot is linked to the owner's own number and only answers their ".b command" in private chats.
const PERSONAL = { config: { mode: 'personal' as const } }
const own = (text: string, overrides = {}) =>
    makeMessage({ text, fromMe: true, isGroup: false, chatJid: '59899111222@s.whatsapp.net', senderJid: '59899111222@s.whatsapp.net', ...overrides })

test('personal mode: forwards the owners ".b command" as them, flagged as personal', async () => {
    const { handle, apiCalls, sent } = setup(PERSONAL)
    const message = own('.b voz -h Hola mundo')
    await handle(message)

    assert.equal(apiCalls.length, 1)
    assert.equal(apiCalls[0]?.text, '.b voz -h Hola mundo')
    assert.equal(apiCalls[0]?.personal, true)
    assert.equal(apiCalls[0]?.is_group, false)
    assert.equal(apiCalls[0]?.chat_id, message.chatJid)
    assert.equal(apiCalls[0]?.user_id, '999@lid') // the owner (the account), not the person they are chatting with
    assert.equal(sent[0]?.jid, message.chatJid)
})

test('personal mode: ignores everything that is not the owners ".b command" in a private chat', async () => {
    const { handle, apiCalls } = setup(PERSONAL)
    await handle(own('!sticker'))                                  // the groups prefix
    await handle(own('.bsticker'))                                 // not separated
    await handle(own('hola .b sticker'))
    await handle(own('.b sticker', { fromMe: false }))             // what the other person types is never a command
    await handle(own('.b sticker', { isGroup: true, chatJid: '1203@g.us' }))  // a group that is not listed
    await handle(own('.b sticker', { chatJid: 'status@broadcast' }))
    assert.deepEqual(apiCalls, [])
})

test('groups mode: the personal form is just chat, and nothing is flagged as personal', async () => {
    const { handle, apiCalls } = setup()
    await handle(makeMessage({ text: '.b dado' }))
    assert.equal(apiCalls.length, 0)
    await handle(makeMessage())
    assert.equal(apiCalls[0]?.personal, undefined)
})

test('personal mode: works in the groups that are listed, as the owner, and never marks their own tag as the bot', async () => {
    const group = '1203@g.us'
    const { handle, apiCalls } = setup({ config: { mode: 'personal', personalGroupJids: new Set([group]) } })
    await handle(own('.b gay @yo', { isGroup: true, chatJid: group, senderJid: '5551@lid', mentionedJids: ['999:3@lid'] }))
    await handle(own('.b dado', { isGroup: true, chatJid: '9999@g.us' }))

    assert.equal(apiCalls.length, 1)
    assert.equal(apiCalls[0]?.is_group, true)
    assert.equal(apiCalls[0]?.personal, true)
    assert.equal(apiCalls[0]?.user_id, '999@lid')
    assert.deepEqual(apiCalls[0]?.mentioned, [{ user_id: '999@lid' }])
})

// History: the text of the chats that have it on, in personal mode only.
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('personal mode saves what is said in a chat that has history on, whoever said it', async () => {
    const chat = '59899111222@s.whatsapp.net'
    const { handle, apiCalls, historySaved } = setup({ ...PERSONAL, history: [chat] })

    // the other person says something (not a command: it is never answered), and the owner says something
    await handle(own('buenas, ¿cenamos?', { fromMe: false, chatJid: chat, senderJid: chat, senderName: 'Ana', messageId: 'A1', sentAtMs: 1_700_000_000_000 }))
    await handle(own('dale', { chatJid: chat, messageId: 'B2', senderName: undefined }))
    await flush()

    assert.deepEqual(apiCalls, [])
    assert.deepEqual(historySaved.map((m) => [m.message_id, m.sender_id, m.sender_name, m.text]), [
        ['A1', '59899111222@s.whatsapp.net', 'Ana', 'buenas, ¿cenamos?'],
        ['B2', '999@lid', 'Yo', 'dale']
    ])
    assert.equal(historySaved[0]?.sent_at, '2023-11-14T22:13:20.000Z')
})

test('personal mode does not save commands, the bots own answers, or chats that are not on', async () => {
    const chat = '59899111222@s.whatsapp.net'
    const { handle, historySaved, sent } = setup({ ...PERSONAL, history: [chat], replies: [plain('🎲 4')] })

    await handle(own('.b dado', { chatJid: chat, messageId: 'C1' })) // the command...
    await flush()
    assert.equal(sent[0]?.text, '🎲 4')
    await handle(own('🎲 4', { chatJid: chat, messageId: 'C2' })) // ...and its answer coming back as the owners message
    await handle(own('hola', { chatJid: '59800000000@s.whatsapp.net', messageId: 'D1' })) // another chat, not on
    await handle(own('🎲 4', { chatJid: chat, messageId: 'C3' })) // the same text typed by the owner later: that one is theirs
    await flush()

    assert.deepEqual(historySaved.map((m) => m.message_id), ['C3'])
})

test('personal mode knows a private chat by either of its two ids', async () => {
    const { handle, historySaved } = setup({ ...PERSONAL, history: ['777@lid'] })
    await handle(own('hola', { chatJid: '59899111222@s.whatsapp.net', chatAltJid: '777@lid', messageId: 'E1' }))
    await flush()
    assert.equal(historySaved[0]?.chat_id, '777@lid')
})

test('the groups mode saves what the others say in a group that has history on, but never commands or its own words', async () => {
    const group = '120363000000000001@g.us'
    const { handle, apiCalls, historySaved } = setup({ history: [group] })

    await handle(makeMessage({ text: 'hola a todos', messageId: 'F1', senderName: 'Bob', sentAtMs: 1_700_000_000_000 }))
    await handle(makeMessage({ text: '!ping', messageId: 'F2' })) // a command: answered, not saved
    await handle(makeMessage({ text: 'chau', messageId: 'F3', fromMe: true })) // the bot's own message
    await handle(makeMessage({ text: 'otro grupo', messageId: 'F4', chatJid: '120363000000000002@g.us' })) // not on
    await flush()

    assert.equal(apiCalls.length, 1) // only the command went to the API as a message
    assert.deepEqual(historySaved.map((m) => [m.chat_id, m.message_id, m.sender_id, m.sender_name, m.text]), [
        [group, 'F1', '198765432100@lid', 'Bob', 'hola a todos']
    ])
})

