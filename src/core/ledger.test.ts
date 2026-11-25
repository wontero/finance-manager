import { expect, test } from "vitest";
import { convert, formatAmount, parseAmount, todayLaPaz } from "./index.js";

test("M-004 S1: parse and format money without losing cents", () => {
  for (const text of ["1234.56", "1.234,56"])
    expect(parseAmount(text, 2)).toBe(123456n);
  expect(parseAmount("0,5", 2)).toBe(50n);
  expect(parseAmount("-92233720368547758.08", 2)).toBe(-(2n ** 63n));
  for (const invalid of [
    "1.234,567",
    "abc",
    "",
    1234.5,
    "92233720368547758.08",
  ])
    expect(() => parseAmount(invalid, 2)).toThrow();
  expect(formatAmount(123456n, "BOB")).toBe("1.234,56");
  expect(formatAmount(-123456n, "BOB")).toBe("-1.234,56");
  expect(todayLaPaz(new Date("2026-11-24T03:59:59Z"))).toBe("2026-11-23");
});

test("M-004 S2: conversion is exact and rounds ties away from zero", () => {
  expect(convert(10000n, "6.96")).toBe(69600n);
  expect(convert(1n, "0.5")).toBe(1n);
  expect(convert(-1n, "0.5")).toBe(-1n);
  expect(convert(9007199254740993n, "1")).toBe(9007199254740993n);
});
