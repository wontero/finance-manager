import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
} from "kysely";
import { expect, test, vi } from "vitest";
import { readMigrationConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createReadonlyViews } from "./readonly-views.js";

vi.mock("./database.js");
vi.mock("./config.js");
vi.mock("./readonly-views.js");

const stringStatus = {
  log_bin: "1",
  trust: "0",
  can_trigger: 1,
  has_super: 0,
  foreign_definers: 0,
};
const binlogError = /administrador.*log_bin_trust_function_creators/;
const checkError = /No se pudieron comprobar los permisos de triggers/;

test.each([
  ["S19: blocked binary log (numbers)", { log_bin: 1, trust: 0 }, binlogError],
  ["S21: blocked binary log (strings)", {}, binlogError],
  ["S21: trusted binary log (strings)", { trust: "1" }, null],
  ["S21: inactive binary log (strings)", { log_bin: "0" }, null],
  ["S21: SUPER bypasses the trust requirement", { has_super: "1" }, null],
  ["S21: null binary log value", { log_bin: null }, checkError],
  ["S21: unexpected trust value", { trust: "2" }, checkError],
  ["S21: missing definer status", { foreign_definers: undefined }, checkError],
  ["S21: unexpected SUPER status", { has_super: "" }, checkError],
  [
    "S21: no TRIGGER privilege",
    { trust: "1", can_trigger: "0" },
    /privilegio TRIGGER/,
  ],
  [
    "S21: foreign definers",
    { trust: "1", foreign_definers: "1" },
    /vistas y los triggers.*pertenezcan al usuario de migración/,
  ],
])("%s", async (_name, overrides, expectedError) => {
  vi.resetModules();
  vi.clearAllMocks();
  const { Migrator } = await import("kysely/migration");
  const migrateToLatest = vi
    .spyOn(Migrator.prototype, "migrateToLatest")
    .mockResolvedValue({});
  const db = new Kysely({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });
  const execute = vi.spyOn(db, "executeQuery").mockResolvedValue({
    rows: [{ ...stringStatus, ...overrides }],
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
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const exitCode = process.exitCode;
  try {
    await import("./migrate.js");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toMatchObject({
      sql: expect.stringMatching(/^\s*SELECT\s+@@log_bin/i),
    });
    if (expectedError) {
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(expectedError));
      expect(migrateToLatest).not.toHaveBeenCalled();
      expect(createReadonlyViews).not.toHaveBeenCalled();
    } else {
      expect(process.exitCode).toBe(exitCode);
      expect(error).not.toHaveBeenCalled();
      expect(migrateToLatest).toHaveBeenCalledOnce();
      expect(createReadonlyViews).toHaveBeenCalledOnce();
    }
  } finally {
    process.exitCode = exitCode;
    error.mockRestore();
    log.mockRestore();
    migrateToLatest.mockRestore();
  }
});
