import { rowId } from "@finance-manager/core";
import { z } from "zod";
import type { createLedger } from "../ledger/index.js";

export type Ledger = ReturnType<typeof createLedger>;
export const accountRef = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .describe("ID de cuenta o ruta completa, por ejemplo Gastos > Comida.");
const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(">")
    .map((part) => part.trim())
    .join(" > ");

export async function accountLookup(ledger: Ledger, includeArchived = false) {
  const accounts = (await ledger.getAccountTree(includeArchived)).map(
    (account) => ({
      ...account,
      key: normalize(account.path),
      leaf: normalize(account.name),
    }),
  );
  return (reference: string) => {
    const key = normalize(reference);
    const byId = rowId.safeParse(reference).success;
    const found = accounts.filter((account) =>
      byId ? account.id === reference : account.key === key,
    );
    if (found.length === 1) return found[0].id;
    const last = key.split(" > ").at(-1)!;
    const matches = accounts.filter(
      (account) => account.leaf === last || account.key === key,
    );
    const ambiguous =
      found.length > 1 || (!key.includes(" > ") && matches.length > 1);
    const candidates = (
      matches.length
        ? matches
        : accounts.filter(
            (account) =>
              account.key.includes(key) || account.leaf.includes(last),
          )
    ).slice(0, 5);
    const message = ambiguous
      ? "La referencia de cuenta es ambigua."
      : "No se encontró la cuenta.";
    const suggestions = candidates
      .map((account) => `${account.path} (id ${account.id})`)
      .join(", ");
    throw new Error(
      message +
        (suggestions
          ? " Candidatas: " + suggestions + "."
          : " No hay candidatas."),
    );
  };
}
