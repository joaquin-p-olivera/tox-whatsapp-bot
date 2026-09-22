import type { Config } from '../src/config.ts'
import type { ChatMessage } from '../src/messageHandler.ts'

export function makeConfig(overrides: Partial<Config> = {}): Config {
    return {
        toxApiUrl: 'http://127.0.0.1:8000',
        toxApiKey: 'test-key',
        toxApiTimeoutMs: 1000,
        botPhoneNumber: '59800000000',
        sessionId: 'test',
        authDir: '.auth-test',
        allowedGroupJids: new Set(),
        allowPrivateChats: false,
        commandPrefixes: ['!', '/'],
        logLevel: 'error',
        ...overrides
    }
}

export function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        chatJid: '120363000000000001@g.us',
        senderJid: '198765432100:7@lid',
        senderName: 'Alice',
        text: '!ping',
        isGroup: true,
        fromMe: false,
        quoteRef: { id: 'msg-1' },
        ...overrides
    }
}

export const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }
