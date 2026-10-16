import { ConsoleLogger } from 'zapo-js'

import { loadConfig, loadEnvFile, parseMode } from './config.ts'
import { createBot } from './whatsapp.ts'

const mode = parseMode(process.argv.slice(2))
loadEnvFile(process.env, mode)
const config = loadConfig(process.env, mode)
const logger = new ConsoleLogger(config.logLevel)

const bot = createBot(config, logger)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        logger.info(`Received ${signal}, disconnecting`)
        bot.stop().finally(() => process.exit())
    })
}

logger.info('Starting tox-whatsapp-bot', {
    mode: config.mode,
    api: config.toxApiUrl,
    allowedGroups: config.allowedGroupJids.size || 'all',
    privateChats: config.allowPrivateChats
})
await bot.connect()
