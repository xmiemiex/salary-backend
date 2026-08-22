# Task 102: PhotonPay provider USD debit settlement and alias-card backfill

## Locked baseline

- Starting `origin/main`: `dc37bfd44b4e138fc977e9c1fc07e4e2adbebe5d`
- Starting production version: `task101-dc37bfd44b4e`
- PhotonPay inventory: 323 total, 322 matched, 1 excluded, 0 unmatched, 0 conflict
- Alias target: 60 cards with `provider_email_alias`
- Exclusion: the single `admin_test_card` has zero historical `CardSpendEvent` rows
- `SYNC_PLANNER_ENABLED=false`
- `SYNC_AUTO_EXECUTION_ENABLED=false`
- PhotonPay webhook remains disabled

## Root cause and provider field evidence

The old adapter treated `transactionAmount`/`transactionCurrency` as the final USD spend. It therefore failed every settled non-USD transaction with `INVALID_CURRENCY`, incremented `failedCount`, and created no financial event. It also used an upsert update branch that could silently replace an existing financial amount.

The corrected source field is `txnPrincipalChangeSettledAmount`, paired with `txnPrincipalChangeCurrency`. The primary vendor reference is the [PhotonPay v4 transaction detail API](https://api-doc.photonpay.com/#tag/%E4%BA%A4%E6%98%93%E6%98%8E%E7%BB%86/paths/~1vcc~1openApi~1v4~1pagingVccTradeOrder/get).

- PhotonPay official transaction detail documentation returns `txnPrincipalChangeSettledAmount` in the single-transaction and paging transaction record shape.
- PhotonPay official settlement documentation independently defines settlement amount/currency as the actual settlement values. Webhook delivery is not enabled and is not introduced by this task.
- The production 2026-08-19 Asia/Shanghai Portal window contains 158 rows and 147 settled consumption rows. Portal columns show original `交易金额`, USD `交易本金金额`, and USD `交易本金已结算金额` for the same transaction.
- The production paging API exposes `txnPrincipalChangeSettledAmount` on all 147 settled consumption rows, always paired with `txnPrincipalChangeCurrency=USD` and a negative account-change sign.
- Portal export and API aggregates match exactly:

| Original currency | Settled count | Original amount | Provider settled USD debit |
| --- | ---: | ---: | ---: |
| USD | 80 | 404.53 | 404.53 |
| EUR | 47 | 154.38 | 179.62 |
| JPY | 2 | 43,233 | 273.48 |
| VND | 18 | 2,012,879 | 76.92 |
| Total | 147 | n/a | 934.55 |

The 67 non-USD rows therefore have an actual provider USD debit total of 530.02. No exchange rate is calculated or stored by the application.

A separately downloaded PhotonPay account-fund report confirms that issuing account changes are denominated in USD. A newly generated report requested for the full July range still contains data only from 2026-07-01 through 2026-07-26, so it is supporting field evidence and is explicitly not treated as the final full-July reconciliation artifact.

Portal account-level exports captured before release provide the bounded reconciliation baselines below. They contain transaction-level identifiers locally, but only these aggregates are retained in this record:

| GMT+8 transaction window | Portal rows | Successful settled consumption | Portal USD principal amount |
| --- | ---: | ---: | ---: |
| 2026-07-01 00:00 through 2026-08-01 00:00 | 6,842 | 5,807 | 38,504.81 |
| 2026-08-01 00:00 through 2026-08-22 00:00 | 1,233 | 834 | 6,603.31 |

These are account-level baselines, not the 60-card backfill totals. Production preview and execution must filter the exact alias-card target set and reconcile that subset by transaction key without exposing identifiers.

## Accounting and failure semantics

- Only successful, settled `AUTH` and `CORRECTIVE_AUTH` consumption types are eligible.
- `transactionAmount` and `transactionCurrency` remain the original transaction audit values in `CardSpendEvent.amount` and `CardSpendEvent.currency`.
- The absolute value of the negative `txnPrincipalChangeSettledAmount` is stored in `CardSpendEvent.spendUsd`; its currency must be USD.
- The raw negative provider account change, its USD currency, the positive posted USD amount, and the source field name are retained in allowlisted `rawData`.
- Missing provider amount fails with `PROVIDER_USD_DEBIT_AMOUNT_MISSING`.
- Non-string, non-USD, zero, positive, more-than-six-decimal, or out-of-range provider values fail with `PROVIDER_USD_DEBIT_AMOUNT_INVALID`.
- Existing identical external IDs are skipped. Any financial or attribution difference fails closed with `PROVIDER_USD_DEBIT_AMOUNT_MISMATCH`; no update branch exists.
- Refund, refund correction, reversal, void, authorization-only, failed, and non-settled rows do not create positive consumption events.
- An accounting-excluded card is rejected before event creation and does not increment `failedCount`.

## Database decision

No migration is required. Existing columns already provide the necessary exact and auditable representation:

- `amount Decimal(18,6)`: original transaction amount
- `currency VarChar(8)`: original transaction currency
- `spendUsd Decimal(18,6)`: provider actual USD debit
- `rawData Json`: allowlisted source-field and sign evidence
- unique `(provider, externalEventId)`: idempotency key

No existing financial amount is overwritten.

## Historical control surface

The PhotonPay card-spend task accepts a mutually exclusive `historicalBackfill` object:

```json
{
  "settlementMonth": "2026-07",
  "historicalBackfill": {
    "from": "2026-06-30T16:00:00.000Z",
    "to": "2026-07-07T16:00:00.000Z",
    "previewOnly": true
  }
}
```

Controls are enforced server-side:

- start cannot precede 2026-07-01 00:00 Asia/Shanghai;
- both boundaries must be Asia/Shanghai natural-day midnights;
- each provider query window is one through seven complete days;
- the window must stay inside the selected GMT+8 month and cannot include the current incomplete day;
- the target set is hard-locked to exactly 60 matched `provider_email_alias` cards;
- excluded cards are counted separately; all other cards are non-target and cannot create events;
- preview mode performs no inventory refresh, unmatched-event write, card-spend write, or transaction-sync status write;
- execution mode keeps external transaction idempotency and never updates an existing amount.

## Safe result statistics

The adapter reports counts and Decimal string totals only, including:

- `settledUsdTransactionCount`
- `settledConvertedToUsdCount`
- `providerUsdDebitAmountTotal`
- `missingProviderUsdDebitAmountCount`
- `invalidProviderUsdDebitAmountCount`
- `excludedCardTransactionCount`
- `nonTargetCardTransactionCount`
- `targetCardCount`
- `targetSettledTransactionCount`
- missing external id, card id, transaction time, and ownership-failure counts
- ownership failures grouped by safe reason code
- per-currency settled and target-set counts
- preview expected-create and existing counts

No complete transaction ID, card ID, email, card number, token, or credential appears in task result statistics or this record.

## Production gates still required

Before historical execution, the immutable release must pass the normal backup, migration-drift, health, rollback, and feature-flag gates. Then:

1. Run the task100 2026-08-19 GMT+8 window twice and reconcile all 147 settled rows / USD 934.55; the first run must not duplicate the existing 80 USD events, and the second must create zero.
2. Use the frozen historical end boundary `2026-08-22 00:00:00 Asia/Shanghai` (`2026-08-21T16:00:00.000Z`), captured during preview preparation.
3. Preview and execute July and August in seven-day-or-smaller slices, stopping on any anomaly.
4. Re-run every fixed slice and require zero created events and no total increase.
5. Reconcile full July and fixed-window August totals against Portal/account statements.

This document records technical facts and controls only; product acceptance remains a separate decision.
