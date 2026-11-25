import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

test("S26: source files have no Unicode BOM", () => {
  const boms = ["efbbbf", "fffe", "feff", "0000feff"];
  const files = readdirSync("src", { recursive: true, withFileTypes: true });
  const withBom = files
    .filter(
      (file) =>
        file.isFile() &&
        !/(^|[/\\])(dist|node_modules)([/\\]|$)/.test(file.parentPath),
    )
    .map((file) => join(file.parentPath, file.name))
    .filter((path) => {
      const prefix = readFileSync(path).subarray(0, 4).toString("hex");
      return boms.some((bom) => prefix.startsWith(bom));
    });
  expect(withBom).toEqual([]);
});
