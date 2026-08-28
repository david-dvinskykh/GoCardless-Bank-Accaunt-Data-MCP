/** Everything a tool returns goes out as pretty JSON — clients parse it, humans read it. */
export function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

interface Amount {
  amount?: string;
  currency?: string;
}

interface RawTransaction {
  transactionId?: string;
  internalTransactionId?: string;
  bookingDate?: string;
  valueDate?: string;
  bookingDateTime?: string;
  transactionAmount?: Amount;
  creditorName?: string;
  debtorName?: string;
  creditorAccount?: { iban?: string };
  debtorAccount?: { iban?: string };
  remittanceInformationUnstructured?: string;
  remittanceInformationUnstructuredArray?: string[];
  additionalInformation?: string;
  bankTransactionCode?: string;
  merchantCategoryCode?: string;
  currencyExchange?: unknown;
}

export interface CompactTransaction {
  id?: string;
  date?: string;
  amount?: string;
  currency?: string;
  counterparty?: string;
  description?: string;
  code?: string;
}

/**
 * A year of transactions is tens of thousands of tokens of mostly-empty ISO
 * 20022 fields. The compact shape keeps what a person actually asks about;
 * `format: "raw"` is there when a field outside it is needed.
 */
export function compactTransaction(raw: unknown): CompactTransaction {
  const tx = (raw ?? {}) as RawTransaction;
  const amount = tx.transactionAmount ?? {};
  const numeric = Number(amount.amount);
  // Sign tells payer from payee: a negative amount is money leaving the account.
  const counterparty =
    (Number.isFinite(numeric) && numeric < 0 ? tx.creditorName : tx.debtorName) ??
    tx.creditorName ??
    tx.debtorName;
  const description =
    tx.remittanceInformationUnstructured ??
    tx.remittanceInformationUnstructuredArray?.join(" ") ??
    tx.additionalInformation;

  return dropUndefined({
    id: tx.transactionId ?? tx.internalTransactionId,
    date: tx.bookingDate ?? tx.valueDate ?? tx.bookingDateTime,
    amount: amount.amount,
    currency: amount.currency,
    counterparty: counterparty || undefined,
    description: description || undefined,
    code: tx.bankTransactionCode,
  });
}

export function sumAmounts(transactions: CompactTransaction[]): Record<string, string> {
  const totals = new Map<string, number>();
  for (const tx of transactions) {
    const value = Number(tx.amount);
    if (!Number.isFinite(value)) continue;
    const currency = tx.currency ?? "?";
    totals.set(currency, (totals.get(currency) ?? 0) + value);
  }
  const result: Record<string, string> = {};
  for (const [currency, value] of totals) {
    // Cents-level rounding: the API sends decimal strings, JS sums them as floats.
    result[currency] = (Math.round(value * 100) / 100).toFixed(2);
  }
  return result;
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
