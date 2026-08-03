// Standard ODC subpoena document-request checklist.
//
// Derived from ODC's standard "Attachment to Subpoena" requesting the respondent
// attorney's complete office/client file AND all financial & accounting records.
// This canonical list is the template seeded into each subpoena's `requested_items`
// and is the checklist the production-reconciliation step grades a production against.
//
// The subpoena enumerates items (1)-(13); item (6) is a definitional header for the
// financial-records bucket, so the canonical list below collapses to 12 distinct,
// gradeable items split into two buckets.

export type ChecklistBucket = "office_file" | "financial_records";

export interface ChecklistItem {
  /** Stable id used as production_items.item_type */
  id: string;
  /** Human-readable label shown in the UI */
  label: string;
  bucket: ChecklistBucket;
  /** What a reviewer is looking for — also fed to the reconciliation model */
  description: string;
  /** Subpoena paragraph number(s) this item corresponds to */
  subpoenaRef: string;
  /**
   * True for items whose absence is a classic Rule 1.15 (trust/IOLTA) red flag.
   * A trust/estate/financial matter that does not produce these warrants escalation.
   */
  rule115Signal?: boolean;
}

export const SUBPOENA_CHECKLIST: ChecklistItem[] = [
  // ── Bucket A: Office / client file (subpoena items 1-5) ──────────────────
  {
    id: "fee_agreement",
    label: "Fee agreement(s)",
    bucket: "office_file",
    description:
      "Written fee, retainer, engagement, or representation agreement(s) between the attorney and client.",
    subpoenaRef: "(1)",
  },
  {
    id: "correspondence",
    label: "Correspondence & communications",
    bucket: "office_file",
    description:
      "All communications with the client, third parties, co-counsel, professionals, and staff — letters, emails, text messages, 'chat' communications, audio tapes, and telephone messages/logs.",
    subpoenaRef: "(2)",
  },
  {
    id: "file_financial_records",
    label: "Financial records within the file",
    bucket: "office_file",
    description:
      "Bills, invoices, accountings, client ledgers, settlement sheets, time sheets, and other documents in the file relating to the receipt, deposit, disbursement, or transfer of client funds (including copies of checks, deposit slips, and bank statements).",
    subpoenaRef: "(3)",
  },
  {
    id: "pleadings_work_product",
    label: "Pleadings & work product",
    bucket: "office_file",
    description:
      "Pleadings, drafts of pleadings, e-filing notifications, research, work product, and demonstrative records.",
    subpoenaRef: "(4)",
  },
  {
    id: "notes_memos",
    label: "Notes & memoranda to file",
    bucket: "office_file",
    description: "Notes, memoranda to the file, and writings on 'post-it' sheets.",
    subpoenaRef: "(5)",
  },

  // ── Bucket B: Financial & accounting records (subpoena items 7-13) ───────
  {
    id: "signature_cards",
    label: "Signature cards & account-opening IDs",
    bucket: "financial_records",
    description:
      "Signature card(s) and all updates, including copies of identification used to open and close the account (driver's license, social security card, etc.).",
    subpoenaRef: "(7)",
  },
  {
    id: "account_identification",
    label: "Account identification",
    bucket: "financial_records",
    description:
      "Full financial institution(s), full account name(s), and full account number(s) where funds related to the representation were deposited or disbursed, including payments and refunds.",
    subpoenaRef: "(8)",
  },
  {
    id: "bank_statements",
    label: "Monthly bank statements",
    bucket: "financial_records",
    description:
      "Monthly bank account statements for any financial accounts where funds related to the representation were deposited or disbursed.",
    subpoenaRef: "(9)",
  },
  {
    id: "general_ledger",
    label: "General ledger / check register",
    bucket: "financial_records",
    description:
      "A general ledger, check register, or journal recording all deposits and withdrawals — transaction date, payor, description of each deposit, payee, explanation of each disbursement, and a running balance of the account.",
    subpoenaRef: "(10)",
    rule115Signal: true,
  },
  {
    id: "subsidiary_client_ledger",
    label: "Subsidiary client ledger",
    bucket: "financial_records",
    description:
      "Subsidiary client ledger showing all funds deposited/withdrawn for this client — transaction date, payor, payee, description of each transaction, amount, and a running balance of the funds held for the client. Absence in a trust/estate matter is a primary Rule 1.15 misappropriation signal.",
    subpoenaRef: "(11)",
    rule115Signal: true,
  },
  {
    id: "processor_records",
    label: "Payment-processor records",
    bucket: "financial_records",
    description:
      "For any ACH and/or credit-card transactions through payment processors (Zelle, Freedom Merchants, Intuit QuickBooks, LawPay, etc.), detailed transaction reports and monthly statements for the period.",
    subpoenaRef: "(12)",
  },
  {
    id: "disbursement_records",
    label: "Disbursement & billing records",
    bucket: "financial_records",
    description:
      "Disbursement sheets, billing statements, invoices, time sheets, credit-card processing reports, and correspondence relating to payment/refund instructions and financial issues (filing fees, liens, billing disputes, refund disputes).",
    subpoenaRef: "(13)",
  },
];

/** Default requested-items payload (all items) for a new "BOTH" subpoena. */
export function defaultRequestedItems(): { item_type: string; description: string }[] {
  return SUBPOENA_CHECKLIST.map((i) => ({ item_type: i.id, description: i.label }));
}

/** Items belonging to one bucket — e.g. for a CLIENT_FILE-only or FINANCIAL_RECORDS-only subpoena. */
export function checklistForBucket(bucket: ChecklistBucket): ChecklistItem[] {
  return SUBPOENA_CHECKLIST.filter((i) => i.bucket === bucket);
}

/** Look up a checklist item by its stable id. */
export function checklistItemById(id: string): ChecklistItem | undefined {
  return SUBPOENA_CHECKLIST.find((i) => i.id === id);
}
