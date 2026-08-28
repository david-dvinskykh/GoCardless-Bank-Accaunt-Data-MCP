import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ACCESS_SCOPES, api, describeRequisitionStatus, type Requisition } from "./api.js";
import type { GoCardlessClient } from "./client.js";
import type { Config } from "./config.js";
import { GoCardlessApiError } from "./errors.js";
import { compactTransaction, jsonBlock, sumAmounts, type CompactTransaction } from "./format.js";

export interface ToolContext {
  client: GoCardlessClient;
  config: Config;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : jsonBlock(value) }] };
}

function fail(error: unknown): ToolResult {
  const text =
    error instanceof GoCardlessApiError
      ? error.toToolMessage()
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text", text }], isError: true };
}

/** Every handler funnels through here so an API error becomes tool output, not a transport crash. */
function guard<A>(handler: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return fail(error);
    }
  };
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date, e.g. 2026-01-31");

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { client, config } = ctx;

  // --- setup ---------------------------------------------------------------

  server.registerTool(
    "gocardless_status",
    {
      title: "GoCardless connection status",
      description:
        "Report how this server is configured and whether it holds a valid access token. " +
        "Use it first when a call fails, to tell a credential problem from an API problem. " +
        "Never returns the secrets themselves.",
      inputSchema: {},
    },
    guard(async () => {
      const token = await client.tokenState();
      return ok({
        base_url: config.baseUrl,
        default_redirect_uri: config.redirectUri,
        token_cache_dir: config.cacheDir,
        secret_id_suffix: `…${config.secretId.slice(-4)}`,
        token,
      });
    }),
  );

  // --- institutions --------------------------------------------------------

  server.registerTool(
    "list_institutions",
    {
      title: "List banks",
      description:
        "List the banks (institutions) available for a country, as ISO 3166 two-letter code. " +
        "The institution id returned here is what connect_bank and create_requisition need. " +
        "Omit the country to get every supported institution.",
      inputSchema: {
        country: z
          .string()
          .length(2)
          .optional()
          .describe("ISO 3166 two-letter country code, e.g. GB, DE, PL"),
        search: z
          .string()
          .optional()
          .describe("Case-insensitive substring filter applied to institution names locally"),
        access_scopes_supported: z
          .enum(ACCESS_SCOPES)
          .optional()
          .describe("Only institutions supporting this scope"),
        payments_enabled: z.boolean().optional(),
        limit: z.number().int().positive().max(500).default(100),
      },
    },
    guard(async ({ country, search, access_scopes_supported, payments_enabled, limit }) => {
      const institutions = await api.listInstitutions(client, {
        country: country?.toUpperCase(),
        access_scopes_supported,
        payments_enabled,
      });
      const needle = search?.toLowerCase();
      const matched = needle
        ? institutions.filter((i) => i.name.toLowerCase().includes(needle) || i.id.toLowerCase().includes(needle))
        : institutions;
      return ok({
        total_matched: matched.length,
        returned: Math.min(matched.length, limit),
        institutions: matched.slice(0, limit).map((i) => ({
          id: i.id,
          name: i.name,
          bic: i.bic,
          countries: i.countries,
          transaction_total_days: i.transaction_total_days,
          max_access_valid_for_days: i.max_access_valid_for_days,
        })),
      });
    }),
  );

  server.registerTool(
    "get_institution",
    {
      title: "Get bank details",
      description:
        "Full record for one institution, including how many days of transaction history it exposes " +
        "and how long access may stay valid.",
      inputSchema: { institution_id: z.string().describe("Institution id, e.g. REVOLUT_REVOGB21") },
    },
    guard(async ({ institution_id }) => ok(await api.getInstitution(client, institution_id))),
  );

  // --- end user agreements -------------------------------------------------

  server.registerTool(
    "create_end_user_agreement",
    {
      title: "Create end user agreement",
      description:
        "Create an end user agreement, which fixes how much history and which scopes the connection " +
        "covers and for how long access stays valid. Optional: create_requisition without an agreement " +
        "uses the institution defaults (usually 90 days of history, 90 days of access). " +
        "Do not exceed the institution's transaction_total_days or max_access_valid_for_days.",
      inputSchema: {
        institution_id: z.string(),
        max_historical_days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Days of transaction history to request; capped by the institution"),
        access_valid_for_days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How many days the connection stays usable before it must be renewed"),
        access_scope: z
          .array(z.enum(ACCESS_SCOPES))
          .optional()
          .describe('Defaults to ["balances","details","transactions"]'),
      },
    },
    guard(async (args) => ok(await api.createAgreement(client, args))),
  );

  server.registerTool(
    "list_end_user_agreements",
    {
      title: "List end user agreements",
      description: "List the end user agreements created with these credentials.",
      inputSchema: {
        limit: z.number().int().positive().max(100).default(20),
        offset: z.number().int().nonnegative().default(0),
      },
    },
    guard(async ({ limit, offset }) => ok(await api.listAgreements(client, { limit, offset }))),
  );

  server.registerTool(
    "get_end_user_agreement",
    {
      title: "Get end user agreement",
      description: "Fetch one end user agreement by id.",
      inputSchema: { agreement_id: z.string() },
    },
    guard(async ({ agreement_id }) => ok(await api.getAgreement(client, agreement_id))),
  );

  server.registerTool(
    "accept_end_user_agreement",
    {
      title: "Accept end user agreement",
      description:
        "Record the end user's acceptance of an agreement. Only for accounts allowed to present " +
        "GoCardless's terms in their own interface; the hosted consent screen accepts the agreement " +
        "on its own and this call is then unnecessary.",
      inputSchema: {
        agreement_id: z.string(),
        user_agent: z.string().describe("User agent of the end user's browser"),
        ip_address: z.string().describe("IP address the end user accepted from"),
      },
    },
    guard(async ({ agreement_id, user_agent, ip_address }) =>
      ok(await api.acceptAgreement(client, agreement_id, { user_agent, ip_address })),
    ),
  );

  server.registerTool(
    "delete_end_user_agreement",
    {
      title: "Delete end user agreement",
      description: "Delete an end user agreement by id.",
      inputSchema: { agreement_id: z.string() },
    },
    guard(async ({ agreement_id }) =>
      ok((await api.deleteAgreement(client, agreement_id)) ?? { deleted: agreement_id }),
    ),
  );

  // --- requisitions (the connect flow) -------------------------------------

  server.registerTool(
    "create_requisition",
    {
      title: "Create requisition (bank authorisation link)",
      description:
        "Create a requisition and get the link the end user opens to authorise access at their bank. " +
        "After they finish, call get_requisition with the returned id: status LN means the account ids " +
        "are ready to read. Prefer connect_bank unless you need to attach an existing agreement.",
      inputSchema: {
        institution_id: z.string(),
        redirect: z
          .string()
          .url()
          .optional()
          .describe("Where the bank sends the browser afterwards; defaults to GOCARDLESS_REDIRECT_URI"),
        reference: z
          .string()
          .optional()
          .describe("Your own id for this connection; must be unique per requisition"),
        agreement_id: z.string().optional().describe("Id from create_end_user_agreement"),
        user_language: z.string().optional().describe("Two-letter language code for the consent screen, e.g. EN"),
        ssn: z.string().optional().describe("National id, where the institution requires one"),
        account_selection: z
          .boolean()
          .optional()
          .describe("Let the end user pick accounts on the GoCardless screen instead of the bank's"),
        redirect_immediate: z
          .boolean()
          .optional()
          .describe("Return to the redirect URI straight after consent, skipping account selection"),
      },
    },
    guard(async ({ agreement_id, redirect, ...rest }) => {
      const requisition = await api.createRequisition(client, {
        ...rest,
        redirect: redirect ?? config.redirectUri,
        ...(agreement_id ? { agreement: agreement_id } : {}),
      });
      return ok(withStatusText(requisition, "Send `link` to the end user, then poll get_requisition."));
    }),
  );

  server.registerTool(
    "list_requisitions",
    {
      title: "List requisitions",
      description: "List every requisition created with these credentials, newest first.",
      inputSchema: {
        limit: z.number().int().positive().max(100).default(20),
        offset: z.number().int().nonnegative().default(0),
      },
    },
    guard(async ({ limit, offset }) => {
      const page = await api.listRequisitions(client, { limit, offset });
      return ok({ ...page, results: page.results.map((r) => withStatusText(r)) });
    }),
  );

  server.registerTool(
    "get_requisition",
    {
      title: "Get requisition",
      description:
        "Fetch one requisition. Use it to check whether the end user has finished authorising: " +
        "status LN (LINKED) means `accounts` holds the account ids to read.",
      inputSchema: { requisition_id: z.string() },
    },
    guard(async ({ requisition_id }) =>
      ok(withStatusText(await api.getRequisition(client, requisition_id))),
    ),
  );

  server.registerTool(
    "delete_requisition",
    {
      title: "Delete requisition",
      description:
        "Delete a requisition and, with it, access to the accounts it linked. Use this to disconnect a bank.",
      inputSchema: { requisition_id: z.string() },
    },
    guard(async ({ requisition_id }) =>
      ok((await api.deleteRequisition(client, requisition_id)) ?? { deleted: requisition_id }),
    ),
  );

  // --- high level ----------------------------------------------------------

  server.registerTool(
    "connect_bank",
    {
      title: "Connect a bank account",
      description:
        "One-step start of the connection flow: resolve the bank, optionally create an end user " +
        "agreement, create the requisition and return the authorisation link. Give either an " +
        "institution_id or an institution_name together with a country.",
      inputSchema: {
        institution_id: z.string().optional(),
        institution_name: z
          .string()
          .optional()
          .describe("Bank name to search for; requires country. Fails if the name is ambiguous."),
        country: z.string().length(2).optional().describe("ISO 3166 two-letter code, used with institution_name"),
        max_historical_days: z.number().int().positive().optional(),
        access_valid_for_days: z.number().int().positive().optional(),
        access_scope: z.array(z.enum(ACCESS_SCOPES)).optional(),
        redirect: z.string().url().optional(),
        reference: z.string().optional(),
        user_language: z.string().optional(),
      },
    },
    guard(async (args) => {
      const institutionId = await resolveInstitution(ctx, args);
      const wantsAgreement =
        args.max_historical_days !== undefined ||
        args.access_valid_for_days !== undefined ||
        args.access_scope !== undefined;

      const agreement = wantsAgreement
        ? await api.createAgreement(client, {
            institution_id: institutionId,
            ...(args.max_historical_days !== undefined
              ? { max_historical_days: args.max_historical_days }
              : {}),
            ...(args.access_valid_for_days !== undefined
              ? { access_valid_for_days: args.access_valid_for_days }
              : {}),
            ...(args.access_scope !== undefined ? { access_scope: args.access_scope } : {}),
          })
        : undefined;

      const requisition = await api.createRequisition(client, {
        institution_id: institutionId,
        redirect: args.redirect ?? config.redirectUri,
        ...(args.reference ? { reference: args.reference } : {}),
        ...(args.user_language ? { user_language: args.user_language } : {}),
        ...(agreement ? { agreement: agreement.id } : {}),
      });

      return ok({
        next_step:
          "Open `link` in a browser and authorise the bank. Then call get_requisition with " +
          `requisition_id "${requisition.id}" until status is LN, and read the account ids from \`accounts\`.`,
        link: requisition.link,
        requisition_id: requisition.id,
        institution_id: institutionId,
        agreement_id: agreement?.id ?? null,
        requisition: withStatusText(requisition),
      });
    }),
  );

  server.registerTool(
    "list_linked_accounts",
    {
      title: "List linked accounts",
      description:
        "Every account reachable with these credentials, gathered from all requisitions, with the " +
        "institution and connection status for each. Start here when asked about 'my accounts'.",
      inputSchema: {
        include_unlinked: z
          .boolean()
          .default(false)
          .describe("Also list requisitions that are not yet LINKED, so a pending connection is visible"),
        with_metadata: z
          .boolean()
          .default(true)
          .describe("Fetch IBAN, owner name and status per account (one extra request per account)"),
      },
    },
    guard(async ({ include_unlinked, with_metadata }) => {
      const page = await api.listRequisitions(client, { limit: 100, offset: 0 });
      const accounts: Record<string, unknown>[] = [];
      const pending: Record<string, unknown>[] = [];

      for (const requisition of page.results) {
        if (requisition.accounts.length === 0) {
          if (include_unlinked) {
            pending.push({
              requisition_id: requisition.id,
              institution_id: requisition.institution_id,
              status: requisition.status,
              status_text: describeRequisitionStatus(requisition.status),
              link: requisition.link,
            });
          }
          continue;
        }
        for (const accountId of requisition.accounts) {
          const entry: Record<string, unknown> = {
            account_id: accountId,
            institution_id: requisition.institution_id,
            requisition_id: requisition.id,
            requisition_status: requisition.status,
          };
          if (with_metadata) {
            try {
              const meta = await api.getAccount(client, accountId);
              entry.iban = meta.iban ?? null;
              entry.owner_name = meta.owner_name ?? null;
              entry.status = meta.status;
              entry.last_accessed = meta.last_accessed ?? null;
            } catch (error) {
              // One dead account must not hide the rest of the list.
              entry.metadata_error =
                error instanceof GoCardlessApiError ? error.toToolMessage() : String(error);
            }
          }
          accounts.push(entry);
        }
      }

      return ok({
        accounts,
        ...(include_unlinked ? { pending_connections: pending } : {}),
      });
    }),
  );

  // --- account data --------------------------------------------------------

  server.registerTool(
    "get_account",
    {
      title: "Get account metadata",
      description: "Account metadata: IBAN, owner name, institution and connection status.",
      inputSchema: { account_id: z.string() },
    },
    guard(async ({ account_id }) => ok(await api.getAccount(client, account_id))),
  );

  server.registerTool(
    "get_account_balances",
    {
      title: "Get account balances",
      description:
        "Balances for an account, each with its type (closingBooked, interimAvailable, …), amount and currency.",
      inputSchema: { account_id: z.string() },
    },
    guard(async ({ account_id }) => ok(await api.getBalances(client, account_id))),
  );

  server.registerTool(
    "get_account_details",
    {
      title: "Get account details",
      description:
        "Bank-reported details for an account: IBAN, currency, product name, owner, cash account type.",
      inputSchema: { account_id: z.string() },
    },
    guard(async ({ account_id }) => ok(await api.getDetails(client, account_id))),
  );

  server.registerTool(
    "get_account_transactions",
    {
      title: "Get transaction history",
      description:
        "Transaction history for an account, booked and pending. Narrow it with date_from/date_to; " +
        "how far back the bank goes is set by the institution and the end user agreement. " +
        'Output is compacted by default — pass format "raw" for the full ISO 20022 records.',
      inputSchema: {
        account_id: z.string(),
        date_from: isoDate.optional().describe("Earliest booking date, YYYY-MM-DD"),
        date_to: isoDate.optional().describe("Latest booking date, YYYY-MM-DD"),
        include_pending: z.boolean().default(true),
        format: z.enum(["compact", "raw"]).default("compact"),
        limit: z
          .number()
          .int()
          .positive()
          .max(2000)
          .default(200)
          .describe("Most recent N transactions to return; totals cover the returned ones"),
      },
    },
    guard(async ({ account_id, date_from, date_to, include_pending, format, limit }) => {
      const response = await api.getTransactions(client, account_id, { date_from, date_to });
      const booked = response.transactions?.booked ?? [];
      const pendingRaw = include_pending ? (response.transactions?.pending ?? []) : [];

      if (format === "raw") {
        return ok({
          account_id,
          booked_total: booked.length,
          pending_total: pendingRaw.length,
          transactions: {
            booked: booked.slice(-limit),
            ...(include_pending ? { pending: pendingRaw.slice(-limit) } : {}),
          },
        });
      }

      const bookedCompact = booked.map(compactTransaction);
      const pendingCompact = pendingRaw.map(compactTransaction);
      const returnedBooked = tail(bookedCompact, limit);
      const returnedPending = tail(pendingCompact, limit);

      return ok({
        account_id,
        date_from: date_from ?? null,
        date_to: date_to ?? null,
        booked_total: bookedCompact.length,
        pending_total: pendingCompact.length,
        truncated: bookedCompact.length > returnedBooked.length,
        totals_of_returned_booked: sumAmounts(returnedBooked),
        booked: returnedBooked,
        ...(include_pending ? { pending: returnedPending } : {}),
      });
    }),
  );

  server.registerTool(
    "get_premium_transactions",
    {
      title: "Get enriched transactions (premium)",
      description:
        "Transactions from the premium endpoint, with cleaned counterparty names and categories. " +
        "Requires a plan that includes premium data; otherwise the API returns an error.",
      inputSchema: {
        account_id: z.string(),
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        country: z.string().length(2).optional().describe("ISO 3166 code improving merchant matching"),
      },
    },
    guard(async ({ account_id, date_from, date_to, country }) =>
      ok(await api.getPremiumTransactions(client, account_id, { date_from, date_to, country })),
    ),
  );
}

function withStatusText(requisition: Requisition, hint?: string): Record<string, unknown> {
  return {
    ...requisition,
    status_text: describeRequisitionStatus(requisition.status),
    ...(hint ? { next_step: hint } : {}),
  };
}

/** `slice(-n)` on an empty limit would return the whole array; be explicit. */
function tail(items: CompactTransaction[], limit: number): CompactTransaction[] {
  return limit >= items.length ? items : items.slice(items.length - limit);
}

async function resolveInstitution(
  ctx: ToolContext,
  args: { institution_id?: string; institution_name?: string; country?: string },
): Promise<string> {
  if (args.institution_id) return args.institution_id;
  if (!args.institution_name) {
    throw new Error("Pass institution_id, or institution_name together with country.");
  }
  if (!args.country) {
    throw new Error("institution_name needs a country, e.g. country \"GB\".");
  }

  const institutions = await api.listInstitutions(ctx.client, { country: args.country.toUpperCase() });
  const needle = args.institution_name.toLowerCase();
  const matches = institutions.filter((i) => i.name.toLowerCase().includes(needle));

  if (matches.length === 0) {
    throw new Error(
      `No institution in ${args.country.toUpperCase()} matches "${args.institution_name}". ` +
        "Use list_institutions to see what is available.",
    );
  }
  const exact = matches.find((i) => i.name.toLowerCase() === needle);
  if (exact) return exact.id;
  if (matches.length > 1) {
    throw new Error(
      `"${args.institution_name}" matches ${matches.length} institutions in ` +
        `${args.country.toUpperCase()}: ${matches.map((i) => `${i.name} (${i.id})`).join(", ")}. ` +
        "Pass institution_id to pick one.",
    );
  }
  return matches[0]!.id;
}
