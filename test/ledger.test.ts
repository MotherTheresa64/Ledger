import test from "node:test";
import assert from "node:assert/strict";
import {
  Ledger,
  NotFoundError,
  PeriodClosedError,
  ValidationError,
  type Posting,
} from "../src/ledger.ts";

const T0 = 1_700_000_000_000;
const PERIOD = "2026-11";

function books(): Ledger {
  const l = new Ledger();
  l.createAccount("1000", "Cash", "asset", T0);
  l.createAccount("1200", "Accounts Receivable", "asset", T0);
  l.createAccount("2000", "Accounts Payable", "liability", T0);
  l.createAccount("3000", "Owner Equity", "equity", T0);
  l.createAccount("4000", "Subscription Revenue", "revenue", T0);
  l.createAccount("5000", "Hosting Expense", "expense", T0);
  return l;
}

function cashSale(amount: number): Posting[] {
  return [
    { account: "1000", direction: "debit", amount },
    { account: "4000", direction: "credit", amount },
  ];
}

test("accounts expose the balance side implied by their type", () => {
  const l = books();
  assert.equal(l.getAccount("1000")!.normalSide, "debit");
  assert.equal(l.getAccount("2000")!.normalSide, "credit");
  assert.equal(l.getAccount("4000")!.normalSide, "credit");
  assert.equal(l.getAccount("5000")!.normalSide, "debit");
});

test("a balanced entry posts and moves both sides", () => {
  const l = books();
  const { entry, deduped } = l.post({ memo: "First subscription", period: PERIOD, occurredAt: T0, postings: cashSale(2_500) }, T0);

  assert.equal(deduped, false);
  assert.equal(entry.memo, "First subscription");
  assert.equal(entry.postings.length, 2);
  assert.equal(l.balance("1000"), 2_500);
  assert.equal(l.balance("4000"), 2_500, "revenue is credit-normal, so credits read as positive");
  assert.equal(l.getEntry(entry.id)!.id, entry.id);
});

test("an unbalanced entry is rejected and writes nothing", () => {
  const l = books();
  assert.throws(
    () =>
      l.post({
        memo: "Broken",
        period: PERIOD,
        occurredAt: T0,
        postings: [
          { account: "1000", direction: "debit", amount: 100 },
          { account: "4000", direction: "credit", amount: 90 },
        ],
      }),
    ValidationError,
  );
  assert.equal(l.entries().length, 0);
  assert.deepEqual(l.totals("1000"), { debit: 0, credit: 0 });
  assert.equal(l.trialBalance().balanced, true, "empty books balance");
});

test("structural rules are enforced before anything is stored", () => {
  const l = books();
  const base = { memo: "x", period: PERIOD, occurredAt: T0 };

  assert.throws(() => l.post({ ...base, postings: [cashSale(100)[0]] }), ValidationError, "needs two postings");
  assert.throws(
    () =>
      l.post({
        ...base,
        postings: [
          { account: "1000", direction: "debit", amount: 0 },
          { account: "4000", direction: "credit", amount: 0 },
        ],
      }),
    ValidationError,
    "zero-value entries are meaningless",
  );
  assert.throws(
    () =>
      l.post({
        ...base,
        postings: [
          { account: "1000", direction: "debit", amount: -100 },
          { account: "4000", direction: "credit", amount: -100 },
        ],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      l.post({
        ...base,
        postings: [
          { account: "1000", direction: "debit", amount: 1.5 },
          { account: "4000", direction: "credit", amount: 1.5 },
        ],
      }),
    ValidationError,
    "money is integer minor units, never floats",
  );
  assert.throws(() => l.post({ ...base, memo: "  ", postings: cashSale(100) }), ValidationError);
  assert.throws(() => l.post({ ...base, period: "2026-13", postings: cashSale(100) }), ValidationError);
  assert.equal(l.entries().length, 0);
});

test("posting to an account that does not exist is refused", () => {
  const l = books();
  assert.throws(
    () =>
      l.post({
        memo: "ghost",
        period: PERIOD,
        occurredAt: T0,
        postings: [
          { account: "1000", direction: "debit", amount: 100 },
          { account: "9999", direction: "credit", amount: 100 },
        ],
      }),
    NotFoundError,
  );
});

test("balances respect the account's normal side", () => {
  const l = books();
  // Pay down a payable: debit the liability.
  l.post({
    memo: "Pay supplier",
    period: PERIOD,
    occurredAt: T0,
    postings: [
      { account: "2000", direction: "debit", amount: 400 },
      { account: "1000", direction: "credit", amount: 400 },
    ],
  });
  assert.equal(l.balance("2000"), -400, "a debit on a credit-normal account reduces it");
  assert.equal(l.balance("1000"), -400);
});

test("expenses and revenue accumulate independently", () => {
  const l = books();
  l.post({ memo: "sale", period: PERIOD, occurredAt: T0, postings: cashSale(10_000) });
  l.post({
    memo: "hosting",
    period: PERIOD,
    occurredAt: T0,
    postings: [
      { account: "5000", direction: "debit", amount: 3_000 },
      { account: "1000", direction: "credit", amount: 3_000 },
    ],
  });
  assert.equal(l.balance("4000"), 10_000);
  assert.equal(l.balance("5000"), 3_000);
  assert.equal(l.balance("1000"), 7_000, "cash is what is left after the expense");
});

test("the trial balance always nets to zero", () => {
  const l = books();
  l.post({ memo: "a", period: PERIOD, occurredAt: T0, postings: cashSale(1_234) });
  l.post({
    memo: "b",
    period: PERIOD,
    occurredAt: T0 + 1,
    postings: [
      { account: "1200", direction: "debit", amount: 999 },
      { account: "4000", direction: "credit", amount: 999 },
    ],
  });
  l.post({
    memo: "c",
    period: PERIOD,
    occurredAt: T0 + 2,
    postings: [
      { account: "2000", direction: "credit", amount: 555 },
      { account: "5000", direction: "debit", amount: 555 },
    ],
  });

  const tb = l.trialBalance();
  assert.equal(tb.balanced, true);
  assert.equal(tb.totalDebit, tb.totalCredit);
  assert.equal(tb.totalDebit, 1_234 + 999 + 555);
  assert.equal(tb.rows.length, 6);
  assert.deepEqual(
    tb.rows.map((r) => r.code),
    ["1000", "1200", "2000", "3000", "4000", "5000"],
    "rows come back in account-code order",
  );
  assert.equal(l.balance("3000"), 0, "an untouched account is zero");
});

test("integer minor units do not drift", () => {
  const l = books();
  for (let i = 0; i < 100; i++) {
    l.post({ memo: `penny ${i}`, period: PERIOD, occurredAt: T0 + i, postings: cashSale(1) });
  }
  assert.equal(l.balance("1000"), 100);
  assert.equal(l.balance("4000"), 100);
});

test("an idempotency key makes a retried post a no-op", () => {
  const l = books();
  const input = {
    memo: "Charge customer",
    period: PERIOD,
    occurredAt: T0,
    postings: cashSale(4_200),
    idempotencyKey: "charge-abc",
  };

  const first = l.post(input, T0);
  const second = l.post(input, T0 + 5_000);

  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(second.entry.id, first.entry.id, "the caller gets the original entry back");
  assert.equal(l.entries().length, 1);
  assert.equal(l.balance("1000"), 4_200, "the money moved exactly once");
});

test("closing a period stops new postings but keeps existing ones readable", () => {
  const l = books();
  l.post({ memo: "before close", period: PERIOD, occurredAt: T0, postings: cashSale(700) });
  l.closePeriod(PERIOD, T0 + 10);

  assert.equal(l.isClosed(PERIOD), true);
  assert.deepEqual(l.closedPeriods(), [PERIOD]);
  assert.throws(
    () => l.post({ memo: "after close", period: PERIOD, occurredAt: T0 + 11, postings: cashSale(100) }),
    PeriodClosedError,
  );
  assert.equal(l.entries(PERIOD).length, 1, "the closed period still reports its entries");
  assert.throws(() => l.closePeriod(PERIOD), ValidationError, "closing twice is a mistake, not a no-op");
});

test("a replayed idempotency key still resolves after the period closes", () => {
  const l = books();
  const input = {
    memo: "late retry",
    period: PERIOD,
    occurredAt: T0,
    postings: cashSale(1_000),
    idempotencyKey: "retry-1",
  };
  const first = l.post(input, T0);
  l.closePeriod(PERIOD, T0 + 1);

  const replay = l.post(input, T0 + 2);
  assert.equal(replay.deduped, true);
  assert.equal(replay.entry.id, first.entry.id, "the retry must not fail because the books closed");
  assert.equal(l.balance("1000"), 1_000);
});

test("entries can be listed per period and in insertion order", () => {
  const l = books();
  l.post({ memo: "nov-1", period: "2026-11", occurredAt: T0, postings: cashSale(100) }, T0);
  l.post({ memo: "dec-1", period: "2026-12", occurredAt: T0, postings: cashSale(200) }, T0 + 1_000);
  l.post({ memo: "nov-2", period: "2026-11", occurredAt: T0, postings: cashSale(300) }, T0 + 2_000);

  assert.deepEqual(l.entries("2026-11").map((e) => e.memo), ["nov-1", "nov-2"]);
  assert.deepEqual(l.entries("2026-12").map((e) => e.memo), ["dec-1"]);
  assert.equal(l.entries().length, 3);
  assert.deepEqual(l.entries("2027-01"), []);
});

test("account creation is validated", () => {
  const l = new Ledger();
  assert.throws(() => l.createAccount("abc", "Bad", "asset"), ValidationError);
  assert.throws(() => l.createAccount("12", "Short", "asset"), ValidationError);
  assert.throws(() => l.createAccount("1234567", "Long", "asset"), ValidationError);
  assert.throws(() => l.createAccount("1000", "", "asset"), ValidationError);
  assert.throws(() => l.createAccount("1000", "Weird", "goodwill" as never), ValidationError);

  l.createAccount("1000", "Cash", "asset");
  assert.throws(() => l.createAccount("1000", "Cash again", "asset"), ValidationError);
  assert.equal(l.accounts().length, 1);
});
