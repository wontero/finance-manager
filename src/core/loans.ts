export const interestDenominator = 100n * 1_000_000n * 365n;

export function accruedInterest(
  principal: bigint,
  rate: string,
  period: "monthly" | "annual",
  from: string,
  to: string,
) {
  const [whole, fraction = ""] = rate.split(".");
  const fixedRate = BigInt(whole + fraction.padEnd(6, "0"));
  const days =
    (BigInt(Date.parse(to)) - BigInt(Date.parse(from))) / 86_400_000n;
  return principal * fixedRate * (period === "monthly" ? 12n : 1n) * days;
}

export function roundInterest(numerator: bigint) {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (magnitude + interestDenominator / 2n) / interestDenominator;
  return numerator < 0n ? -rounded : rounded;
}

export function loanInterestDue(numerator: bigint) {
  return numerator <= 0n ? 0n : roundInterest(numerator);
}

export function splitLoanPayment(
  principal: bigint,
  pending: bigint,
  amount: bigint,
) {
  const due = loanInterestDue(pending);
  if (amount <= 0n || amount > principal + due)
    throw new Error("El abono debe ser positivo y no superar lo adeudado.");
  const interest = amount < due ? amount : due;
  return {
    interest,
    principal: amount - interest,
    carry: pending - interest * interestDenominator,
  };
}
