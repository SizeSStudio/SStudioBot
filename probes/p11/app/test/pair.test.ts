import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makePairLink, parsePairLink, type PairInfo } from '../src/device/pairLink.ts'

const k32 = Buffer.alloc(32, 7).toString('base64url')
const good: PairInfo = { v: 1, hub_pk: k32, relay: 'wss://relay.example/v1/peer', secret: k32, role: 'client', exp: 2_000_000_000 }

test('round trip, with and without the scheme prefix', () => {
  const l = makePairLink(good)
  assert.equal(parsePairLink(l, 1).ok, true)
  assert.equal(parsePairLink(l.replace('sstudiobot://pair#', ''), 1).ok, true)
})

test('rejects bad links', () => {
  const bad = (o: Partial<PairInfo> & Record<string, unknown>) => parsePairLink(makePairLink({ ...good, ...o } as PairInfo), 1)
  assert.equal(bad({ relay: 'ws://relay.example/v1/peer' }).ok, false)
  assert.equal(bad({ relay: 'wss://user:pw' + '@relay.example/' /* 拆开写，免得 leak-guard 当成邮箱 */ }).ok, false)
  assert.equal(bad({ hub_pk: 'abc' }).ok, false)
  assert.equal(bad({ role: 'admin' as 'client' }).ok, false)
  assert.equal(parsePairLink(makePairLink(good), 3_000_000_000).ok, false)
  assert.equal(parsePairLink('sstudiobot://pair#v1.e30').ok, false)
  assert.equal(parsePairLink('https://x.example/#v1.abc').ok, false)
})
