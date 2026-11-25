import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
} from "kysely";
import { expect, test, vi } from "vitest";
import { createDatabase } from "./database.js";
import { readMigrationConfig } from "./config.js";

vi.mock("./database.js");
vi.mock("./config.js");

test("S19: migrate checks the server before Kysely creates migration tables", async () => {
  const db = new Kysely({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });
  const execute = vi.spyOn(db, "executeQuery").mockResolvedValue({
    rows: [
      {
        log_bin: 1,
        trust: 0,
        can_trigger: 1,
        has_super: 0,
        foreign_definers: 0,
      },
    ],
  });
  vi.mocked(readMigrationConfig).mockReturnValue({
    connection: {
      host: "localhost",
      port: 3308,
      user: "migrator",
      password: "",
      database: "finance_test",
    },
    mainDatabase: "finance_test",
    readonlyDatabase: "finance_test_ro",
  });
  vi.mocked(createDatabase).mockReturnValue({ db } as ReturnType<
    typeof createDatabase
  >);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitCode = process.exitCode;
  try {
    await import("./migrate.js");
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/administrador.*log_bin_trust_function_creators/),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toMatchObject({
      sql: expect.stringMatching(/^\s*SELECT\s+@@log_bin/i),
    });
  } finally {
    process.exitCode = exitCode;
    error.mockRestore();
  }
});
