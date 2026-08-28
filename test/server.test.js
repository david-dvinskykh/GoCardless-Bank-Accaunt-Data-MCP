import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { startStubApi } from "./stub-api.js";

const entry = fileURLToPath(new URL("../build/index.js", import.meta.url));

async function connect(stub, cacheDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      PATH: process.env.PATH,
      GOCARDLESS_SECRET_ID: "secret-id",
      GOCARDLESS_SECRET_KEY: "secret-key",
      GOCARDLESS_BASE_URL: stub.baseUrl,
      GOCARDLESS_REDIRECT_URI: "https://example.test/done",
      GOCARDLESS_CACHE_DIR: cacheDir,
    },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

function payload(result) {
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

describe("gocardless bank account data mcp", () => {
  let stub;
  let client;
  let cacheDir;

  before(async () => {
    stub = await startStubApi();
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "gocardless-mcp-test-"));
    client = await connect(stub, cacheDir);
  });

  after(async () => {
    await client?.close();
    await stub?.close();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("exposes the whole documented surface", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "accept_end_user_agreement",
      "connect_bank",
      "create_end_user_agreement",
      "create_requisition",
      "delete_end_user_agreement",
      "delete_requisition",
      "get_account",
      "get_account_balances",
      "get_account_details",
      "get_account_transactions",
      "get_end_user_agreement",
      "get_institution",
      "get_premium_transactions",
      "get_requisition",
      "gocardless_status",
      "list_end_user_agreements",
      "list_institutions",
      "list_linked_accounts",
      "list_requisitions",
    ]);
  });

  it("reports status without leaking the secret", async () => {
    const result = payload(await client.callTool({ name: "gocardless_status", arguments: {} }));
    assert.equal(result.base_url, stub.baseUrl);
    assert.equal(result.secret_id_suffix, "…t-id");
    assert.ok(!JSON.stringify(result).includes("secret-key"));
  });

  it("filters institutions by country and name", async () => {
    const result = payload(
      await client.callTool({
        name: "list_institutions",
        arguments: { country: "gb", search: "revo" },
      }),
    );
    assert.equal(result.total_matched, 1);
    assert.equal(result.institutions[0].id, "REVOLUT_REVOGB21");
  });

  it("issues one token and reuses it across calls", async () => {
    await client.callTool({ name: "list_institutions", arguments: { country: "GB" } });
    assert.equal(stub.tokenIssues, 1);
    const cached = JSON.parse(await fs.readFile(path.join(cacheDir, "tokens.json"), "utf8"));
    assert.equal(cached.access, "access-1");
  });

  it("resolves a bank by name and returns an authorisation link", async () => {
    const result = payload(
      await client.callTool({
        name: "connect_bank",
        arguments: { institution_name: "Revolut", country: "GB", max_historical_days: 180 },
      }),
    );
    assert.equal(result.institution_id, "REVOLUT_REVOGB21");
    assert.equal(result.agreement_id, "agreement-1");
    assert.equal(result.link, "https://ob.gocardless.com/psd2/start/requisition-1");
    assert.equal(result.requisition.status_text.startsWith("CREATED"), true);

    const created = stub.requests.findLast((r) => r.path === "/api/v2/requisitions/" && r.method === "POST");
    assert.equal(created.body.redirect, "https://example.test/done");
    assert.equal(created.body.agreement, "agreement-1");
  });

  it("refuses an ambiguous bank name instead of guessing", async () => {
    const result = await client.callTool({
      name: "connect_bank",
      arguments: { institution_name: "o", country: "GB" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /matches 2 institutions/);
  });

  it("lists linked accounts with metadata", async () => {
    const result = payload(await client.callTool({ name: "list_linked_accounts", arguments: {} }));
    assert.equal(result.accounts.length, 1);
    assert.deepEqual(
      { id: result.accounts[0].account_id, iban: result.accounts[0].iban, owner: result.accounts[0].owner_name },
      { id: "account-1", iban: "GB33BUKB20201555555555", owner: "A Person" },
    );
  });

  it("compacts transactions and totals what it returns", async () => {
    const result = payload(
      await client.callTool({
        name: "get_account_transactions",
        arguments: { account_id: "account-1", date_from: "2026-08-01", date_to: "2026-08-31" },
      }),
    );
    assert.equal(result.booked_total, 2);
    assert.equal(result.pending_total, 1);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.totals_of_returned_booked, { GBP: "987.50" });
    assert.deepEqual(result.booked[0], {
      id: "t1",
      date: "2026-08-01",
      amount: "-12.50",
      currency: "GBP",
      counterparty: "Coffee Shop",
      description: "CARD PAYMENT",
    });
    assert.equal(result.booked[1].counterparty, "Employer Ltd");
    assert.equal(result.booked[1].description, "SALARY AUGUST");

    const sent = stub.requests.findLast((r) => r.path === "/api/v2/accounts/account-1/transactions/");
    assert.equal(sent.query.get("date_from"), "2026-08-01");
    assert.equal(sent.query.get("date_to"), "2026-08-31");
  });

  it("keeps the last N transactions when limited", async () => {
    const result = payload(
      await client.callTool({
        name: "get_account_transactions",
        arguments: { account_id: "account-1", limit: 1, include_pending: false },
      }),
    );
    assert.equal(result.truncated, true);
    assert.equal(result.booked.length, 1);
    assert.equal(result.booked[0].id, "t2");
    assert.equal(result.pending, undefined);
  });

  it("returns raw records on request", async () => {
    const result = payload(
      await client.callTool({
        name: "get_account_transactions",
        arguments: { account_id: "account-1", format: "raw" },
      }),
    );
    assert.equal(result.transactions.booked[0].remittanceInformationUnstructured, "CARD PAYMENT");
  });

  it("surfaces an API error as tool output, not a crash", async () => {
    const result = await client.callTool({
      name: "get_account_balances",
      arguments: { account_id: "unknown-account" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /HTTP 404/);

    // The transport must still be usable afterwards.
    const status = payload(await client.callTool({ name: "gocardless_status", arguments: {} }));
    assert.equal(status.token.hasAccessToken, true);
  });
});

describe("token handling", () => {
  it("re-authenticates once when the token is rejected", async () => {
    let rejectionsLeft = 1;
    const stub = await startStubApi({
      "GET /api/v2/institutions/": () =>
        rejectionsLeft-- > 0
          ? { status: 401, body: { detail: "token expired" } }
          : { status: 200, body: [{ id: "MONZO_MONZGB2L", name: "Monzo", countries: ["GB"] }] },
    });
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "gocardless-mcp-test-"));
    const client = await connect(stub, cacheDir);

    const result = payload(await client.callTool({ name: "list_institutions", arguments: {} }));
    assert.equal(result.institutions[0].id, "MONZO_MONZGB2L");
    assert.equal(stub.tokenIssues, 2, "a rejected token must be replaced exactly once");

    await client.close();
    await stub.close();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("explains a rate limited account endpoint", async () => {
    const stub = await startStubApi({
      "GET /api/v2/accounts/account-1/balances/": () => ({
        status: 429,
        body: { detail: "daily limit reached" },
        headers: { "ratelimit-account-success-reset": "3600" },
      }),
    });
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "gocardless-mcp-test-"));
    const client = await connect(stub, cacheDir);

    const result = await client.callTool({
      name: "get_account_balances",
      arguments: { account_id: "account-1" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /resets in 3600 seconds/);

    await client.close();
    await stub.close();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("fails fast and loudly without credentials", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { PATH: process.env.PATH },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    await assert.rejects(() => client.connect(transport));
  });
});
