import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadConfig } from '../src/config.ts'

test('requires TOX_API_KEY', () => {
    assert.throws(() => loadConfig({}), /TOX_API_KEY/)
})

test('applies defaults', () => {
    const config = loadConfig({ TOX_API_KEY: 'k' })
    assert.equal(config.toxApiUrl, 'http://127.0.0.1:8000')
    assert.equal(config.sessionId, 'tox')
    assert.equal(config.allowPrivateChats, false)
    assert.deepEqual([...config.commandPrefixes], ['!', '/'])
    assert.equal(config.allowedGroupJids.size, 0)
    assert.equal(config.botPhoneNumber, null)
})

test('normalises the phone number to digits', () => {
    assert.equal(loadConfig({ TOX_API_KEY: 'k', BOT_PHONE_NUMBER: '+598 00 000 000' }).botPhoneNumber, '59800000000')
})

test('rejects an invalid phone number', () => {
    assert.throws(() => loadConfig({ TOX_API_KEY: 'k', BOT_PHONE_NUMBER: '123' }), /BOT_PHONE_NUMBER/)
})

test('parses lists, booleans and trims the API url', () => {
    const config = loadConfig({
        TOX_API_KEY: 'k',
        TOX_API_URL: 'http://localhost:9000///',
        ALLOWED_GROUP_JIDS: ' a@g.us , b@g.us ,',
        ALLOW_PRIVATE_CHATS: 'TRUE'
    })
    assert.equal(config.toxApiUrl, 'http://localhost:9000')
    assert.deepEqual([...config.allowedGroupJids], ['a@g.us', 'b@g.us'])
    assert.equal(config.allowPrivateChats, true)
})

test('rejects bad booleans, log levels and timeouts', () => {
    assert.throws(() => loadConfig({ TOX_API_KEY: 'k', ALLOW_PRIVATE_CHATS: 'maybe' }), /ALLOW_PRIVATE_CHATS/)
    assert.throws(() => loadConfig({ TOX_API_KEY: 'k', LOG_LEVEL: 'loud' }), /LOG_LEVEL/)
    assert.throws(() => loadConfig({ TOX_API_KEY: 'k', TOX_API_TIMEOUT_MS: '-5' }), /TOX_API_TIMEOUT_MS/)
})
