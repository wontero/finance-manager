import type { Money } from "@finance-manager/core";

const decimal = new Intl.NumberFormat("es-BO", {
  maximumFractionDigits: 0,
  useGrouping: true,
});
const local = new Intl.DateTimeFormat("es-BO", {
  timeZone: "America/La_Paz",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const time = new Intl.DateTimeFormat("es-BO", {
  timeZone: "America/La_Paz",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const month = new Intl.DateTimeFormat("es-BO", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});

export function displayMoney(
  { moneda, monto }: Money,
  flow?: "income" | "expense",
) {
  const [integer, fraction] = monto.replace(/^-/, "").split(".");
  const negative = monto.startsWith("-") !== (flow === "expense");
  const sign = negative ? "−" : flow ? "+" : "";
  const label = moneda === "BOB" ? "Bs" : moneda === "USD" ? "US$" : moneda;
  return (
    sign +
    label +
    " " +
    decimal.format(BigInt(integer)) +
    (fraction ? "," + fraction : "")
  );
}

export function displayDate(value: string) {
  if (value.length === 10) return value.split("-").reverse().join("/");
  return local.format(new Date(value));
}

export const displayTime = (value: string) => time.format(new Date(value));
export const displayMonth = (value: string) =>
  month.format(new Date(value + "-01T00:00:00Z"));
