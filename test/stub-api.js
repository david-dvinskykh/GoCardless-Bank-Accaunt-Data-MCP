import http from "node:http";

/**
 * A stand-in for bankaccountdata.gocardless.com. It answers only what the
 * tests exercise and records every request so the tests can assert on the
 * token dance as well as on tool output.
 */
export async function startStubApi(overrides = {}) {
  const requests = [];
  let tokenIssues = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://stub");
    const body = await readBody(req);
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body });

    const custom = overrides[`${req.method} ${url.pathname}`];
    if (custom) {
      const result = custom({ url, body, headers: req.headers });
      return send(res, result.status ?? 200, result.body, result.headers);
    }

    if (req.method === "POST" && url.pathname === "/api/v2/token/new/") {
      tokenIssues += 1;
      return send(res, 200, {
        access: `access-${tokenIssues}`,
        access_expires: 86400,
        refresh: "refresh-1",
        refresh_expires: 2592000,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/v2/token/refresh/") {
      return send(res, 200, { access: "access-refreshed", access_expires: 86400 });
    }

    if (!req.headers.authorization?.startsWith("Bearer ")) {
      return send(res, 401, { detail: "missing token" });
    }

    if (req.method === "GET" && url.pathname === "/api/v2/institutions/") {
      const country = url.searchParams.get("country");
      const all = [
        { id: "REVOLUT_REVOGB21", name: "Revolut", bic: "REVOGB21", countries: ["GB"] },
        { id: "MONZO_MONZGB2L", name: "Monzo", bic: "MONZGB2L", countries: ["GB"] },
        { id: "MBANK_BREXPLPW", name: "mBank", bic: "BREXPLPW", countries: ["PL"] },
      ];
      return send(res, 200, country ? all.filter((i) => i.countries.includes(country)) : all);
    }

    if (req.method === "POST" && url.pathname === "/api/v2/agreements/enduser/") {
      return send(res, 201, {
        id: "agreement-1",
        created: "2026-08-01T00:00:00Z",
        institution_id: body.institution_id,
        max_historical_days: body.max_historical_days ?? 90,
        access_valid_for_days: body.access_valid_for_days ?? 90,
        access_scope: body.access_scope ?? ["balances", "details", "transactions"],
        accepted: null,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/v2/requisitions/") {
      return send(res, 201, {
        id: "requisition-1",
        created: "2026-08-01T00:00:00Z",
        redirect: body.redirect,
        status: "CR",
        institution_id: body.institution_id,
        agreement: body.agreement ?? null,
        reference: body.reference ?? null,
        accounts: [],
        link: "https://ob.gocardless.com/psd2/start/requisition-1",
      });
    }

    if (req.method === "GET" && url.pathname === "/api/v2/requisitions/") {
      return send(res, 200, {
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: "requisition-1",
            created: "2026-08-01T00:00:00Z",
            redirect: "https://example.test/done",
            status: "LN",
            institution_id: "REVOLUT_REVOGB21",
            agreement: "agreement-1",
            reference: null,
            accounts: ["account-1"],
            link: "https://ob.gocardless.com/psd2/start/requisition-1",
          },
        ],
      });
    }

    if (req.method === "GET" && url.pathname === "/api/v2/accounts/account-1/") {
      return send(res, 200, {
        id: "account-1",
        created: "2026-08-01T00:00:00Z",
        last_accessed: "2026-08-27T10:00:00Z",
        iban: "GB33BUKB20201555555555",
        institution_id: "REVOLUT_REVOGB21",
        status: "READY",
        owner_name: "A Person",
      });
    }

    if (req.method === "GET" && url.pathname === "/api/v2/accounts/account-1/transactions/") {
      return send(res, 200, {
        transactions: {
          booked: [
            {
              transactionId: "t1",
              bookingDate: "2026-08-01",
              transactionAmount: { amount: "-12.50", currency: "GBP" },
              creditorName: "Coffee Shop",
              remittanceInformationUnstructured: "CARD PAYMENT",
            },
            {
              transactionId: "t2",
              bookingDate: "2026-08-02",
              transactionAmount: { amount: "1000.00", currency: "GBP" },
              debtorName: "Employer Ltd",
              remittanceInformationUnstructuredArray: ["SALARY", "AUGUST"],
            },
          ],
          pending: [
            {
              transactionId: "t3",
              valueDate: "2026-08-03",
              transactionAmount: { amount: "-5.00", currency: "GBP" },
              creditorName: "Bakery",
            },
          ],
        },
      });
    }

    return send(res, 404, { detail: `no stub for ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/api/v2`,
    requests,
    get tokenIssues() {
      return tokenIssues;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}
