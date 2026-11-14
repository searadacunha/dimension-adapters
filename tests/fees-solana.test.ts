import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Balances } from '@defillama/sdk'
import type { FetchOptions } from '../adapters/types'
import * as allium from '../helpers/allium'
import solana from '../fees/solana'

// Offline unit test of fees/solana.ts: the Allium query is replaced by fixed rows, so the
// split between burn (Revenue) and leader (SupplySideRevenue) is checked to the lamport.
// Run with:
// node --test -r ts-node/register/transpile-only tests/fees-solana.test.ts

const SOL = 'solana:So11111111111111111111111111111111111111112'
const DAY = 86400
const LEGACY_DAY = 1685577600 // 2023-06-01, before priority fees are required
const PRE_DAY = 1739145600 // 2025-02-10
const DAY_BEFORE_ACTIVATION = 1739232000 // 2025-02-11, every slot of it is before SIMD-0096
const ACTIVATION_DAY = 1739318400 // 2025-02-12, SIMD-0096 activates at 06:59:08 UTC (slot 320112000)
const POST_DAY = 1739404800 // 2025-02-13

type Row = Record<string, number | null>
let rows: Row[] = []
let queries: string[] = []
;(allium as any).queryAllium = async (query: string) => {
  queries.push(query)
  return rows
}

const fetch = (solana as any).fetch as (options: FetchOptions) => Promise<Record<string, Balances>>

async function run(start: number, row: Row | undefined, end = start + DAY) {
  rows = row ? [row] : []
  queries = []
  const options = {
    chain: 'solana',
    startTimestamp: start,
    endTimestamp: end,
    createBalances: () => new Balances({ chain: 'solana', timestamp: end }),
  } as unknown as FetchOptions
  return fetch(options)
}

const total = (b: Balances) => Number(b.getBalances()[SOL] ?? 0)
const labels = (b: Balances) => Object.fromEntries(
  Object.entries(b.getBreakdownBalances()).map(([label, v]) => [label, Number((v as Balances).getBalances()[SOL] ?? 0)]),
)

function assertIdentity(res: Record<string, Balances>) {
  assert.equal(total(res.dailyFees), total(res.dailyRevenue) + total(res.dailySupplySideRevenue))
  const fees = labels(res.dailyFees), rev = labels(res.dailyRevenue), ssr = labels(res.dailySupplySideRevenue)
  const base = fees['Transaction Base Fees'] ?? 0
  const prio = fees['Transaction Priority Fees'] ?? 0
  assert.equal(base, (rev['Transaction Base Fees'] ?? 0) + (ssr['Transaction Base Fees To Validators'] ?? 0))
  assert.equal(prio, (rev['Transaction Priority Fees'] ?? 0) + (ssr['Transaction Priority Fees To Validators'] ?? 0))
  // holders revenue = the burn, in its own instance (AGENTS.md: never one instance in two exports)
  assert.notEqual(res.dailyHoldersRevenue, res.dailyRevenue)
  assert.deepEqual(labels(res.dailyHoldersRevenue), rev)
}

test('day before the activation: half of all fees is burned (it was booked as post SIMD-0096)', async () => {
  const res = await run(DAY_BEFORE_ACTIVATION, {
    total_fees: 4_000_000_000_000, total_priority_fees: 3_400_000_000_000,
    pre_simd_0096_priority_fees: 3_400_000_000_000, fees_lag_seconds: 0,
  })
  assert.equal(total(res.dailyFees), 4_000_000_000_000)
  assert.equal(total(res.dailyRevenue), 2_000_000_000_000)
  assert.deepEqual(labels(res.dailySupplySideRevenue), {
    'Transaction Base Fees To Validators': 300_000_000_000,
    'Transaction Priority Fees To Validators': 1_700_000_000_000,
  })
  assertIdentity(res)
})

test('activation day: only the priority fees paid before slot 320112000 are half burned', async () => {
  const res = await run(ACTIVATION_DAY, {
    total_fees: 4_000_000_000_000, total_priority_fees: 3_500_000_000_000,
    pre_simd_0096_priority_fees: 1_000_000_000_000, fees_lag_seconds: 3,
  })
  assert.deepEqual(labels(res.dailyRevenue), {
    'Transaction Base Fees': 250_000_000_000,
    'Transaction Priority Fees': 500_000_000_000,
  })
  assert.deepEqual(labels(res.dailySupplySideRevenue), {
    'Transaction Base Fees To Validators': 250_000_000_000,
    'Transaction Priority Fees To Validators': 3_000_000_000_000,
  })
  assertIdentity(res)
})

test('after the activation: the leader keeps every priority fee', async () => {
  for (const start of [POST_DAY, 1794700800 /* 2026-11-15 */]) {
    const res = await run(start, {
      total_fees: 2_000_000_000_000, total_priority_fees: 1_700_000_000_000,
      pre_simd_0096_priority_fees: 0, fees_lag_seconds: 1,
    })
    assert.deepEqual(labels(res.dailyRevenue), { 'Transaction Base Fees': 150_000_000_000 })
    assert.deepEqual(labels(res.dailySupplySideRevenue), {
      'Transaction Base Fees To Validators': 150_000_000_000,
      'Transaction Priority Fees To Validators': 1_700_000_000_000,
    })
    assertIdentity(res)
  }
})

test('before 2024 a null priority sum means no priority fee: half of the total is burned', async () => {
  const res = await run(LEGACY_DAY, {
    total_fees: 9_000_000_001, total_priority_fees: null, pre_simd_0096_priority_fees: null, fees_lag_seconds: null,
  })
  assert.equal(total(res.dailyFees), 9_000_000_001)
  assert.equal(total(res.dailyRevenue), 4_500_000_000.5)
  assertIdentity(res)
})

test('the query splits by slot and keeps half-open windows on both tables', async () => {
  await run(PRE_DAY, { total_fees: 10, total_priority_fees: 4, pre_simd_0096_priority_fees: 4, fees_lag_seconds: 0 })
  const [query] = queries
  assert.match(query, /CASE WHEN block_slot < 320112000 THEN priority_fee ELSE 0 END/)
  assert.equal(query.split(`block_timestamp >= TO_TIMESTAMP_NTZ(${PRE_DAY})`).length - 1, 2)
  assert.equal(query.split(`block_timestamp < TO_TIMESTAMP_NTZ(${PRE_DAY + DAY})`).length - 1, 2)
})

test('missing or inconsistent rows throw instead of storing a number', async () => {
  const ok = { total_fees: 100, total_priority_fees: 60, pre_simd_0096_priority_fees: 0, fees_lag_seconds: 0 }
  const cases: Array<[Row | undefined, RegExp]> = [
    [undefined, /Missing Solana transaction fees/],
    [{ ...ok, total_fees: null }, /Missing Solana transaction fees/],
    [{ ...ok, total_priority_fees: null }, /Missing Solana priority fees/],
    [{ ...ok, fees_lag_seconds: 601 }, /lagging/],
    [{ ...ok, fees_lag_seconds: -1 }, /ahead/],
    [{ ...ok, total_priority_fees: 101 }, /Invalid Solana priority fees/],
    [{ ...ok, pre_simd_0096_priority_fees: 61 }, /Invalid Solana pre SIMD-0096 priority fees/],
    [{ ...ok, pre_simd_0096_priority_fees: -1 }, /Invalid Solana pre SIMD-0096 priority fees/],
  ]
  for (const [row, error] of cases) await assert.rejects(run(POST_DAY, row), error)
})

test('fees = revenue + supply side on 2000 random windows, to the lamport', async () => {
  let seed = 20250212 // mulberry32: deterministic, 32-bit integer arithmetic only
  const next = (max: number) => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max)
  }
  for (let i = 0; i < 2000; i++) {
    const totalFees = next(1e9) * 100_000 // up to 1e14 lamports (100k SOL), far below 2**53
    const priority = Math.floor(totalFees * next(1000) / 1000)
    const pre = Math.floor(priority * next(1001) / 1000)
    const res = await run(POST_DAY, { total_fees: totalFees, total_priority_fees: priority, pre_simd_0096_priority_fees: pre, fees_lag_seconds: 0 })
    assert.equal(total(res.dailyRevenue), (totalFees - priority) / 2 + pre / 2)
    assertIdentity(res)
  }
})

test('every label emitted is documented in breakdownMethodology, and every documented label is emitted', async () => {
  const seen: Record<string, Set<string>> = { Fees: new Set(), Revenue: new Set(), SupplySideRevenue: new Set(), HoldersRevenue: new Set() }
  for (const start of [DAY_BEFORE_ACTIVATION, ACTIVATION_DAY, POST_DAY]) {
    const res = await run(start, { total_fees: 1_000, total_priority_fees: 600, pre_simd_0096_priority_fees: start === POST_DAY ? 0 : 200, fees_lag_seconds: 0 })
    const byDimension: Record<string, Balances> = {
      Fees: res.dailyFees, Revenue: res.dailyRevenue, SupplySideRevenue: res.dailySupplySideRevenue, HoldersRevenue: res.dailyHoldersRevenue,
    }
    for (const [dim, b] of Object.entries(byDimension)) Object.keys(b.getBreakdownBalances()).forEach((l) => seen[dim].add(l))
  }
  const documented = (solana as any).breakdownMethodology as Record<string, Record<string, string>>
  for (const dim of Object.keys(seen)) assert.deepEqual([...seen[dim]].sort(), Object.keys(documented[dim]).sort(), dim)
  assert.deepEqual(Object.keys((solana as any).methodology).sort(), Object.keys(seen).sort())
})
