'use strict';
// Read-only by default. Existing installations need this before email-only registration.
const fs = require('node:fs/promises');
const path = require('node:path');
// Frozen S25 definitions: later changes to S24 must not change this migration.
function trigger(event) {
    return `CREATE TRIGGER s24_login_${event.toLowerCase()} AFTER ${event} ON login FOR EACH ROW
    BEGIN
        DECLARE pending_account TINYINT DEFAULT 0;
        SELECT COALESCE(MAX(subscription_status='pending_activation'),0) INTO pending_account
          FROM business WHERE id_business=NEW.id_business;
        IF NULLIF(TRIM(NEW.telephone),'') IS NOT NULL THEN
            CALL s24_claim_identity('phone',s24_phone(NEW.telephone),NEW.id_login,pending_account);
        END IF;
        CALL s24_claim_identity('email',s24_email(NEW.email),NEW.id_login,pending_account);
    END`;
}
function namesTrigger(event) {
    const compose = `SET NEW.first_name=TRIM(COALESCE(NEW.first_name,''));
        SET NEW.last_name=TRIM(COALESCE(NEW.last_name,''));
        SET NEW.name=TRIM(CONCAT_WS(' ',NULLIF(NEW.first_name,''),NULLIF(NEW.last_name,'')));`;
    const legacy = `SET NEW.first_name=COALESCE(NEW.name,''); SET NEW.last_name='';`;
    return `CREATE TRIGGER s25_login_names_${event.toLowerCase()} BEFORE ${event} ON login FOR EACH ROW
    BEGIN
        ${event === 'INSERT' ? `IF COALESCE(TRIM(NEW.first_name),'')='' AND COALESCE(TRIM(NEW.last_name),'')='' THEN
            ${legacy}
        ELSE ${compose} END IF;` : `IF NOT (NEW.first_name <=> OLD.first_name) OR NOT (NEW.last_name <=> OLD.last_name) THEN
            ${compose}
        ELSEIF NOT (NEW.name <=> OLD.name) THEN ${legacy} END IF;`}
    END`;
}
const triggers = { s24_login_insert: trigger('INSERT'), s24_login_update: trigger('UPDATE'),
    s25_login_names_insert: namesTrigger('INSERT'), s25_login_names_update: namesTrigger('UPDATE') };

async function audit(db) {
    const [columns] = await db.query("SELECT COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='auth_password_reset_tokens' AND COLUMN_NAME IN ('phone_normalized','identifier_normalized')");
    const [names] = await db.query("SELECT COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='login' AND COLUMN_NAME IN ('name','first_name','last_name')");
    const [[length]] = await db.query('SELECT COALESCE(MAX(CHAR_LENGTH(name)),0) AS max_name_length FROM login');
    const [existing] = await db.query("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('s24_login_insert','s24_login_update','s25_login_names_insert','s25_login_names_update')");
    const identity = existing.filter(row => row.TRIGGER_NAME.startsWith('s24_'));
    const separate = names.filter(row => row.COLUMN_NAME !== 'name');
    return { ready: columns.length === 1 && names.some(row => row.COLUMN_NAME === 'name') && identity.length === 2
            && Number(length.max_name_length) <= 500 && separate.every(row => row.COLUMN_TYPE === 'varchar(500)'),
        nameColumns: separate.map(row => row.COLUMN_NAME), triggerNames: existing.map(row => row.TRIGGER_NAME),
        alreadyApplied: columns[0]?.COLUMN_NAME === 'identifier_normalized' && columns[0]?.COLUMN_TYPE === 'varchar(254)'
            && separate.length === 2 && separate.every(row => row.COLUMN_TYPE === 'varchar(500)')
            && identity.length === 2 && identity.every(row => row.ACTION_STATEMENT.includes("NULLIF(TRIM(NEW.telephone),'')"))
            && existing.filter(row => row.TRIGGER_NAME.startsWith('s25_') && row.ACTION_STATEMENT.includes('NEW.first_name')).length === 2 };
}
async function apply(db, backupDirectory) {
    const report = await audit(db);
    if (!report.ready) throw Error('EMAIL_AUTH_SCHEMA_NOT_READY');
    if (report.alreadyApplied) return report;
    const originals = {};
    for (const name of report.triggerNames) {
        const [[row]] = await db.query('SHOW CREATE TRIGGER `' + name + '`');
        originals[name] = row['SQL Original Statement'];
    }
    const [[table]] = await db.query('SHOW CREATE TABLE auth_password_reset_tokens');
    const [[login]] = await db.query('SHOW CREATE TABLE login');
    await fs.mkdir(backupDirectory, { recursive: true });
    await fs.writeFile(path.join(backupDirectory, 'email-login-schema.json'), JSON.stringify({ triggers: originals, passwordResetTable: table['Create Table'], loginTable: login['Create Table'] }, null, 2), { flag: 'wx' });
    // DDL commits implicitly. Writers must stay stopped throughout replacement.
    // Retain the history, but invalidate old in-flight phone/email challenges at cutover.
    await db.query("UPDATE auth_password_reset_tokens SET status='revoked',revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW() WHERE purpose='password_reset' AND status IN ('pending','verified')");
    const [columns] = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='auth_password_reset_tokens' AND COLUMN_NAME='phone_normalized'");
    await db.query(columns.length
        ? 'ALTER TABLE auth_password_reset_tokens CHANGE COLUMN phone_normalized identifier_normalized VARCHAR(254) NOT NULL'
        : 'ALTER TABLE auth_password_reset_tokens MODIFY COLUMN identifier_normalized VARCHAR(254) NOT NULL');
    async function replace(definitions) {
        for (const [name, sql] of definitions) {
            if (originals[name]) await db.query('DROP TRIGGER `' + name + '`');
            try { await db.query(sql); }
            catch (error) { if (originals[name]) await db.query(originals[name]); throw error; }
        }
    }
    await replace(Object.entries(triggers).filter(([name]) => name.startsWith('s24_')));
    const additions = ['first_name','last_name'].filter(name => !report.nameColumns.includes(name));
    if (additions.length) await db.query('ALTER TABLE login ' + additions.map(name => `ADD COLUMN ${name} VARCHAR(500) NOT NULL DEFAULT ''`).join(','));
    // Existing full names stay intact. Surnames need explicit capture, not guesses.
    await db.query("UPDATE login SET first_name=COALESCE(name,'') WHERE first_name='' AND last_name=''");
    await replace(Object.entries(triggers).filter(([name]) => name.startsWith('s25_')));
    return audit(db);
}
async function main() {
    const mysql = require('mysql2/promise');
    const config = require('../../src/config/config');
    const args = process.argv.slice(2), writing = args.includes('--apply');
    const expected = args[args.indexOf('--expect-database') + 1];
    if (writing && (!args.includes('--expect-database') || expected !== config.DATABASEMYSQL || !args.includes('--writers-stopped'))) throw Error('EMAIL_AUTH_EXACT_TARGET_AND_STOPPED_WRITERS_REQUIRED');
    const db = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL, connectTimeout: 10000 });
    try {
        const result = writing ? await apply(db, path.resolve(__dirname, '../../.schema-backups/email-login-' + Date.now())) : await audit(db);
        console.log(JSON.stringify({ readOnly: !writing, ...result }));
    } finally { await db.end(); }
}
if (require.main === module) main().catch(error => { console.error(/^EMAIL_AUTH_/.test(error.message) ? error.message : 'EMAIL_AUTH_MIGRATION_FAILED'); process.exitCode = 1; });
module.exports = { audit, apply };
