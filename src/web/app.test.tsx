// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { App } from "./app";

test("renders Finance Manager and a shadcn Button", () => {
  render(<App />);

  expect(
    screen.getByRole("heading", { name: "Finance Manager" }),
  ).toBeDefined();
  expect(
    screen.getByRole("button", { name: "Finance Manager" }).dataset.slot,
  ).toBe("button");
});
