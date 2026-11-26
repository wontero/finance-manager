import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>) {
  // La única entrada a la cascada de la bitácora es borrar la cuenta de usuario.
  await sql`CREATE TRIGGER IF NOT EXISTS operations_no_delete BEFORE DELETE ON operations
    FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Las operaciones solo se eliminan al borrar la cuenta'`.execute(
    db,
  );
  await sql`ALTER TABLE audit_log
    DROP FOREIGN KEY IF EXISTS audit_log_user_fk,
    DROP FOREIGN KEY IF EXISTS audit_log_user_operation_id_fk,
    ADD CONSTRAINT audit_log_account_purge_fk FOREIGN KEY IF NOT EXISTS audit_log_account_purge_fk
      (user_id, operation_id) REFERENCES operations(user_id, id) ON DELETE CASCADE`.execute(
    db,
  );
  await sql`ALTER TABLE operations
    DROP FOREIGN KEY IF EXISTS operations_user_fk,
    ADD CONSTRAINT operations_account_purge_fk FOREIGN KEY IF NOT EXISTS operations_account_purge_fk
      (user_id) REFERENCES users(id) ON DELETE CASCADE`.execute(db);
  await sql`ALTER TABLE auth_events
    ADD COLUMN IF NOT EXISTS user_id BIGINT UNSIGNED NULL,
    ADD CONSTRAINT auth_events_user_fk FOREIGN KEY IF NOT EXISTS auth_events_user_fk
      (user_id) REFERENCES users(id) ON DELETE CASCADE`.execute(db);
  await sql`ALTER TABLE web_sessions
    ADD COLUMN IF NOT EXISTS verified_email VARCHAR(320) NULL`.execute(db);
  await sql`ALTER TABLE google_login_requests
    ADD COLUMN IF NOT EXISTS reauth_session_hash BINARY(32) NULL,
    ADD CONSTRAINT google_login_session_fk FOREIGN KEY IF NOT EXISTS google_login_session_fk
      (reauth_session_hash) REFERENCES web_sessions(token_hash) ON DELETE CASCADE`.execute(
    db,
  );
  await sql`CREATE TABLE IF NOT EXISTS request_metrics (
    day DATE NOT NULL,
    channel ENUM('mcp', 'api') NOT NULL,
    status_class TINYINT UNSIGNED NOT NULL,
    requests BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (day, channel, status_class)
  ) ENGINE=InnoDB`.execute(db);
}
