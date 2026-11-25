import { expect, test } from "vitest";
import {
  accruedInterest,
  interestDenominator,
  roundInterest,
  splitLoanPayment,
} from "./loans.js";

test.each([
  [100_000n, "2", "monthly", "2024-01-01", "2024-01-31", 1973n],
  [100_000n, "24", "annual", "2024-01-01", "2024-12-31", 24_000n],
  [100_000n, "0", "annual", "2024-01-01", "2024-12-31", 0n],
  [0n, "2", "monthly", "2024-01-01", "2024-01-31", 0n],
  [
    9_007_199_254_740_993n,
    "100",
    "annual",
    "2024-01-01",
    "2024-12-31",
    9_007_199_254_740_993n,
  ],
] as const)(
  "M-008 S1: %s at %s%% %s from %s to %s",
  (principal, rate, period, from, to, expected) => {
    expect(
      roundInterest(accruedInterest(principal, rate, period, from, to)),
    ).toBe(expected);
  },
);

test("M-008 S2: interest first on reduced principal with exact carry", () => {
  const dates = ["2024-01-01", "2024-01-31", "2024-03-01", "2024-03-31"];
  let principal = 100_000n;
  let carry = 0n;
  let paid = 0n;
  let exact = 0n;
  const expected = [
    { interest: 1973n, principal: 8027n },
    { interest: 1814n, principal: 8186n },
    { interest: 1653n, principal: 8347n },
  ];
  for (const [i, split] of expected.entries()) {
    const segment = accruedInterest(
      principal,
      "2",
      "monthly",
      dates[i],
      dates[i + 1],
    );
    const payment = splitLoanPayment(principal, carry + segment, 10_000n);
    expect(payment).toMatchObject(split);
    principal -= payment.principal;
    carry = payment.carry;
    paid += payment.interest;
    exact += segment;
  }
  expect(exact - paid * interestDenominator).toBe(carry);
  expect(carry).toBeGreaterThan(-interestDenominator);
  expect(carry).toBeLessThan(interestDenominator);
});

test("M-008 S2: ties round away from zero and a zero-day payment keeps the carry", () => {
  const half = interestDenominator / 2n;
  expect(roundInterest(half)).toBe(1n);
  expect(roundInterest(-half)).toBe(-1n);
  expect(splitLoanPayment(100n, 5n * interestDenominator + half, 2n)).toEqual({
    principal: 0n,
    interest: 2n,
    carry: 3n * interestDenominator + half,
  });
  expect(splitLoanPayment(100n, -half, 1n)).toEqual({
    principal: 1n,
    interest: 0n,
    carry: -half,
  });
});
