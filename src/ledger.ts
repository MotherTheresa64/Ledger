import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class PeriodClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeriodClosedError";
  }
}

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type Direction = "debit" | "credit";

/** Asset and expense accounts increase on the debit side; the others increase on the credit side. */
export const NORMAL_SIDE: Record<AccountType, Direction> = {
  asset: "debit",
  expense: "debit",
  liability: "credit",
  equity: "credit",
  revenue: "credit",
};

export interface Account {
  code: string;
  name: string;
  type: AccountType;
  normalSide: Direction;
  createdAt: number;
}

export interface Posting {
  account: string;
  direction: Direction;
  /** Minor units (cents). Always a positive integer — direction carries the sign. */
  amount: number;
}

export interface JournalEntry {
  id: string;
  memo: string;
  period: string;
  occurredAt: number;
  createdAt: number;
  postings: Posting[];
  idempotencyKey: string | null;
}

export interface PostInput {
  memo: string;
  period: string;
  occurredAt: number;
  postings: Posting[];
  idempotencyKey?: string;
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: AccountType;
  debit: number;
  credit: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const ACCOUNT_CODE_PATTERN = /^[0-9]{3,6}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  normal_side TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id              TEXT PRIMARY KEY,
  memo            TEXT NOT NULL,
  period          TEXT NOT NULL,
  occurred_at     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  idempotency_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS entries_idempotency
  ON entries (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS postings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id     TEXT NOT NULL,
  account_code TEXT NOT NULL,
  direction    TEXT NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS postings_account ON postings (account_code);
CREATE INDEX IF NOT EXISTS postings_entry ON postings (entry_id);
CREATE TABLE IF NOT EXISTS periods (
  period    TEXT PRIMARY KEY,
  closed_at INTEGER NOT NULL
);
`;

export class Ledger {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore: report the original failure */
      }
      throw err;
    }
  }

  createAccount(code: string, name: string, type: AccountType, now = Date.now()): Account {
    if (!ACCOUNT_CODE_PATTERN.test(String(code))) {
      throw new ValidationError("account code must be 3-6 digits, e.g. 1000");
    }
    if (!Object.hasOwn(NORMAL_SIDE, type)) {
      throw new ValidationError(`unknown account type: ${type}`);
    }
    if (typeof name !== "string" || name.trim() === "") {
      throw new ValidationError("account name must be a non-empty string");
    }
    if (this.getAccount(code)) throw new ValidationError(`account already exists: ${code}`);

    const account: Account = { code, name: name.trim(), type, normalSide: NORMAL_SIDE[type], createdAt: now };
    this.db
      .prepare(`INSERT INTO accounts (code, name, type, normal_side, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(account.code, account.name, account.type, account.normalSide, account.createdAt);
    return account;
  }

  getAccount(code: string): Account | null {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE code = ?`).get(code) as
      | { code: string; name: string; type: AccountType; normal_side: Direction; created_at: number }
      | undefined;
    if (!row) return null;
    return {
      code: row.code,
      name: row.name,
      type: row.type,
      normalSide: row.normal_side,
      createdAt: row.created_at,
    };
  }

  accounts(): Account[] {
    const rows = this.db.prepare(`SELECT * FROM accounts ORDER BY code ASC`).all() as unknown as {
      code: string;
      name: string;
      type: AccountType;
      normal_side: Direction;
      created_at: number;
    }[];
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      type: r.type,
      normalSide: r.normal_side,
      createdAt: r.created_at,
    }));
  }

  openPeriod(period: string): void {
    if (!PERIOD_PATTERN.test(String(period))) {
      throw new ValidationError("period must look like YYYY-MM");
    }
    // Periods are open by default, so this is a no-op marker for callers that want it explicit.
  }

  closePeriod(period: string, now = Date.now()): void {
    if (!PERIOD_PATTERN.test(String(period))) {
      throw new ValidationError("period must look like YYYY-MM");
    }
    if (this.isClosed(period)) throw new ValidationError(`period already closed: ${period}`);
    this.db.prepare(`INSERT INTO periods (period, closed_at) VALUES (?, ?)`).run(period, now);
  }

  isClosed(period: string): boolean {
    const row = this.db.prepare(`SELECT 1 AS present FROM periods WHERE period = ?`).get(period);
    return row !== undefined;
  }

  /**
   * Posts a balanced journal entry. Every rule that keeps the books truthful is checked
   * before a single row is written, so a rejected entry leaves no trace.
   */
  post(input: PostInput, now = Date.now()): { entry: JournalEntry; deduped: boolean } {
    const { memo, period, occurredAt, postings } = input;

    if (typeof memo !== "string" || memo.trim() === "") {
      throw new ValidationError("memo must be a non-empty string");
    }
    if (!PERIOD_PATTERN.test(String(period))) {
      throw new ValidationError("period must look like YYYY-MM");
    }
    if (!Number.isInteger(occurredAt)) {
      throw new ValidationError("occurredAt must be integer epoch milliseconds");
    }
    if (!Array.isArray(postings) || postings.length < 2) {
      throw new ValidationError("an entry needs at least two postings");
    }
    let debits = 0;
    let credits = 0;
    for (const p of postings) {
      if (p.direction !== "debit" && p.direction !== "credit") {
        throw new ValidationError(`posting direction must be debit or credit, got ${p.direction}`);
      }
      if (!Number.isSafeInteger(p.amount) || p.amount <= 0) {
        throw new ValidationError(
          `posting amount must be a positive integer of minor units, got ${p.amount}`,
        );
      }
      if (!this.getAccount(p.account)) {
        throw new NotFoundError(`unknown account: ${p.account}`);
      }
      if (p.direction === "debit") debits += p.amount;
      else credits += p.amount;
    }

    if (debits !== credits) {
      throw new ValidationError(
        `entry does not balance: debits ${debits} != credits ${credits}`,
      );
    }
    if (debits === 0) throw new ValidationError("entry must move a non-zero amount");

    // A replayed request returns the original entry even if the period closed in between:
    // the money already moved, so the caller must get the same answer, not an error.
    const key = input.idempotencyKey ?? null;
    if (key !== null) {
      const existing = this.findByKey(key);
      if (existing) return { entry: existing, deduped: true };
    }

    if (this.isClosed(period)) throw new PeriodClosedError(`period ${period} is closed`);

    const entry: JournalEntry = {
      id: randomUUID(),
      memo: memo.trim(),
      period,
      occurredAt,
      createdAt: now,
      postings: postings.map((p) => ({ account: p.account, direction: p.direction, amount: p.amount })),
      idempotencyKey: key,
    };

    try {
      this.tx(() => {
        this.db
          .prepare(
            `INSERT INTO entries (id, memo, period, occurred_at, created_at, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(entry.id, entry.memo, entry.period, entry.occurredAt, entry.createdAt, entry.idempotencyKey);
        const insert = this.db.prepare(
          `INSERT INTO postings (entry_id, account_code, direction, amount) VALUES (?, ?, ?, ?)`,
        );
        for (const p of entry.postings) insert.run(entry.id, p.account, p.direction, p.amount);
      });
    } catch (err) {
      if (key !== null && String(err).includes("UNIQUE")) {
        const existing = this.findByKey(key);
        if (existing) return { entry: existing, deduped: true };
      }
      throw err;
    }

    return { entry, deduped: false };
  }

  findByKey(key: string): JournalEntry | null {
    const row = this.db.prepare(`SELECT id FROM entries WHERE idempotency_key = ?`).get(key) as
      | { id: string }
      | undefined;
    return row ? this.getEntry(row.id) : null;
  }

  getEntry(id: string): JournalEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM entries WHERE id = ?`)
      .get(id) as
      | {
          id: string;
          memo: string;
          period: string;
          occurred_at: number;
          created_at: number;
          idempotency_key: string | null;
        }
      | undefined;
    if (!row) return null;
    const postings = this.db
      .prepare(`SELECT account_code, direction, amount FROM postings WHERE entry_id = ? ORDER BY id ASC`)
      .all(id) as unknown as { account_code: string; direction: Direction; amount: number }[];
    return {
      id: row.id,
      memo: row.memo,
      period: row.period,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      postings: postings.map((p) => ({
        account: p.account_code,
        direction: p.direction,
        amount: p.amount,
      })),
      idempotencyKey: row.idempotency_key,
    };
  }

  entries(period?: string): JournalEntry[] {
    const rows = (
      period
        ? this.db.prepare(`SELECT id FROM entries WHERE period = ? ORDER BY created_at ASC, id ASC`).all(period)
        : this.db.prepare(`SELECT id FROM entries ORDER BY created_at ASC, id ASC`).all()
    ) as unknown as { id: string }[];
    return rows.map((r) => this.getEntry(r.id)!);
  }

  /** Balance in the account's normal direction. An asset with more debits than credits is positive. */
  balance(code: string): number {
    const account = this.getAccount(code);
    if (!account) throw new NotFoundError(`unknown account: ${code}`);
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount ELSE 0 END), 0) AS debits,
           COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END), 0) AS credits
         FROM postings WHERE account_code = ?`,
      )
      .get(code) as { debits: number; credits: number };
    return account.normalSide === "debit"
      ? row.debits - row.credits
      : row.credits - row.debits;
  }

  /** Raw debit and credit totals, for reports that need both sides. */
  totals(code: string): { debit: number; credit: number } {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount ELSE 0 END), 0) AS debit,
           COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END), 0) AS credit
         FROM postings WHERE account_code = ?`,
      )
      .get(code) as { debit: number; credit: number };
    return { debit: row.debit, credit: row.credit };
  }

  /** Every account's totals. `balanced` is the invariant that must hold after any entry. */
  trialBalance(): TrialBalance {
    const rows: TrialBalanceRow[] = this.accounts().map((a) => {
      const { debit, credit } = this.totals(a.code);
      return { code: a.code, name: a.name, type: a.type, debit, credit };
    });
    const totalDebit = rows.reduce((sum, r) => sum + r.debit, 0);
    const totalCredit = rows.reduce((sum, r) => sum + r.credit, 0);
    return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
  }

  closedPeriods(): string[] {
    const rows = this.db.prepare(`SELECT period FROM periods ORDER BY period ASC`).all() as unknown as {
      period: string;
    }[];
    return rows.map((r) => r.period);
  }

  close(): void {
    this.db.close();
  }
}
