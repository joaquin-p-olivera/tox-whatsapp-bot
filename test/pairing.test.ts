import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPairingController } from '../src/pairing.ts'
import { silentLogger } from './helpers.ts'

function setup(phoneNumber: string | null = '59800000000', fail = false) {
    const requested: string[] = []
    const logs: string[] = []
    const controller = createPairingController({
        phoneNumber,
        requestPairingCode: async (phone) => {
            requested.push(phone)
            if (fail) throw new Error('rejected')
            return 'ABCD-1234'
        },
        logger: { ...silentLogger, info: (m) => void logs.push(m), error: (m) => void logs.push(m) }
    })
    return { controller, requested, logs }
}

test('requests the code on the first QR of a fresh session (the case that was missed)', async () => {
    const { controller, requested, logs } = setup()
    await controller.onQr()
    assert.deepEqual(requested, ['59800000000'])
    assert.match(logs[0] ?? '', /PAIRING CODE: ABCD-1234/)
})

test('QR refs keep arriving but only the first requests a code', async () => {
    const { controller, requested } = setup()
    await controller.onQr()
    await controller.onQr()
    await controller.onQr()
    assert.equal(requested.length, 1)
})

test('auth_pairing_required requests a fresh code (refresh)', async () => {
    const { controller, requested } = setup()
    await controller.onQr()
    await controller.onPairingRequired()
    assert.equal(requested.length, 2)
})

test('a reconnect asks for a code again', async () => {
    const { controller, requested } = setup()
    await controller.onQr()
    controller.onConnectionClosed()
    await controller.onQr()
    assert.equal(requested.length, 2)
})

test('concurrent triggers only send one request', async () => {
    const { controller, requested } = setup()
    await Promise.all([controller.onQr(), controller.onPairingRequired()])
    assert.equal(requested.length, 1)
})

test('explains the problem when BOT_PHONE_NUMBER is missing', async () => {
    const { controller, requested, logs } = setup(null)
    await controller.onQr()
    assert.equal(requested.length, 0)
    assert.match(logs[0] ?? '', /BOT_PHONE_NUMBER is not set/)
})

test('logs and survives a rejected request, and allows retrying', async () => {
    const { controller, logs } = setup('59800000000', true)
    await assert.doesNotReject(controller.onQr())
    assert.match(logs[0] ?? '', /Could not request a pairing code/)
    await assert.doesNotReject(controller.onPairingRequired())
})
