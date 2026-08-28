import type { GoCardlessClient } from "./client.js";

export interface Institution {
  id: string;
  name: string;
  bic?: string;
  transaction_total_days?: string;
  max_access_valid_for_days?: string;
  countries?: string[];
  logo?: string;
  supported_features?: string[];
}

export interface EndUserAgreement {
  id: string;
  created: string;
  institution_id: string;
  max_historical_days: number;
  access_valid_for_days: number;
  access_scope: string[];
  accepted: string | null;
}

export interface Requisition {
  id: string;
  created: string;
  redirect: string | null;
  status: string;
  institution_id: string;
  agreement: string | null;
  reference: string | null;
  accounts: string[];
  link: string;
  user_language?: string | null;
  ssn?: string | null;
  account_selection?: boolean;
  redirect_immediate?: boolean;
}

export interface AccountMetadata {
  id: string;
  created?: string;
  last_accessed?: string | null;
  iban?: string | null;
  bban?: string | null;
  institution_id: string;
  status: string;
  owner_name?: string | null;
}

export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/**
 * Requisition status codes, spelled out because the API returns the two-letter
 * form and a caller reading tool output should not have to look them up.
 */
export const REQUISITION_STATUS: Record<string, string> = {
  CR: "CREATED — the link exists, the end user has not opened it yet",
  GC: "GIVING_CONSENT — the end user is on the consent screen",
  UA: "UNDERGOING_AUTHENTICATION — the end user is authenticating with the bank",
  RJ: "REJECTED — consent was refused or the bank declined",
  SA: "SELECTING_ACCOUNTS — the end user is choosing which accounts to share",
  GA: "GRANTING_ACCESS — access is being granted to the selected accounts",
  LN: "LINKED — accounts are linked and their data can be read",
  EX: "EXPIRED — the access window elapsed, create a new requisition",
  SU: "SUSPENDED — the connection was suspended after repeated failures",
};

export function describeRequisitionStatus(status: string): string {
  return REQUISITION_STATUS[status] ?? status;
}

export const ACCESS_SCOPES = ["balances", "details", "transactions"] as const;

export const api = {
  listInstitutions(
    client: GoCardlessClient,
    query: { country?: string; access_scopes_supported?: string; payments_enabled?: boolean },
  ): Promise<Institution[]> {
    return client.request<Institution[]>("/institutions/", { query });
  },

  getInstitution(client: GoCardlessClient, id: string): Promise<Institution> {
    return client.request<Institution>(`/institutions/${encodeURIComponent(id)}/`);
  },

  createAgreement(
    client: GoCardlessClient,
    body: {
      institution_id: string;
      max_historical_days?: number;
      access_valid_for_days?: number;
      access_scope?: string[];
    },
  ): Promise<EndUserAgreement> {
    return client.request<EndUserAgreement>("/agreements/enduser/", { method: "POST", body });
  },

  listAgreements(
    client: GoCardlessClient,
    query: { limit?: number; offset?: number },
  ): Promise<Paginated<EndUserAgreement>> {
    return client.request<Paginated<EndUserAgreement>>("/agreements/enduser/", { query });
  },

  getAgreement(client: GoCardlessClient, id: string): Promise<EndUserAgreement> {
    return client.request<EndUserAgreement>(`/agreements/enduser/${encodeURIComponent(id)}/`);
  },

  acceptAgreement(
    client: GoCardlessClient,
    id: string,
    body: { user_agent: string; ip_address: string },
  ): Promise<EndUserAgreement> {
    return client.request<EndUserAgreement>(
      `/agreements/enduser/${encodeURIComponent(id)}/accept/`,
      { method: "PUT", body },
    );
  },

  deleteAgreement(client: GoCardlessClient, id: string): Promise<unknown> {
    return client.request(`/agreements/enduser/${encodeURIComponent(id)}/`, { method: "DELETE" });
  },

  createRequisition(
    client: GoCardlessClient,
    body: {
      institution_id: string;
      redirect: string;
      reference?: string;
      agreement?: string;
      user_language?: string;
      ssn?: string;
      account_selection?: boolean;
      redirect_immediate?: boolean;
    },
  ): Promise<Requisition> {
    return client.request<Requisition>("/requisitions/", { method: "POST", body });
  },

  listRequisitions(
    client: GoCardlessClient,
    query: { limit?: number; offset?: number },
  ): Promise<Paginated<Requisition>> {
    return client.request<Paginated<Requisition>>("/requisitions/", { query });
  },

  getRequisition(client: GoCardlessClient, id: string): Promise<Requisition> {
    return client.request<Requisition>(`/requisitions/${encodeURIComponent(id)}/`);
  },

  deleteRequisition(client: GoCardlessClient, id: string): Promise<unknown> {
    return client.request(`/requisitions/${encodeURIComponent(id)}/`, { method: "DELETE" });
  },

  getAccount(client: GoCardlessClient, id: string): Promise<AccountMetadata> {
    return client.request<AccountMetadata>(`/accounts/${encodeURIComponent(id)}/`);
  },

  getBalances(client: GoCardlessClient, id: string): Promise<unknown> {
    return client.request(`/accounts/${encodeURIComponent(id)}/balances/`);
  },

  getDetails(client: GoCardlessClient, id: string): Promise<unknown> {
    return client.request(`/accounts/${encodeURIComponent(id)}/details/`);
  },

  getTransactions(
    client: GoCardlessClient,
    id: string,
    query: { date_from?: string; date_to?: string },
  ): Promise<{ transactions?: { booked?: unknown[]; pending?: unknown[] } }> {
    return client.request(`/accounts/${encodeURIComponent(id)}/transactions/`, { query });
  },

  getPremiumTransactions(
    client: GoCardlessClient,
    id: string,
    query: { date_from?: string; date_to?: string; country?: string },
  ): Promise<unknown> {
    return client.request(`/accounts/premium/${encodeURIComponent(id)}/transactions/`, { query });
  },
};
