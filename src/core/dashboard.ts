export type Money = { moneda: string; monto: string };
export type AccountKind =
  "asset" | "liability" | "income" | "expense" | "equity";
export type Actor = "claude" | "web" | "system";
export type TransactionType = "gasto" | "ingreso" | "transferencia" | "ajuste";

export type Page<T> = { rows: T[]; cursor: string | null };
export type Category = { id: string; name: string; amounts: Money[] };
export type Worth = { bob: Money; usd: Money | null; unvalued: string[] };
export type PeriodTotals = { income: Money; expense: Money }[];
export type DashboardMovements = Page<DashboardTransaction> & {
  dayTotals: Record<string, { income: Money[]; expense: Money[] }>;
};

export type DashboardTransaction = {
  id: string;
  date: string;
  description: string;
  note: string | null;
  custom: Record<string, string | number> | null;
  actor: Actor;
  type: TransactionType;
  tags: string[];
  postings: {
    accountId: string;
    name: string;
    money: Money;
    memo: string | null;
  }[];
  categories: {
    id: string;
    name: string;
    kind: "income" | "expense";
    money: Money;
  }[];
};

export type DashboardAccounts = {
  accounts: {
    id: string;
    parentId: string | null;
    name: string;
    path: string;
    kind: AccountKind;
    currency: string | null;
    archived: boolean;
    balances: Money[];
  }[];
};

export type DashboardSummary = {
  month: string;
  previousMonth: string;
  current: PeriodTotals;
  previous: PeriodTotals;
  liquid: Money[];
  netWorth: Worth;
  topCategories: Category[];
  recent: DashboardTransaction[];
};

export type DashboardReports = {
  months: { month: string; totals: PeriodTotals; netWorth: Worth }[];
  categories: Category[];
};

export type DashboardOperation = {
  id: string;
  date: string;
  actor: Actor;
  description: string;
  changes: { entity: string; before: string | null; after: string | null }[];
  undone: boolean;
  canUndo: boolean;
};

export type DashboardSession = { authenticated: true };
export type DashboardUndo = { operationId: string };
