#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { GoCardlessClient } from "./client.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new GoCardlessClient(config);

  const server = new McpServer(
    { name: "gocardless-bank-account-data", version: VERSION },
    {
      instructions:
        "Access to bank accounts through the GoCardless Bank Account Data API.\n" +
        "Connecting a bank: list_institutions to find the bank, connect_bank to get the " +
        "authorisation link, then get_requisition until its status is LN (LINKED) — the " +
        "`accounts` array then holds the account ids.\n" +
        "Reading data: list_linked_accounts, then get_account_balances, get_account_details " +
        "and get_account_transactions with an account id.\n" +
        "GoCardless caps how often each account endpoint may be called per account per day, " +
        "so fetch a wide date range once rather than polling.",
    },
  );

  registerTools(server, { client, config });

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout is the MCP transport — diagnostics belong on stderr.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
