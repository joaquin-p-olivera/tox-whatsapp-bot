import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findPrivateLink } from '../src/links.ts'

test('finds a URL on a private or local address, with its port', () => {
    assert.equal(findPrivateLink('🟢 Frontend: http://192.168.1.21:5200'), 'http://192.168.1.21:5200')
    assert.equal(findPrivateLink('http://10.0.0.5/panel?x=1 y'), 'http://10.0.0.5/panel?x=1')
    assert.equal(findPrivateLink('mirá http://172.16.0.9:80, dale'), 'http://172.16.0.9:80')
    assert.equal(findPrivateLink('http://localhost:3000.'), 'http://localhost:3000')
})

test('takes the first one when there are several', () => {
    assert.equal(findPrivateLink('a http://192.168.1.21:5200\n\nb http://192.168.1.21:5201'), 'http://192.168.1.21:5200')
})

test('ignores public addresses, ranges that are not private, and text without a URL', () => {
    assert.equal(findPrivateLink('https://github.com/acme/proj/pull/1'), undefined)
    assert.equal(findPrivateLink('http://172.32.0.1:80'), undefined)
    assert.equal(findPrivateLink('http://8.8.8.8'), undefined)
    assert.equal(findPrivateLink('192.168.1.21:5200 sin http'), undefined)
    assert.equal(findPrivateLink('hola'), undefined)
})
