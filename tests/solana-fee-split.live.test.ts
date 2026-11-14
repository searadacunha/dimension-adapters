import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// Live test against a public Solana RPC (no key): checks on real blocks the split that fees/solana.ts
// books, and the slot where it changes. For each block, T = sum of meta.fee, R = the leader's "Fee"
// reward, B = 5000 lamports per fee-bearing signature (tx signatures + precompile signatures).
// Before SIMD-0096 the leader gets T - floor(T / 2); from it, B - floor(B / 2) + (T - B).
// Run with:
// node --test -r ts-node/register/transpile-only tests/solana-fee-split.live.test.ts
// (SOLANA_LIVE_RPC overrides the endpoint; it must serve historical blocks.)

const RPC = process.env.SOLANA_LIVE_RPC ?? 'https://api.mainnet-beta.solana.com'
const SIMD_0096_FEATURE = '3opE3EzAKnUftUDURkzMgwpNgimBAypW1mNDYH4x4Zg7'
const ACTIVATION_SLOT = 320112000
const PRECOMPILES = new Set([
  'Ed25519SigVerify111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111',
  'Secp256r1SigVerify1111111111111111111111111',
])
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      continue
    }
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
    const body: any = await res.json()
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
    return body.result
  }
}

// First byte of base58 instruction data: the number of signatures a precompile verifies.
function firstByte(data: string): number {
  if (data.length === 0 || data[0] === '1') return 0
  let n = 0n
  for (const c of data) {
    const v = B58.indexOf(c)
    if (v < 0) throw new Error(`not base58: ${data}`)
    n = n * 58n + BigInt(v)
  }
  const hex = n.toString(16)
  return parseInt((hex.length % 2 ? '0' + hex : hex).slice(0, 2), 16)
}

async function block(slot: number) {
  const b = await rpc('getBlock', [slot, { encoding: 'json', transactionDetails: 'full', rewards: true, maxSupportedTransactionVersion: 1 }])
  let fees = 0
  let signatures = 0
  for (const tx of b.transactions) {
    const { message } = tx.transaction
    const loaded = tx.meta.loadedAddresses ?? { writable: [], readonly: [] }
    const keys = [...message.accountKeys, ...loaded.writable, ...loaded.readonly]
    fees += tx.meta.fee
    signatures += tx.transaction.signatures.length
    for (const ix of message.instructions) if (PRECOMPILES.has(keys[ix.programIdIndex])) signatures += firstByte(ix.data)
  }
  const rewards = (b.rewards ?? []).filter((r: any) => r.rewardType === 'Fee')
  const leader = rewards.reduce((sum: number, r: any) => sum + r.lamports, 0)
  return { fees, base: 5000 * signatures, leader, blockTime: b.blockTime as number, txs: b.transactions.length }
}

const preRule = (fees: number) => fees - Math.floor(fees / 2)
const postRule = (fees: number, base: number) => base - Math.floor(base / 2) + (fees - base)

test('the adapter uses the activation slot stored in the SIMD-0096 feature account', { timeout: 60_000 }, async () => {
  const account = await rpc('getAccountInfo', [SIMD_0096_FEATURE, { encoding: 'base64' }])
  assert.equal(account.value.owner, 'Feature111111111111111111111111111111111111')
  const data = Buffer.from(account.value.data[0], 'base64')
  assert.equal(data[0], 1, 'feature is activated')
  assert.equal(Number(data.readBigUInt64LE(1)), ACTIVATION_SLOT)
  assert.equal(await rpc('getBlockTime', [ACTIVATION_SLOT]), 1739343548) // 2025-02-12T06:59:08Z
  const source = readFileSync(join(__dirname, '..', 'fees', 'solana.ts'), 'utf8')
  assert.match(source, new RegExp(`SIMD_0096_ACTIVATION_SLOT = ${ACTIVATION_SLOT}\\b`))
})

// 319941000 is 2025-02-11 12:10 UTC, 320076000 is 2025-02-12 03:01 UTC: both still half burn priority fees.
for (const slot of [319941000, 320076000, 320111998, 320111999]) {
  test(`slot ${slot} (before SIMD-0096): half of every fee is burned`, { timeout: 120_000 }, async () => {
    const b = await block(slot)
    assert.ok(b.txs > 0 && b.fees > b.base, 'block carries priority fees')
    assert.equal(b.leader, preRule(b.fees))
    assert.notEqual(b.leader, postRule(b.fees, b.base))
  })
}

// 320112001 is the first block after the empty epoch-boundary block; 467512927 is from November 2026.
for (const slot of [320112001, 320112002, 467512927]) {
  test(`slot ${slot} (from SIMD-0096): half of the base fee is burned, the leader keeps the priority fee`, { timeout: 120_000 }, async () => {
    const b = await block(slot)
    assert.ok(b.txs > 0 && b.fees > b.base, 'block carries priority fees')
    assert.equal(b.leader, postRule(b.fees, b.base))
    assert.notEqual(b.leader, preRule(b.fees))
  })
}
