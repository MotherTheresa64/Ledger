import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Ledger, ValidationError, NotFoundError, PeriodClosedError } from "./ledger.ts";
import type { AccountType, Direction } from "./ledger.ts";

let cachedPage: string | null = null;

function indexHtml(): string {
  if (cachedPage === null) {
    cachedPage = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  }
  return cachedPage;
}

export function currentPeriod(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(err instanceof Error && err.message.startsWith("request body") ? err.message : "request body is not valid JSON");
  }
}

export function createApp(): Server {
  const ledger = new Ledger();
  const now = Date.now();
  const period = currentPeriod(now);

  ledger.createAccount("1000", "Cash", "asset", now);
  ledger.createAccount("2000", "Accounts payable", "liability", now);
  ledger.createAccount("4000", "Sales", "revenue", now);
  ledger.createAccount("5000", "Rent", "expense", now);

  ledger.post(
    {
      memo: "Opening balance",
      period,
      occurredAt: now,
      postings: [
        { account: "1000", direction: "debit", amount: 500_000 },
        { account: "4000", direction: "credit", amount: 500_000 },
      ],
    },
    now,
  );
  ledger.post(
    {
      memo: "Rent for the month",
      period,
      occurredAt: now,
      postings: [
        { account: "5000", direction: "debit", amount: 120_000 },
        { account: "1000", direction: "credit", amount: 120_000 },
      ],
    },
    now,
  );

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return send(res, 200, indexHtml(), "text/html; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { status: "ok" });
      }

      if (req.method === "GET" && url.pathname === "/accounts") {
        const accounts = ledger.accounts().map((account) => ({ ...account, balance: ledger.balance(account.code) }));
        return send(res, 200, { accounts, trialBalance: ledger.trialBalance() });
      }

      if (req.method === "POST" && url.pathname === "/accounts") {
        const body = await readJson(req);
        const account = ledger.createAccount(
          String(body.code ?? ""),
          String(body.name ?? ""),
          String(body.type ?? "") as AccountType,
          Date.now(),
        );
        return send(res, 201, account);
      }

      if (req.method === "GET" && url.pathname === "/entries") {
        const periodFilter = url.searchParams.get("period") ?? undefined;
        return send(res, 200, { entries: ledger.entries(periodFilter) });
      }

      if (req.method === "POST" && url.pathname === "/entries") {
        const body = await readJson(req);

        // The page posts a simple two-sided entry; the library also accepts more.
        const postings = Array.isArray(body.postings)
          ? (body.postings as { account: string; direction: Direction; amount: number }[])
          : [
              { account: String(body.debit ?? ""), direction: "debit" as Direction, amount: Number(body.amount) },
              { account: String(body.credit ?? ""), direction: "credit" as Direction, amount: Number(body.amount) },
            ];

        const result = ledger.post(
          {
            memo: String(body.memo ?? ""),
            period: String(body.period ?? currentPeriod()),
            occurredAt: Number.isInteger(body.occurredAt) ? Number(body.occurredAt) : Date.now(),
            postings,
            idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
          },
          Date.now(),
        );
        return send(res, 201, result);
      }

      if (req.method === "GET" && url.pathname === "/trial-balance") {
        return send(res, 200, ledger.trialBalance());
      }

      if (req.method === "GET" && url.pathname === "/periods") {
        return send(res, 200, { current: currentPeriod(), closed: ledger.closedPeriods() });
      }

      if (req.method === "POST" && url.pathname === "/periods/close") {
        const body = await readJson(req);
        const target = String(body.period ?? "");
        ledger.closePeriod(target, Date.now());
        return send(res, 200, { period: target, closed: true });
      }

      return send(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      if (err instanceof PeriodClosedError) return send(res, 409, { error: "period_closed", message: err.message });
      if (err instanceof NotFoundError) return send(res, 404, { error: "not_found", message: err.message });
      if (err instanceof ValidationError) return send(res, 400, { error: "invalid", message: err.message });
      if (err instanceof Error && err.message.startsWith("request body")) {
        return send(res, 400, { error: "invalid", message: err.message });
      }
      return send(res, 500, { error: "internal", message: "unexpected failure" });
    }
  });
}

// pathToFileURL matters on Windows: argv[1] is a drive path there, which never
// equals the file:/// URL form.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const port = Number(process.env.PORT ?? 4107);
  createApp().listen(port, () => {
    console.log(`ledger listening on http://localhost:${port}`);
  });
}
