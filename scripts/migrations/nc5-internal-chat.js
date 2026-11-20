'use strict';
// NC5 · Chat interno por negocio. Aditiva y reentrante: una tabla nueva, sin cambios en tablas existentes ni FK.
// Sin argumentos solo audita. --apply / --revert requieren la base exacta y escritores detenidos.
// --revert respalda los mensajes en JSON antes de borrar la tabla.
const fs = require('node:fs/promises');
const path = require('node:path');

const TABLE = 'chat_message';
const DDL = `CREATE TABLE IF NOT EXISTS chat_message (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id_business VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  id_sender VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  id_recipient VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  pair_low VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  pair_high VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  client_request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body VARCHAR(2000) COLLATE utf8mb4_unicode_ci NULL,
  context_kind VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  context_ref VARCHAR(50) COLLATE utf8mb4_unicode_ci NULL,
  context_patient VARCHAR(50) COLLATE utf8mb4_unicode_ci NULL,
  reason_code VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  snap_patient_name VARCHAR(1001) COLLATE utf8mb4_unicode_ci NULL,
  snap_patient_code VARCHAR(8) COLLATE utf8mb4_unicode_ci NULL,
  snap_professional_id VARCHAR(50) COLLATE utf8mb4_unicode_ci NULL,
  snap_professional_name VARCHAR(500) COLLATE utf8mb4_unicode_ci NULL,
  snap_attention_date DATE NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  read_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_chat_message_public (public_id),
  UNIQUE KEY uq_chat_message_request (id_business, id_sender, client_request_id),
  KEY idx_chat_message_pair (id_business, pair_low, pair_high, id),
  KEY idx_chat_message_inbox (id_business, id_recipient, read_at, id),
  KEY idx_chat_message_sent (id_business, id_sender, id_recipient, id),
  KEY idx_chat_message_context (id_business, context_kind, context_ref),
  CONSTRAINT ck_chat_message_kind CHECK (kind IN ('text', 'team_notice')),
  CONSTRAINT ck_chat_message_self CHECK (id_sender <> id_recipient)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const EXPECTED_INDEXES = ['PRIMARY', 'uq_chat_message_public', 'uq_chat_message_request', 'idx_chat_message_pair',
    'idx_chat_message_inbox', 'idx_chat_message_sent', 'idx_chat_message_context'];

async function audit(db) {
    const [tables] = await db.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [TABLE]);
    const [required] = await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('login','rol','tracing','person')");
    const report = { ready: required.length === 4, alreadyApplied: false, table: TABLE, indexes: [] };
    if (!tables.length) return report;
    const [indexes] = await db.query('SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [TABLE]);
    report.indexes = indexes.map(row => row.INDEX_NAME).sort();
    const missing = EXPECTED_INDEXES.filter(name => !report.indexes.includes(name));
    if (missing.length) throw Error('NC5_CHAT_INCOMPATIBLE_TABLE');
    const [[count]] = await db.query(`SELECT COUNT(*) AS rows_count FROM ${TABLE}`);
    return { ...report, alreadyApplied: true, rows: Number(count.rows_count) };
}

async function apply(db) {
    const report = await audit(db);
    if (!report.ready) throw Error('NC5_CHAT_SCHEMA_NOT_READY');
    if (report.alreadyApplied) return report;
    await db.query(DDL);
    const after = await audit(db);
    if (!after.alreadyApplied) throw Error('NC5_CHAT_APPLY_INCOMPLETE');
    return after;
}

async function revert(db, backupDirectory) {
    const report = await audit(db);
    if (!report.alreadyApplied) return report;
    const [rows] = await db.query(`SELECT * FROM ${TABLE} ORDER BY id`);
    await fs.mkdir(backupDirectory, { recursive: true });
    await fs.writeFile(path.join(backupDirectory, 'chat-message-rows.json'), JSON.stringify(rows, null, 2), { flag: 'wx' });
    await db.query(`DROP TABLE ${TABLE}`);
    return { ...(await audit(db)), backedUpRows: rows.length };
}

async function main() {
    const mysql = require('mysql2/promise');
    const config = require('../../src/config/config');
    const args = process.argv.slice(2), applying = args.includes('--apply'), reverting = args.includes('--revert');
    const expected = args[args.indexOf('--expect-database') + 1];
    if ((applying || reverting) && (!args.includes('--expect-database') || expected !== config.DATABASEMYSQL || !args.includes('--writers-stopped'))) throw Error('NC5_CHAT_EXACT_TARGET_AND_STOPPED_WRITERS_REQUIRED');
    if (applying && reverting) throw Error('NC5_CHAT_ONE_ACTION');
    const db = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL, connectTimeout: 10000 });
    try {
        const backupArg = args.indexOf('--backup-directory');
        if (backupArg >= 0 && (!args[backupArg + 1] || args[backupArg + 1].startsWith('--'))) throw Error('NC5_CHAT_BACKUP_DIRECTORY_REQUIRED');
        const backup = backupArg >= 0 ? path.resolve(args[backupArg + 1]) : path.resolve(__dirname, '../../_schema_backups/nc5-chat-' + Date.now());
        const result = applying ? await apply(db) : reverting ? await revert(db, backup) : await audit(db);
        console.log(JSON.stringify({ readOnly: !applying && !reverting, ...result, ...(reverting ? { backup } : {}) }));
    } finally { await db.end(); }
}
if (require.main === module) main().catch(error => { console.error(/^NC5_CHAT_/.test(error.message) ? error.message : 'NC5_CHAT_MIGRATION_FAILED'); process.exitCode = 1; });
module.exports = { audit, apply, revert, DDL, TABLE };
