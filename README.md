# GoCardless Bank Account Data MCP

An MCP server that connects a bank account to Claude through the
[GoCardless Bank Account Data API](https://developer.gocardless.com/bank-account-data/overview)
(v2, formerly Nordigen) and reads balances, account details and transaction history from it.

Access is read-only: the Bank Account Data API is an account information service, so nothing
here can move money.

## What it can do

- Find a bank — `list_institutions`, `get_institution`
- Connect it — `connect_bank` (one step), or `create_end_user_agreement` + `create_requisition`
  when the history window, access window or scopes need to be set explicitly
- Track the authorisation — `get_requisition`, `list_requisitions`, `list_linked_accounts`
- Read the account — `get_account`, `get_account_balances`, `get_account_details`,
  `get_account_transactions`, `get_premium_transactions`
- Disconnect — `delete_requisition`, `delete_end_user_agreement`
- Check the setup — `gocardless_status`

## Setup

1. Register at [bankaccountdata.gocardless.com](https://bankaccountdata.gocardless.com/) and
   create a **user secret** under Developers → User secrets. You get a secret id and a secret key.
2. Give them to the server as `GOCARDLESS_SECRET_ID` and `GOCARDLESS_SECRET_KEY`.

The server exchanges the pair for an access token itself, caches the token on disk and refreshes
it before it expires — access tokens live 24 hours, refresh tokens 30 days.

### Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GOCARDLESS_SECRET_ID` | yes | — | Bank Account Data user secret id |
| `GOCARDLESS_SECRET_KEY` | yes | — | Bank Account Data user secret key |
| `GOCARDLESS_REDIRECT_URI` | no | `https://bankaccountdata.gocardless.com/` | Where the bank returns the browser after consent |
| `GOCARDLESS_BASE_URL` | no | `https://bankaccountdata.gocardless.com/api/v2` | API base, for the sandbox or a proxy |
| `GOCARDLESS_CACHE_DIR` | no | `$XDG_CACHE_HOME/gocardless-bank-account-data-mcp` | Token cache location |

A requisition cannot be created without a redirect URI even in a flow where nobody lands on it,
so the default points back at GoCardless. Set your own if you want the end user returned to your
own page.

### Install and run

```bash
npm ci
npm run build
GOCARDLESS_SECRET_ID=... GOCARDLESS_SECRET_KEY=... node build/index.js
```

The server speaks MCP over stdio.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "gocardless": {
      "command": "node",
      "args": ["/path/to/GoCardless-Bank-Accaunt-Data-MCP/build/index.js"],
      "env": {
        "GOCARDLESS_SECRET_ID": "...",
        "GOCARDLESS_SECRET_KEY": "..."
      }
    }
  }
}
```

### MetaMCP

The [metamcp all-in-one image](https://github.com/david-dvinskykh/metamcp) ships this server
preinstalled as `gocardless-mcp`. Add an stdio server there with command `gocardless-mcp`, no
arguments, and set the two secrets in its environment. The token cache lives in
`/var/lib/gocardless-mcp`, which the image declares as a volume — keep it, or every container
restart spends a fresh token request.

## Connecting a bank, end to end

```
list_institutions { "country": "GB", "search": "revolut" }
  → REVOLUT_REVOGB21

connect_bank { "institution_id": "REVOLUT_REVOGB21", "max_historical_days": 180 }
  → link: https://ob.gocardless.com/psd2/start/...   requisition_id: ...

  the end user opens the link and authorises access at their bank

get_requisition { "requisition_id": "..." }
  → status LN (LINKED), accounts: ["<account id>"]

get_account_transactions { "account_id": "<account id>", "date_from": "2026-01-01" }
```

`connect_bank` creates the end user agreement only when you ask for a non-default history
window, access window or scope set; otherwise the institution's own defaults apply (typically
90 days of history and 90 days of access).

Requisition status codes are returned with a `status_text` alongside them, so `CR`, `GC`, `UA`,
`SA`, `GA`, `LN`, `RJ`, `EX` and `SU` do not have to be looked up.

## Transaction output

`get_account_transactions` compacts each record to id, date, amount, currency, counterparty,
description and bank transaction code, and returns per-currency totals for what it returned. A
year of raw ISO 20022 records is mostly empty fields and crowds out the conversation; pass
`format: "raw"` when a field outside the compact set is needed. `limit` (default 200) keeps the
most recent transactions and marks the response `truncated`.

## Rate limits

GoCardless caps how often each account endpoint may be called per account per day. The server
does not retry past a 429 — it reports the limit and, when the API says so, how long until it
resets. Fetch a wide date range once rather than polling.

## Development

```bash
npm ci
npm test        # builds, then runs the suite against a stubbed API
npm run typecheck
```

The tests drive the real server binary over stdio against a local stand-in for
`bankaccountdata.gocardless.com`, covering the token dance (issue, reuse, re-issue after a 401),
bank resolution, the connect flow, transaction compaction and error reporting. No network and no
credentials are needed to run them.

## License

MIT
