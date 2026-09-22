import type { HandlerLogger } from './messageHandler.ts'

interface Deps {
    /** Digits-only phone number of the bot's account, or null when not configured. */
    phoneNumber: string | null
    requestPairingCode: (phoneNumber: string) => Promise<string>
    logger: HandlerLogger
}

/**
 * Requests the 8-character pairing code when an unpaired session connects.
 *
 * A fresh session first signals "pairing needed" as `auth_qr`; `auth_pairing_required` only
 * arrives later, when WhatsApp asks to refresh (e.g. the code expired). Both must trigger a request.
 */
export function createPairingController({ phoneNumber, requestPairingCode, logger }: Deps) {
    let requestedThisConnection = false
    let inFlight = false

    async function request(): Promise<void> {
        if (inFlight) return
        if (!phoneNumber) {
            logger.error('This session is not paired yet and BOT_PHONE_NUMBER is not set.')
            return
        }
        inFlight = true
        try {
            const code = await requestPairingCode(phoneNumber)
            logger.info(
                `PAIRING CODE: ${code} — on the bot's phone open WhatsApp > Linked devices > Link a device > Link with phone number instead`
            )
        } catch (error) {
            logger.error('Could not request a pairing code', { error: String(error) })
        } finally {
            inFlight = false
        }
    }

    return {
        /** QR refs arrive repeatedly; only the first one of a connection asks for a code. */
        async onQr(): Promise<void> {
            if (requestedThisConnection) return
            requestedThisConnection = true
            await request()
        },
        /** WhatsApp asks for a fresh pairing attempt. */
        onPairingRequired: request,
        onConnectionClosed(): void {
            requestedThisConnection = false
        }
    }
}
