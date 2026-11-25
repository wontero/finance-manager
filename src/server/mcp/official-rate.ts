import { accountingDate, parseRate } from "@finance-manager/core";
import { z } from "zod";

const officialUrl = "https://apibcb.cucu.bo/api/v1/tc/oficial";
const quoteSchema = z.object({
  tc_oficial: z.object({
    moneda: z.literal("USD/BOB"),
    desactualizado: z.literal(false),
    vigencia_desde: accountingDate,
    valor: z.number().positive(),
  }),
});

async function fetchOfficialRate() {
  const signal = AbortSignal.timeout(5_000);
  const timeout = "La consulta del tipo de cambio oficial superó 5 segundos.";
  const response = await fetch(officialUrl, {
    signal,
    redirect: "error",
  }).catch(() => {
    throw new Error(
      signal.aborted
        ? timeout
        : "No se pudo consultar el servicio de tipo de cambio oficial.",
    );
  });
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(
      `El servicio de tipo de cambio oficial respondió con HTTP ${response.status}.`,
    );
  }
  const body: unknown = await response.json().catch(() => {
    throw new Error(
      signal.aborted
        ? timeout
        : "La respuesta del tipo de cambio oficial no es un JSON válido.",
    );
  });
  const quote = quoteSchema.safeParse(body);
  if (!quote.success)
    throw new Error(
      "El servicio no devolvió un tipo de cambio oficial vigente y válido para USD/BOB.",
    );
  const { valor, vigencia_desde: date } = quote.data.tc_oficial;
  const rate = String(valor);
  try {
    parseRate(rate);
  } catch {
    throw new Error(
      "El valor del tipo de cambio oficial excede la precisión decimal admitida.",
    );
  }
  const source = `Tipo de cambio oficial BCB vía apibcb.cucu.bo (tercero no afiliado al BCB), vigencia ${date} — ${officialUrl}`;
  return { date, rate, source };
}

let cached: { until: number; quote: ReturnType<typeof fetchOfficialRate> };

export function getOfficialRate() {
  const now = performance.now();
  if (!cached || now >= cached.until)
    cached = { until: now + 60_000, quote: fetchOfficialRate() };
  return cached.quote;
}
