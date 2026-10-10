import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findBlacklisted } from '../src/blacklist.ts'

const members = [
    { jid: '111@lid', ids: ['111@lid', '59891@s.whatsapp.net'] },
    { jid: '222@lid', ids: ['222@lid'] }
]

test('a member is matched by any of their ids', () => {
    assert.deepEqual(findBlacklisted(members, [{ user_ids: ['59891@s.whatsapp.net'] }]).map((m) => m.jid), ['111@lid'])
    assert.deepEqual(findBlacklisted(members, [{ user_ids: ['222@lid', '999@lid'] }]).map((m) => m.jid), ['222@lid'])
})

test('nobody is removed when nobody matches or the list is empty', () => {
    assert.deepEqual(findBlacklisted(members, []), [])
    assert.deepEqual(findBlacklisted(members, [{ user_ids: ['333@lid'] }]), [])
})
