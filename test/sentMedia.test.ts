import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeMedia } from '../src/messageHandler.ts'
import { describeQuoted, rememberSent } from '../src/sentMedia.ts'

test('a reply to the bot\'s media quotes what it was sent for, or at least what kind of thing it is', () => {
    rememberSent('A1', describeMedia('audio', '!risa', { text: '', about: 'Manda un audio de risa' }))
    rememberSent('B2', 'imagen: "🌴 Falta 00:00:23:59:45 para Grand Theft Auto VI 🦩"')

    assert.equal(describeQuoted({ stanzaId: 'A1', quotedMessage: { audioMessage: {} } }),
        '[audio: "Manda un audio de risa", en respuesta a "!risa"]')
    assert.equal(describeQuoted({ stanzaId: 'B2', quotedMessage: { imageMessage: {} } }),
        '[imagen: "🌴 Falta 00:00:23:59:45 para Grand Theft Auto VI 🦩"]')
    // Sent before a restart, or by somebody else: the kind of message is all there is
    assert.equal(describeQuoted({ stanzaId: 'old', quotedMessage: { audioMessage: {} } }), '[un audio]')
    assert.equal(describeQuoted({ stanzaId: 'old', quotedMessage: { imageMessage: {} } }), '[una foto]')
    assert.equal(describeQuoted({ stanzaId: 'C3', quotedMessage: { conversation: 'hola' } }), '') // text speaks for itself
    assert.equal(describeQuoted(undefined), '')
})
