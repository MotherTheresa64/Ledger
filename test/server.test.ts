import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.ts";

async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("the page and the seeded books are served", async () => {
  await withServer(async (url) => {
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Ledger/);

    const data = await (await fetch(`${url}/accounts`)).json();
    assert.equal(data.accounts.length, 4);
    assert.equal(data.accounts.find((a: { code: string }) => a.code === "1000").balance, 380_000);
    assert.equal(data.trialBalance.balanced, true);
    assert.equal(data.trialBalance.totalDebit, data.trialBalance.totalCredit);
  });
});

test("a balanced entry moves both sides", async () => {
  await withServer(async (url) => {
    const res = await post(url, "/entries", { memo: "Coffee", debit: "5000", credit: "1000", amount: 1250 });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.entry.postings.length, 2);
    assert.equal(body.deduped, false);

    const accounts = await (await fetch(`${url}/accounts`)).json();
    assert.equal(accounts.accounts.find((a: { code: string }) => a.code === "5000").balance, 121_250);
    assert.equal(accounts.accounts.find((a: { code: string }) => a.code === "1000").balance, 378_750);
    assert.equal(accounts.trialBalance.balanced, true);
  });
});

test("an unbalanced or half-cent entry is refused without writing anything", async () => {
  await withServer(async (url) => {
    const zero = await post(url, "/entries", { memo: "Nothing", debit: "1000", credit: "4000", amount: 0 });
    assert.equal(zero.status, 400);

    const fractional = await post(url, "/entries", { memo: "Half cent", debit: "1000", credit: "4000", amount: 12.5 });
    assert.equal(fractional.status, 400);

    const unknownAccount = await post(url, "/entries", { memo: "Ghost", debit: "9999", credit: "1000", amount: 100 });
    assert.equal(unknownAccount.status, 404);

    const entries = await (await fetch(`${url}/entries`)).json();
    assert.equal(entries.entries.length, 2);
  });
});

test("a closed period refuses new entries but keeps existing ones", async () => {
  await withServer(async (url) => {
    const periods = await (await fetch(`${url}/periods`)).json();
    const closed = await post(url, "/periods/close", { period: periods.current });
    assert.equal(closed.status, 200);

    const rejected = await post(url, "/entries", { memo: "Too late", debit: "5000", credit: "1000", amount: 100 });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error, "period_closed");

    assert.equal((await (await fetch(`${url}/entries`)).json()).entries.length, 2);
    assert.deepEqual((await (await fetch(`${url}/periods`)).json()).closed, [periods.current]);
  });
});

test("a replayed entry is deduped rather than posted twice", async () => {
  await withServer(async (url) => {
    const first = await (await post(url, "/entries", {
      memo: "Invoice 1",
      debit: "1000",
      credit: "4000",
      amount: 9000,
      idempotencyKey: "invoice-1",
    })).json();
    const second = await (await post(url, "/entries", {
      memo: "Invoice 1",
      debit: "1000",
      credit: "4000",
      amount: 9000,
      idempotencyKey: "invoice-1",
    })).json();

    assert.equal(second.deduped, true);
    assert.equal(second.entry.id, first.entry.id);
    assert.equal((await (await fetch(`${url}/entries`)).json()).entries.length, 3);
  });
});
