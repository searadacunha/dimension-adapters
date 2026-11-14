import ADDRESSES from '../helpers/coreAssets.json'
import { Adapter, Dependencies, FetchOptions, ProtocolType } from "../adapters/types";
import { queryAllium } from "../helpers/allium";
import { CHAIN } from "../helpers/chains";
import { METRIC } from "../helpers/metrics";
// import { queryDuneSql } from "../helpers/dune";

const SIMD_0096_ACTIVATION_DATE = 1739318400 // after 2025-02-12 priority fees will go 100% to validators;
const PRIORITY_FEES_REQUIRED_FROM = 1704067200 // 2024-01-01, from here priority fee txs land every few seconds, so missing or stale rows mean Allium lag
const BASE_FEES_TO_VALIDATORS = 'Transaction Base Fees To Validators'
const PRIORITY_FEES_TO_VALIDATORS = 'Transaction Priority Fees To Validators'

const fetch = async (options: FetchOptions) => {
  const dailyFees = options.createBalances()
  const dailyRevenue = options.createBalances()

  const alliumFeequery = `
    WITH txs AS (
        SELECT
            SUM(fee) AS total_fees,
            MAX(block_timestamp) AS txs_max_ts
        FROM solana.raw.transactions
        WHERE block_timestamp >= TO_TIMESTAMP_NTZ(${options.startTimestamp}) AND block_timestamp < TO_TIMESTAMP_NTZ(${options.endTimestamp})
    ), priority AS (
        SELECT
            SUM(priority_fee) AS total_priority_fees,
            MAX(block_timestamp) AS fees_max_ts
        FROM solana.raw.fees
        WHERE block_timestamp >= TO_TIMESTAMP_NTZ(${options.startTimestamp}) AND block_timestamp < TO_TIMESTAMP_NTZ(${options.endTimestamp})
    )
    SELECT
        total_fees,
        total_priority_fees,
        DATEDIFF('second', fees_max_ts, txs_max_ts) AS fees_lag_seconds
    FROM txs CROSS JOIN priority
  `;

  const res = await queryAllium(alliumFeequery);
  const row = res[0]
  if (!row || row.total_fees == null) throw new Error('Missing Solana transaction fees')
  const totalFees = Number(row.total_fees)
  if (options.startTimestamp >= PRIORITY_FEES_REQUIRED_FROM) {
    if (row.total_priority_fees == null) throw new Error('Missing Solana priority fees')
    const feesLagSeconds = Number(row.fees_lag_seconds)
    if (feesLagSeconds < 0) throw new Error('solana.raw.fees is ahead of solana.raw.transactions')
    if (feesLagSeconds > 600) throw new Error('solana.raw.fees is lagging solana.raw.transactions')
  }
  const totalPriorityFees = row.total_priority_fees == null ? 0 : Number(row.total_priority_fees)
  if (!Number.isFinite(totalFees) || !Number.isFinite(totalPriorityFees) || totalPriorityFees < 0 || totalPriorityFees > totalFees) {
    throw new Error('Invalid Solana priority fees')
  }
  const totalBaseFees = totalFees - totalPriorityFees

  // Same split as the burn below. Base fee is 50/50 burn and leader
  // (https://docs.anza.xyz/implemented-proposals/transaction-fees). Before SIMD-0096
  // priority fees were 50/50 too; since 2025-02-12 the leader keeps all of them
  // (https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0096-reward-full-priority-fee-to-validator.md).
  // The boundary is endTimestamp, matching the burn, so a window is not split in two.
  // Validator amounts are the residual of that same division, so fees = burn + validator share.
  const burnedBaseFees = totalBaseFees / 2
  const priorityFeesBurned = options.endTimestamp < SIMD_0096_ACTIVATION_DATE
  const burnedPriorityFees = priorityFeesBurned ? totalPriorityFees / 2 : 0
  const baseFeesToValidators = totalBaseFees - burnedBaseFees
  const priorityFeesToValidators = totalPriorityFees - burnedPriorityFees

  const dailySupplySideRevenue = options.createBalances()

  dailyFees.add(ADDRESSES.solana.SOL, totalBaseFees, METRIC.TRANSACTION_BASE_FEES)
  dailyFees.add(ADDRESSES.solana.SOL, totalPriorityFees, METRIC.TRANSACTION_PRIORITY_FEES)

  dailyRevenue.add(ADDRESSES.solana.SOL, burnedBaseFees, METRIC.TRANSACTION_BASE_FEES)
  if (priorityFeesBurned) {
    dailyRevenue.add(ADDRESSES.solana.SOL, burnedPriorityFees, METRIC.TRANSACTION_PRIORITY_FEES)
  }

  dailySupplySideRevenue.add(ADDRESSES.solana.SOL, baseFeesToValidators, BASE_FEES_TO_VALIDATORS)
  dailySupplySideRevenue.add(ADDRESSES.solana.SOL, priorityFeesToValidators, PRIORITY_FEES_TO_VALIDATORS)

  return {
    dailyFees,
    dailyRevenue,
    dailySupplySideRevenue,
    dailyHoldersRevenue: dailyRevenue.clone(1),
  };
}

const adapter: Adapter = {
  fetch,
  chains: [CHAIN.SOLANA],
  start: '2021-01-17',
  dependencies: [Dependencies.ALLIUM],
  isExpensiveAdapter: true,
  protocolType: ProtocolType.CHAIN,
  methodology: {
    Fees: 'Transaction fees paid by users',
    Revenue: 'Burned fees: 50% of base fees, and before 2025-02-12 also 50% of priority fees',
    HoldersRevenue: 'Burned fees: 50% of base fees, and before 2025-02-12 also 50% of priority fees',
    SupplySideRevenue: 'Transaction fees paid to the leader validator: half of the base fee, half of the priority fee before 2025-02-12, and the whole priority fee since then.',
  },
  breakdownMethodology: {
    Fees: {
      [METRIC.TRANSACTION_BASE_FEES]: 'Transaction base fees paid by users (5000 lamports per signature, including precompile signatures)',
      [METRIC.TRANSACTION_PRIORITY_FEES]: 'Transaction priority fees paid by users',
    },
    Revenue: {
      [METRIC.TRANSACTION_BASE_FEES]: '50% transaction base fees will be burned',
      [METRIC.TRANSACTION_PRIORITY_FEES]: 'Before 2025-02-12, 50% priority fees will be burned',
    },
    HoldersRevenue: {
      [METRIC.TRANSACTION_BASE_FEES]: '50% transaction base fees will be burned',
      [METRIC.TRANSACTION_PRIORITY_FEES]: 'Before 2025-02-12, 50% priority fees will be burned',
    },
    SupplySideRevenue: {
      [BASE_FEES_TO_VALIDATORS]: 'Half of the base fee, paid to the leader validator.',
      [PRIORITY_FEES_TO_VALIDATORS]: 'Priority fees paid to the leader validator: half before 2025-02-12, all of them since.',
    },
  }
}

export default adapter;
