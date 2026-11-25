import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>) {
  const options = sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
  const currencyCode = sql`CHAR(3) CHARACTER SET ascii COLLATE ascii_bin`;
  const operationId = sql`CHAR(36) CHARACTER SET ascii COLLATE ascii_bin`;
  const statements = [
    sql`CREATE TABLE currencies (
      code ${currencyCode} PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      minor_unit TINYINT UNSIGNED NOT NULL
    ) ${options}`,
    sql`CREATE TABLE accounts (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      parent_id BIGINT UNSIGNED,
      name VARCHAR(160) NOT NULL,
      kind ENUM('asset', 'liability', 'income', 'expense', 'equity') NOT NULL,
      subtype ENUM('banco', 'efectivo', 'ahorro', 'inversion', 'tarjeta_credito',
        'prestamo_recibido', 'por_cobrar'),
      currency ${currencyCode},
      custom JSON,
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      archived_at DATETIME(3) NULL DEFAULT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      active_parent_id BIGINT UNSIGNED AS (IF(archived_at IS NULL, COALESCE(parent_id, 0), NULL)) VIRTUAL,
      CONSTRAINT accounts_active_sibling_name UNIQUE (active_parent_id, name),
      CONSTRAINT accounts_classification CHECK (
        (currency IS NOT NULL AND subtype IS NOT NULL AND (
          (kind = 'asset' AND subtype IN ('banco', 'efectivo', 'ahorro', 'inversion', 'por_cobrar'))
          OR (kind = 'liability' AND subtype IN ('tarjeta_credito', 'prestamo_recibido'))
        ))
        OR (kind IN ('income', 'expense', 'equity') AND currency IS NULL AND subtype IS NULL)
      ),
      FOREIGN KEY (parent_id) REFERENCES accounts(id),
      FOREIGN KEY (currency) REFERENCES currencies(code)
    ) ${options}`,
    sql`CREATE TABLE operations (
      id ${operationId} PRIMARY KEY,
      seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
      actor ENUM('claude', 'web', 'system') NOT NULL,
      description VARCHAR(255) NOT NULL,
      undoes_operation_id ${operationId} UNIQUE,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      FOREIGN KEY (undoes_operation_id) REFERENCES operations(id)
    ) ${options}`,
    sql`CREATE TABLE transactions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      date DATE NOT NULL,
      description VARCHAR(255) NOT NULL,
      note TEXT,
      custom JSON,
      operation_id ${operationId} NOT NULL,
      deleted_at DATETIME(3) NULL DEFAULT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX transactions_date_idx (date),
      FOREIGN KEY (operation_id) REFERENCES operations(id)
    ) ${options}`,
    sql`CREATE TABLE postings (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      transaction_id BIGINT UNSIGNED NOT NULL,
      account_id BIGINT UNSIGNED NOT NULL,
      currency ${currencyCode} NOT NULL,
      amount BIGINT NOT NULL,
      memo VARCHAR(255),
      CONSTRAINT postings_nonzero CHECK (amount <> 0),
      FOREIGN KEY (transaction_id) REFERENCES transactions(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (currency) REFERENCES currencies(code)
    ) ${options}`,
    sql`CREATE TABLE tags (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL UNIQUE
    ) ${options}`,
    sql`CREATE TABLE transaction_tags (
      transaction_id BIGINT UNSIGNED NOT NULL,
      tag_id BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (transaction_id, tag_id),
      FOREIGN KEY (transaction_id) REFERENCES transactions(id),
      FOREIGN KEY (tag_id) REFERENCES tags(id)
    ) ${options}`,
    sql`CREATE TABLE custom_field_definitions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      entity ENUM('transaction', 'account') NOT NULL,
      \`key\` VARCHAR(80) NOT NULL,
      label VARCHAR(120) NOT NULL,
      type ENUM('text', 'number', 'date', 'option') NOT NULL,
      options JSON,
      archived_at DATETIME(3) NULL DEFAULT NULL,
      UNIQUE (entity, \`key\`)
    ) ${options}`,
    sql`CREATE TABLE exchange_rates (
      date DATE NOT NULL,
      from_currency ${currencyCode} NOT NULL,
      to_currency ${currencyCode} NOT NULL,
      rate DECIMAL(24, 10) NOT NULL,
      source VARCHAR(160) NOT NULL,
      CONSTRAINT exchange_rates_positive CHECK (rate > 0),
      CONSTRAINT exchange_rates_distinct_currency CHECK (from_currency <> to_currency),
      PRIMARY KEY (from_currency, to_currency, date, source),
      FOREIGN KEY (from_currency) REFERENCES currencies(code),
      FOREIGN KEY (to_currency) REFERENCES currencies(code)
    ) ${options}`,
    sql`CREATE TABLE audit_log (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      operation_id ${operationId} NOT NULL,
      table_name VARCHAR(64) NOT NULL,
      row_id VARCHAR(255) NOT NULL,
      action ENUM('insert', 'update', 'delete') NOT NULL,
      \`before\` JSON,
      \`after\` JSON,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX audit_log_row_idx (table_name, row_id),
      FOREIGN KEY (operation_id) REFERENCES operations(id)
    ) ${options}`,
    sql`CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'La bitácora solo admite inserciones'`,
    sql`CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'La bitácora solo admite inserciones'`,
    sql`INSERT INTO currencies (code, name, minor_unit) VALUES
      ('BOB', 'Boliviano', 2), ('USD', 'Dólar estadounidense', 2)`,
    sql`INSERT INTO accounts (name, kind, is_system) VALUES
      ('Ingresos', 'income', TRUE), ('Gastos', 'expense', TRUE),
      ('Saldos iniciales', 'equity', TRUE), ('Ajustes de conciliación', 'equity', TRUE),
      ('Cambio de moneda', 'equity', TRUE)`,
  ];
  for (const statement of statements) await statement.execute(db);
}
