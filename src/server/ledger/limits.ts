const settings = {
  accounts: ["MAX_ACCOUNTS_PER_USER", 500],
  tags: ["MAX_TAGS_PER_USER", 500],
  dailyTransactions: ["MAX_TRANSACTIONS_PER_USER_PER_DAY", 2000],
} as const;

export type LedgerLimits = Record<keyof typeof settings, number>;

export function ledgerLimits(
  env: NodeJS.ProcessEnv = process.env,
): LedgerLimits {
  const read = (key: keyof LedgerLimits) => {
    const [variable, fallback] = settings[key];
    const value = Number(env[variable] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${variable} debe ser un entero positivo.`);
    return value;
  };
  return {
    accounts: read("accounts"),
    tags: read("tags"),
    dailyTransactions: read("dailyTransactions"),
  };
}
