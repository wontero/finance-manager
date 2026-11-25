import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("M-015 S9: documenta acceso, migración y revocación", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  expect(read("README.md")).toMatch(
    /## Dashboard v1[\s\S]+solo contraseña[\s\S]+Mateo/,
  );
  expect(read("docs/operacion/despliegue.md")).toMatch(
    /web_sessions[\s\S]+revoke-all/,
  );
  expect(read("CHANGELOG.md").split("## [0.1.0]")[0]).toMatch(
    /## \[Unreleased\][\s\S]+Dashboard web/,
  );
});
