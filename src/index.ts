import { ConsoleLogger } from 'zapo-js'

import { loadConfig, loadEnvFile } from './config.ts'
import { createBot } from './whatsapp.ts'

loadEnvFile()
const config = loadConfig()
const logger = new ConsoleLogger(config.logLevel)

const bot = createBot(config, logger)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        logger.info(`Received ${signal}, disconnecting`)
        bot.stop().finally(() => process.exit())
    })
}

logger.info('Starting tox-whatsapp-bot', {
    api: config.toxApiUrl,
    allowedGroups: config.allowedGroupJids.size || 'all',
    privateChats: config.allowPrivateChats
})
await bot.connect()
