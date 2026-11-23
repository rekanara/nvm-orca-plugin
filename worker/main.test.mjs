// node --test worker/main.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWindowsAvailable, resolvePin } from './main.mjs'

// Shape of `nvm list available` from nvm-windows 1.1/1.2.
const TABLE = `
|   CURRENT    |     LTS      |  OLD STABLE  | OLD UNSTABLE |
|--------------|--------------|--------------|--------------|
|    25.2.1    |   24.11.1    |   0.12.18    |   0.11.16    |
|    24.10.0   |   22.21.1    |   0.12.17    |   0.11.15    |

This is a partial list. For a complete list, visit https://nodejs.org/en/download/releases
`.replace(/\n/g, '\r\n').replace(/\r/g, '')

test('parseWindowsAvailable', () => {
  assert.deepEqual(parseWindowsAvailable(TABLE, 'lts'), [
    { version: 'v24.11.1', label: 'LTS' },
    { version: 'v22.21.1', label: 'LTS' }
  ])
  assert.deepEqual(parseWindowsAvailable(TABLE, 'all').map((r) => r.version), ['v24.11.1', 'v25.2.1', 'v22.21.1', 'v24.10.0'])
})

test('resolvePin', () => {
  const installed = ['v24.13.1', 'v22.22.0', 'v22.1.0', 'v20.20.2']
  assert.equal(resolvePin('22', installed), 'v22.22.0')
  assert.equal(resolvePin('v22.1', installed), 'v22.1.0')
  assert.equal(resolvePin('20.20.2', installed), 'v20.20.2')
  assert.equal(resolvePin('18', installed), null)
  assert.equal(resolvePin('lts/jod', installed), null)
})
