# Ledger

A double-entry accounting engine on SQLite. Journal entries are immutable, every one is
checked for balance before a row is written, amounts are integer minor units, and closed
periods stop accepting new activity.

Zero dependencies — `node:sqlite` and the standard library only.

## Run it

Requires Node 24+.

```bash
node --test
```

## The hard part: making wrong books impossible

An accounting system is a good place to practise refusing input. Ledger enforces four
invariants and enforces them *before* the transaction opens, so a rejected entry cannot
leave half a journal behind:

1. **Debits equal credits.** Not approximately — exactly, as integers.
2. **Amounts are positive integers in minor units.** `0.1 + 0.2` is not `0.3` in floating
   point, and a ledger that drifts by a cent per thousand postings is worse than useless.
3. **At least two postings, and a non-zero total.** A single-sided entry is not double entry.
4. **Both accounts exist, and the period is open.** A closed month is history.

Balances are reported in each account's **normal direction**: assets and expenses read
positive when debited, liabilities, equity and revenue read positive when credited. That is
why paying a supplier shows the payable at `-400` rather than `+400` — the number means
"this account moved against its nature".

## Model

```
accounts (code, name, type, normal_side)
entries  (id, memo, period, occurred_at, idempotency_key)
postings (entry_id, account_code, direction, amount)
periods  (period, closed_at)
```

An `entry` is the journal; `postings` are its legs. An entry is never updated or deleted —
a correction is a new, opposite entry, which is how real books work and why the audit trail
is trustworthy.

## API

| Method | Behaviour |
| --- | --- |
| `createAccount(code, name, type)` | Validates the code shape, the type, and uniqueness. |
| `post(input)` | Validates, then writes entry + postings in one transaction. Returns `{ entry, deduped }`. |
| `balance(code)` | Net balance in the account's normal direction. |
| `totals(code)` | Raw debit and credit sums. |
| `trialBalance()` | Every account plus `totalDebit`, `totalCredit` and `balanced`. |
| `entries(period?)` | Journal entries, oldest first, optionally filtered by period. |
| `closePeriod(period)` | Freezes a month. Closing twice throws. |
| `isClosed(period)` / `closedPeriods()` | Period state. |

`occurredAt` is supplied by the caller rather than read from the clock, so entries can be
backfilled with their true dates and tests never depend on wall time.

## Design decisions

**Idempotency resolves before the closed-period check.** If a payment retry arrives after
midnight on the 1st, the money already moved — the caller should get the original entry
back, not a `PeriodClosedError` that suggests the transfer failed. Getting this order
backwards turns a successful charge into a duplicate one.

**Rejections happen before `BEGIN`.** Every structural rule runs first, so the failure path
cannot leave an entry with two of its three postings.

**No update or delete methods exist.** The API has no way to rewrite history, which means no
bug in a caller can produce books that do not reconcile.

**Report sign conventions are explicit.** `balance()` and `totals()` answer different
questions, and the `normalSide` mapping is exported rather than duplicated in reports.

## Tests

Balance direction per account type, rejection of unbalanced / zero / negative / fractional
entries with nothing written, unknown-account refusal, trial-balance identity across mixed
entries, exactness over 100 single-cent postings, idempotent replay counting once, replay
surviving a period close, closed-period enforcement, per-period listing, and account
validation.
