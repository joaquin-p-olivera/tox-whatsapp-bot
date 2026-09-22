import { existsSync } from 'node:fs'

export interface Config {
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
    commandPrefixes: readonly string[]
    logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error'
    /** How often the bot checks the API for proactive alerts (e.g. a !service health change) to send on its own. */
    alertsPollIntervalMs: number
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const

/** Loads `.env` (or `.env.prod` when APP_ENV=prod). Variables already in the environment win. */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env): void {
    const file = env.APP_ENV?.toLowerCase() === 'prod' ? '.env.prod' : '.env'
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
        toxApiUrl: (env.TOX_API_URL?.trim() || 'http://127.0.0.1:8000').replace(/\/+$/, ''),
        toxApiKey,
        toxApiTimeoutMs: timeout,
        botPhoneNumber,
        sessionId: env.BOT_SESSION_ID?.trim() || 'tox',
        authDir: env.AUTH_DIR?.trim() || '.auth',
        allowedGroupJids: new Set(list(env.ALLOWED_GROUP_JIDS)),
        allowPrivateChats: parseBoolean('ALLOW_PRIVATE_CHATS', env.ALLOW_PRIVATE_CHATS, false),
        commandPrefixes: list(env.COMMAND_PREFIXES ?? '!,/'),
        logLevel,
        alertsPollIntervalMs
    }
}
