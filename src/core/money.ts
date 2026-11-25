const bigintLimit = 2n ** 63n;
const rateScale = 10n ** 10n;
const calendar = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/La_Paz",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function todayLaPaz(now = new Date()) {
  return calendar.format(now);
}

export function assertStorageAmount(amount: bigint) {
  if (amount < -bigintLimit || amount >= bigintLimit)
    throw new Error("El monto excede el rango de BIGINT.");
  return amount;
}

export function parseAmount(text: unknown, minorUnit: number) {
  if (typeof text !== "string")
    throw new Error("El monto debe ser un texto decimal.");
  const trimmed = text.trim();
  const normalized = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+),\d+$/.test(trimmed)
    ? trimmed.replaceAll(".", "").replace(",", ".")
    : trimmed;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match || match[0] !== normalized)
    throw new Error("Formato de monto inválido.");
  const [, sign, integer, fraction = ""] = match;
  if (fraction.length > minorUnit) {
    if (/^-?\d{1,3}[.,]\d{3}$/.test(trimmed))
      throw new Error(
        'Formato ambiguo. Usa un formato como "1.234,00" o "1234.00".',
      );
    throw new Error(`El monto admite hasta ${minorUnit} decimales.`);
  }
  return assertStorageAmount(
    BigInt(sign + integer + fraction.padEnd(minorUnit, "0")),
  );
}

export function formatAmount(
  units: bigint,
  currency: string,
  minorUnit?: number,
) {
  const decimals =
    minorUnit ?? (currency === "BOB" || currency === "USD" ? 2 : undefined);
  if (decimals === undefined)
    throw new Error(`Falta la unidad mínima de ${currency}.`);
  const digits = (units < 0n ? -units : units)
    .toString()
    .padStart(decimals + 1, "0");
  const decimalIndex = digits.length - decimals;
  const integer = digits
    .slice(0, decimalIndex)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (
    (units < 0n ? "-" : "") +
    integer +
    (decimals ? "," + digits.slice(decimalIndex) : "")
  );
}

export function parseRate(rate: string) {
  const match = /^(\d{1,14})(?:\.(\d{1,10}))?$/.exec(rate);
  if (typeof rate !== "string" || !match || match[0] !== rate)
    throw new Error(
      "El tipo de cambio requiere un decimal con hasta 14 enteros y 10 decimales.",
    );
  const fixed = BigInt(match[1] + (match[2] ?? "").padEnd(10, "0"));
  if (fixed === 0n) throw new Error("El tipo de cambio debe ser positivo.");
  return fixed;
}

export function convert(
  units: bigint,
  rate: string,
  fromMinor = 2,
  toMinor = 2,
) {
  const scaled =
    (units < 0n ? -units : units) * parseRate(rate) * 10n ** BigInt(toMinor);
  const divisor = rateScale * 10n ** BigInt(fromMinor);
  return ((scaled + divisor / 2n) / divisor) * (units < 0n ? -1n : 1n);
}

export function assertBalanced(
  lines: readonly { currency: string; amount: bigint }[],
) {
  if (lines.length < 2)
    throw new Error("El asiento requiere al menos dos líneas.");
  const sums = new Map<string, bigint>();
  for (const { currency, amount } of lines) {
    if (amount === 0n) throw new Error("Una línea no puede tener monto cero.");
    assertStorageAmount(amount);
    sums.set(currency, (sums.get(currency) ?? 0n) + amount);
  }
  for (const [currency, sum] of sums) {
    if (sum !== 0n)
      throw new Error(`El asiento está descuadrado en ${currency}.`);
  }
}
