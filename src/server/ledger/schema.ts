import type { Generated, Selectable } from "kysely";
import type { LedgerInput } from "@finance-manager/core";

export type Actor = "claude" | "web" | "system";
export type AccountKind =
  LedgerInput<"createAccount">["kind"] | "income" | "expense" | "equity";
type FieldType = LedgerInput<"defineCustomField">["type"];

export type LedgerDatabase = {
  currencies: { code: string; name: string; minor_unit: number };
  accounts: {
    id: Generated<string>;
    parent_id: Generated<string | null>;
    name: string;
    kind: AccountKind;
    subtype: Generated<LedgerInput<"createAccount">["subtype"] | null>;
    currency: Generated<string | null>;
    custom: Generated<string | null>;
    is_system: Generated<number>;
    archived_at: Generated<string | null>;
    created_at: Generated<string>;
    updated_at: Generated<string>;
    active_parent_id: Generated<string | null>;
  };
  operations: {
    id: string;
    seq: Generated<string>;
    actor: Actor;
    description: string;
    undoes_operation_id: Generated<string | null>;
    created_at: Generated<string>;
  };
  transactions: {
    id: Generated<string>;
    date: string;
    description: string;
    note: Generated<string | null>;
    custom: Generated<string | null>;
    operation_id: string;
    deleted_at: Generated<string | null>;
    created_at: Generated<string>;
    updated_at: Generated<string>;
  };
  postings: {
    id: Generated<string>;
    transaction_id: string;
    account_id: string;
    currency: string;
    amount: string;
    memo: Generated<string | null>;
  };
  tags: { id: Generated<string>; name: string };
  transaction_tags: { transaction_id: string; tag_id: string };
  custom_field_definitions: {
    id: Generated<string>;
    entity: "account" | "transaction";
    key: string;
    label: string;
    type: FieldType;
    options: Generated<string | null>;
    archived_at: Generated<string | null>;
  };
  exchange_rates: {
    from_currency: string;
    to_currency: string;
    date: string;
    source: string;
    rate: string;
  };
  audit_log: {
    id: Generated<string>;
    operation_id: string;
    table_name: string;
    row_id: string;
    action: "insert" | "update" | "delete";
    before: string | null;
    after: string | null;
    created_at: Generated<string>;
  };
};

export type Account = Selectable<LedgerDatabase["accounts"]>;
export type Posting = Selectable<LedgerDatabase["postings"]>;
export type ExchangeRate = Selectable<LedgerDatabase["exchange_rates"]>;

export const systemAccounts = {
  income: "Ingresos",
  expense: "Gastos",
  opening: "Saldos iniciales",
  adjustment: "Ajustes de conciliación",
  clearing: "Cambio de moneda",
} as const;
