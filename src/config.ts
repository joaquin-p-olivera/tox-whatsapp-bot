import { existsSync } from 'node:fs'

/**
 * How the bot is used:
 *  - "groups" (default): the dedicated bot account, answering `!command` in WhatsApp groups.
 *  - "personal": linked to the owner's own number, answering the owner's `.b command` in private chats (and in the
 *    groups listed in PERSONAL_GROUP_JIDS), and never doing anything on its own (no alerts, no blacklist sweeps).
 */
export type BotMode = 'groups' | 'personal'

export const BOT_MODES: readonly BotMode[] = ['groups', 'personal']

export interface Config {
    mode: BotMode
    toxApiUrl: string
    toxApiKey: string
    toxApiTimeoutMs: number
    /** Digits only, with country code (e.g. "59800000000"). */
    botPhoneNumber: string | null
    sessionId: string
    authDir: string
    /** Empty set means "every group". */
    allowedGroupJids: ReadonlySet<string>
    allowPrivateChats: boolean
    /** Personal mode only: the groups where the owner's `.b commands` work. Empty means none (unlike ALLOWED_GROUP_JIDS). */
    personalGroupJids: ReadonlySet<string>
    commandPrefixes: readonly string[]
    logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error'
    /** How often the bot checks the API for proactive alerts (e.g. a !service health change) to send on its own. */
    alertsPollIntervalMs: number
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const

/** The mode from the command line: `--mode personal` or `--mode=personal`. Anything else keeps the default (groups). */
export function parseMode(argv: readonly string[]): BotMode {
    let value: string | undefined
    for (const [index, arg] of argv.entries()) {
        if (arg === '--mode') value = argv[index + 1]
        else if (arg.startsWith('--mode=')) value = arg.slice('--mode='.length)
    }
    if (value === undefined) return 'groups'
    if (!(BOT_MODES as readonly string[]).includes(value)) {
        throw new Error(`--mode must be one of ${BOT_MODES.join(', ')}, got "${value}"`)
    }
    return value as BotMode
}

/** Loads `.env` (`.env.prod` when APP_ENV=prod; `.env.personal` in personal mode, so the two instances never share
 * settings by accident). Variables already in the environment win. */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env, mode: BotMode = 'groups'): void {
    const file = mode === 'personal' ? '.env.personal' : env.APP_ENV?.toLowerCase() === 'prod' ? '.env.prod' : '.env'
    if (existsSync(file)) {
        process.loadEnvFile(file)
    }
}

function list(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value.trim() === '') return fallback
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes'].includes(normalized)) return true
    if (['false', '0', 'no'].includes(normalized)) return false
    throw new Error(`${name} must be true or false, got "${value}"`)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, mode: BotMode = 'groups'): Config {
    const toxApiKey = env.TOX_API_KEY?.trim()
    if (!toxApiKey) {
        throw new Error('TOX_API_KEY is not set. Copy .env.default to .env and set it (same value as the API_KEY of the tox API).')
    }

    let botPhoneNumber: string | null = null
    if (env.BOT_PHONE_NUMBER?.trim()) {
        botPhoneNumber = env.BOT_PHONE_NUMBER.replace(/\D/g, '')
        if (botPhoneNumber.length < 8 || botPhoneNumber.length > 15) {
            throw new Error(`BOT_PHONE_NUMBER looks invalid: "${env.BOT_PHONE_NUMBER}" (expected e.g. +598XXXXXXXX)`)
        }
    }

    const logLevel = (env.LOG_LEVEL?.trim().toLowerCase() || 'info') as Config['logLevel']
    if (!LOG_LEVELS.includes(logLevel)) {
        throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${env.LOG_LEVEL}"`)
    }

    const timeout = Number(env.TOX_API_TIMEOUT_MS || 10_000)
    if (!Number.isInteger(timeout) || timeout <= 0) {
        throw new Error(`TOX_API_TIMEOUT_MS must be a positive integer, got "${env.TOX_API_TIMEOUT_MS}"`)
    }

    const alertsPollIntervalMs = Number(env.ALERTS_POLL_INTERVAL_MS || 30_000)
    if (!Number.isInteger(alertsPollIntervalMs) || alertsPollIntervalMs <= 0) {
        throw new Error(`ALERTS_POLL_INTERVAL_MS must be a positive integer, got "${env.ALERTS_POLL_INTERVAL_MS}"`)
    }

    return {
        mode,
        toxApiUrl: (env.TOX_API_URL?.trim() || 'http://127.0.0.1:8000').replace(/\/+$/, ''),
        toxApiKey,
        toxApiTimeoutMs: timeout,
        botPhoneNumber,
        // Another account, another session: the personal mode must never fall back to the bot's own.
        sessionId: env.BOT_SESSION_ID?.trim() || (mode === 'personal' ? 'tox-personal' : 'tox'),
        authDir: env.AUTH_DIR?.trim() || (mode === 'personal' ? '.auth-personal' : '.auth'),
        allowedGroupJids: new Set(list(env.ALLOWED_GROUP_JIDS)),
        personalGroupJids: new Set(list(env.PERSONAL_GROUP_JIDS)),
        allowPrivateChats: parseBoolean('ALLOW_PRIVATE_CHATS', env.ALLOW_PRIVATE_CHATS, false),
        commandPrefixes: list(env.COMMAND_PREFIXES ?? '!,/'),
        logLevel,
        alertsPollIntervalMs
    }
}
