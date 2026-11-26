import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("M-015 S9: documenta acceso, migración y revocación", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  expect(read("README.md")).toMatch(
    /## Dashboard v1[\s\S]+Iniciar sesión con Google[\s\S]+revoke-all <usuario>/,
  );
  expect(read("docs/operacion/despliegue.md")).toMatch(
    /Cliente OAuth en Google Cloud[\s\S]+\/auth\/google\/callback[\s\S]+Reconecta Claude[\s\S]+revoke-all <usuario>/,
  );
  expect(read("CHANGELOG.md").split("## [0.1.0]")[0]).toMatch(
    /## \[Unreleased\][\s\S]+Dashboard web/,
  );
});
