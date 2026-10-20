'use strict';
// Explicit operator command only. Never imported by application startup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const candidates = require('./po14-index-candidates.json');
const workspace = path.resolve(__dirname, '../../..');
function outputPaths(repoRoot, hasWorkspace, override) {
    if (override) { const root = path.resolve(override); return { evidence: path.join(root, 'evidence'), backups: path.join(root, 'backups') }; }
    if (hasWorkspace) return { evidence: path.join(path.dirname(repoRoot), 'docs/platform-operations/evidence/PO15'), backups: path.join(path.dirname(repoRoot), '_schema_backups') };
    return { evidence: path.join(repoRoot, '.local/po15/evidence'), backups: path.join(repoRoot, '.local/po15/backups') };
}
const identifier = value => { if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw failure('INVALID_IDENTIFIER'); return '`' + value + '`'; };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function failure(code) { const error = new Error(code); error.code = code; return error; }
function columns(candidate) { return candidate.columns.map(column => { const [name, direction = 'ASC'] = column.split(' '); identifier(name); if (!['ASC', 'DESC'].includes(direction)) throw failure('INVALID_DIRECTION'); return { name, direction: direction === 'DESC' ? 'D' : 'A' }; }); }
function equivalent(candidate, indexes) {
    const required = columns(candidate), groups = new Map();
    for (const row of indexes.filter(row => row.TABLE_NAME === candidate.table)) {
        if (!groups.has(row.INDEX_NAME)) groups.set(row.INDEX_NAME, []);
        groups.get(row.INDEX_NAME).push(row);
    }
    for (const [name, rows] of groups) {
        rows.sort((a, b) => a.SEQ_IN_INDEX - b.SEQ_IN_INDEX);
        if (rows.length < required.length || rows.some(row => row.IS_VISIBLE !== 'YES' || row.SUB_PART != null)) continue;
        if (!required.every((column, index) => rows[index].COLUMN_NAME === column.name)) continue;
        // Equality prefixes do not constrain scan direction; ordered suffixes can use a backward scan.
        const ordered = required.map((column, index) => ({ ...column, index })).filter(column => candidate.columns[column.index].includes(' DESC'));
        const directions = ordered.length ? ordered : required.map((column, index) => ({ ...column, index }));
        if (directions.every(column => rows[column.index].COLLATION === column.direction)
            || directions.every(column => rows[column.index].COLLATION === (column.direction === 'D' ? 'A' : 'D'))) return name;
    }
    return null;
}
function createSql(candidate) {
    return `ALTER TABLE ${identifier(candidate.table)} ADD INDEX ${identifier(candidate.name)} (${columns(candidate).map(column => identifier(column.name) + (column.direction === 'D' ? ' DESC' : '')).join(', ')}), ALGORITHM=INPLACE, LOCK=NONE`;
}
function makePlan(indexes) {
    return candidates.map(candidate => {
        const coveringIndex = equivalent(candidate, indexes);
        if (!coveringIndex && indexes.some(row => row.TABLE_NAME === candidate.table && row.INDEX_NAME === candidate.name)) throw failure('INDEX_NAME_CONFLICT');
        return { ...candidate, action: coveringIndex ? 'skip-covered' : 'create', coveringIndex, sql: createSql(candidate) };
    });
}
const tableNames = [...new Set(candidates.map(candidate => candidate.table))];
async function readIndexes(connection) {
    const [rows] = await connection.query(`SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,COLLATION,SUB_PART,IS_VISIBLE
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`, [tableNames]);
    return rows;
}
async function preflight(connection) {
    const [rows] = await connection.query('SELECT DATABASE() AS selected_database, VERSION() AS version, @@read_only AS read_only, @@server_uuid AS server_uuid, @@innodb_buffer_pool_size AS buffer_pool_bytes');
    const identity = rows[0];
    if (!/^8\.0\./.test(identity.version) || Number(identity.read_only)) throw failure('UNSUPPORTED_OR_READONLY_SERVER');
    const [tables] = await connection.query(`SELECT TABLE_NAME,ENGINE,TABLE_ROWS,DATA_LENGTH,INDEX_LENGTH FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME`, [tableNames]);
    if (tables.length !== tableNames.length || tables.some(table => table.ENGINE !== 'InnoDB')) throw failure('TABLES_OR_ENGINE_MISMATCH');
    if (tables.some(table => Number(table.DATA_LENGTH) + Number(table.INDEX_LENGTH) > 64 * 1024 * 1024)) throw failure('TABLE_REQUIRES_LARGER_MIGRATION_REVIEW');
    const [status] = await connection.query("SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Uptime')");
    if (Number((status.find(row => row.Variable_name === 'Threads_running') || {}).Value) > 5) throw failure('SERVER_BUSY');
    return { identity, tables, status, indexes: await readIndexes(connection) };
}
function summarizePlan(value, result = { tables: [], sorts: [], queryCost: null }) {
    if (!value || typeof value !== 'object') return result;
    if (result.queryCost === null && value.query_block && value.query_block.cost_info) result.queryCost = value.query_block.cost_info.query_cost || null;
    if (value.table_name) result.tables.push(Object.fromEntries(['table_name','access_type','possible_keys','key','used_key_parts','rows_examined_per_scan','rows_produced_per_join','filtered','using_index','backward_index_scan'].filter(key => value[key] !== undefined).map(key => [key, value[key]])));
    if (Object.hasOwn(value, 'using_filesort')) result.sorts.push({ usingFilesort: value.using_filesort });
    for (const item of Object.values(value)) if (item && typeof item === 'object') summarizePlan(item, result);
    return result;
}
async function explainReads(connection) {
    const templates = require('./po15-query-templates.json');
    const chosen = [
        ['documents', templates.find(item => item.sql.includes('SELECT pd.*') && item.sql.includes('LIMIT :_limit') && !item.sql.includes(':_document'))],
        ['prescriptions-patient', templates.find(item => item.sql.includes('FROM prescription p') && item.sql.includes('LIMIT :_limit') && !item.sql.includes('OR p.created_by'))],
        ['plans-history', templates.find(item => item.sql.includes('FROM treatment_plan tp') && item.sql.includes("tp.status <> 'active'"))],
        ['plan-items', templates.find(item => item.sql.includes('SELECT pt.*') && item.sql.includes('IN (:planIds)'))],
        ['plan-document-latest', templates.find(item => item.sql.includes('FROM treatment_plan_consent_document link') && item.sql.includes('NOT EXISTS'))],
        ['retention-business', templates.find(item => item.sql.includes('AS firstVisitPatients') && !item.sql.includes(':_doctor_profile'))]
    ];
    if (chosen.some(([, template]) => !template)) throw failure('EXPLAIN_TEMPLATE_MISSING');
    const rx = chosen.find(([name]) => name === 'prescriptions-patient')[1].sql;
    chosen.push(['prescriptions-business', { sql: rx.replace(/AND p\.id_person COLLATE utf8mb4_unicode_ci = :_id_person COLLATE utf8mb4_unicode_ci/g, '') }]);
    chosen.push(['patient-directory', { sql: `SELECT p.id_person,p.name,p.surname,p.created_at FROM person p
        WHERE p.id_business COLLATE utf8mb4_unicode_ci = :_id_business COLLATE utf8mb4_unicode_ci AND p.active=1
        ORDER BY p.created_at DESC,p.name ASC,p.id_person ASC LIMIT :_limit OFFSET :_offset` }]);
    const results = [];
    for (const [name, template] of chosen) {
        const table = name === 'patient-directory' ? 'person' : name.startsWith('prescriptions') ? 'prescription' : name === 'documents' ? 'patient_documents'
            : name === 'plans-history' ? 'treatment_plan' : name === 'plan-items' ? 'patient_treatment' : name === 'plan-document-latest' ? 'treatment_plan_consent_document' : 'appointment';
        // Opaque scope IDs only, kept in memory; neither row contents nor IDs are recorded.
        const planField = table === 'patient_treatment' || table === 'treatment_plan_consent_document' ? ',id_treatment_plan' : '';
        const [scopes] = await connection.query(`SELECT id_business,id_person${planField},COUNT(*) AS n FROM ${identifier(table)}
            WHERE id_business IS NOT NULL AND id_person IS NOT NULL GROUP BY id_business,id_person${planField} ORDER BY n DESC LIMIT 1`);
        const scope = scopes[0] || {};
        const replacements = { _id_business: scope.id_business || '__PO15_EMPTY_SCOPE__', business: scope.id_business || '__PO15_EMPTY_SCOPE__',
            _id_person: scope.id_person || '__PO15_EMPTY_SCOPE__', patient: scope.id_person || '__PO15_EMPTY_SCOPE__',
            planIds: [scope.id_treatment_plan || '__PO15_EMPTY_SCOPE__'], _limit: 10, _offset: 0, limit: 5, offset: 0,
            _from: '2026-10-01 00:00:00', _to: '2026-10-19 23:59:59' };
        const values = [];
        const sql = template.sql.replace(/:(\w+)/g, (_match, key) => { if (!Object.hasOwn(replacements, key)) throw failure('EXPLAIN_PARAMETER_MISSING'); values.push(replacements[key]); return '?'; });
        const [rows] = await connection.query('EXPLAIN FORMAT=JSON ' + sql, values);
        const raw = JSON.parse(rows[0].EXPLAIN);
        results.push({ name, templateHash: digest(template.sql), ...summarizePlan(raw) });
    }
    return results;
}
async function applyPlan(connection, plan, record) {
    await connection.query('SET SESSION lock_wait_timeout = 5');
    await connection.query('SET SESSION innodb_lock_wait_timeout = 5');
    for (const candidate of plan) {
        if (candidate.action !== 'create') continue;
        const current = await readIndexes(connection), covered = equivalent(candidate, current);
        if (covered) { record({ name: candidate.name, table: candidate.table, status: 'skip-covered', coveringIndex: covered }); continue; }
        if (current.some(row => row.TABLE_NAME === candidate.table && row.INDEX_NAME === candidate.name)) throw failure('INDEX_NAME_CONFLICT');
        const started = Date.now();
        record({ name: candidate.name, table: candidate.table, status: 'starting' });
        try {
            await connection.query(candidate.sql);
            const after = await readIndexes(connection);
            if (!equivalent(candidate, after.filter(row => row.INDEX_NAME === candidate.name))) throw failure('INDEX_VERIFICATION_FAILED');
            record({ name: candidate.name, table: candidate.table, status: 'applied-verified', elapsedMs: Date.now() - started });
        } catch (error) {
            record({ name: candidate.name, table: candidate.table, status: 'failed-or-unconfirmed', errorCode: error.code || 'UNKNOWN' });
            throw error; // Never fall back to COPY/locking DDL, drop an index or continue after failure.
        }
    }
}
async function main() {
    const args = process.argv.slice(2), applying = args.includes('--apply');
    const argument = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
    const expectedDatabase = argument('--database'), inspectionPath = argument('--inspection');
    if (!expectedDatabase || (applying && !inspectionPath)) throw failure('DATABASE_AND_INSPECTION_REQUIRED');
    const config = require('../../src/config/config');
    if (config.DATABASEMYSQL !== expectedDatabase) throw failure('CONFIGURED_DATABASE_MISMATCH');
    const mysql = require('mysql2/promise');
    let connection, audit, output;
    const write = () => fs.writeFileSync(output, JSON.stringify(audit, null, 2) + '\n');
    try {
        connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL,
            database: config.DATABASEMYSQL, connectTimeout: 8000, multipleStatements: false });
        await connection.query('SET SESSION max_execution_time = 10000');
        await connection.query('SET SESSION information_schema_stats_expiry = 0');
        const before = await preflight(connection);
        if (before.identity.selected_database !== expectedDatabase) throw failure('CONNECTED_DATABASE_MISMATCH');
        const targetFingerprint = digest([config.HOSTMYSQL, config.PORTMYSQL, expectedDatabase, before.identity.server_uuid]);
        delete before.identity.server_uuid;
        if (applying) {
            const inspection = JSON.parse(fs.readFileSync(path.resolve(inspectionPath), 'utf8'));
            if (inspection.mode !== 'inspect' || inspection.status !== 'inspected' || inspection.targetFingerprint !== targetFingerprint || inspection.candidateHash !== digest(candidates)) throw failure('INSPECTION_TARGET_OR_PLAN_MISMATCH');
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const paths = outputPaths(path.resolve(__dirname, '../..'), fs.existsSync(path.join(workspace, 'u575589445_orrico')), argument('--output-dir'));
        const evidence = paths.evidence; fs.mkdirSync(evidence, { recursive: true });
        output = path.join(evidence, stamp + (applying ? '-apply' : '-inspect') + '.json');
        const backup = path.join(paths.backups, 'PO15-' + stamp); fs.mkdirSync(backup, { recursive: true });
        let definitions = '-- PO15 metadata-only schema backup; no data rows.\n';
        for (const table of tableNames) { const [rows] = await connection.query('SHOW CREATE TABLE ' + identifier(table)); definitions += rows[0]['Create Table'] + ';\n\n'; }
        fs.writeFileSync(path.join(backup, 'tables.before.sql'), definitions);
        fs.writeFileSync(path.join(backup, 'indexes.before.json'), JSON.stringify(before.indexes, null, 2) + '\n');
        const plan = makePlan(before.indexes);
        audit = { startedAt: new Date().toISOString(), mode: applying ? 'apply' : 'inspect', status: 'prepared', targetFingerprint,
            candidateHash: digest(candidates), database: expectedDatabase, backup: path.relative(workspace, backup), before, plan, events: [] };
        write();
        audit.explainBefore = await explainReads(connection); write();
        if (applying) {
            await applyPlan(connection, plan, event => { audit.events.push({ at: new Date().toISOString(), ...event }); write(); console.log(JSON.stringify(event)); });
            audit.after = await preflight(connection);
            delete audit.after.identity.server_uuid;
            for (const candidate of candidates) if (!equivalent(candidate, audit.after.indexes)) throw failure('FINAL_INDEX_VERIFICATION_FAILED');
            audit.explainAfter = await explainReads(connection);
            audit.status = 'applied-verified';
            const created = new Set(audit.events.filter(event => event.status === 'applied-verified').map(event => event.name));
            fs.writeFileSync(path.join(evidence, stamp + '-applied.sql'), plan.filter(item => created.has(item.name)).map(item => item.sql + ';').join('\n') + '\n');
            fs.writeFileSync(path.join(backup, 'rollback-indexes.sql'), '-- Manual rollback only; only indexes created in this run.\n' + plan.filter(item => created.has(item.name)).map(item => `-- ALTER TABLE ${identifier(item.table)} DROP INDEX ${identifier(item.name)}, ALGORITHM=INPLACE, LOCK=NONE;`).join('\n') + '\n');
        } else audit.status = 'inspected';
        audit.completedAt = new Date().toISOString(); write();
        console.log(JSON.stringify({ status: audit.status, database: expectedDatabase, candidates: plan.length, create: plan.filter(item => item.action === 'create').length,
            auditFile: output, backup, explainQueries: audit.explainBefore.length }));
    } catch (error) {
        if (audit) { audit.status = 'failed-or-partial'; audit.errorCode = error.code || 'UNKNOWN'; write(); }
        throw error;
    } finally { if (connection) await connection.end(); }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ status: 'failed', errorCode: error.code || 'UNKNOWN' })); process.exitCode = 1; });
module.exports = { equivalent, createSql, makePlan, applyPlan, summarizePlan, outputPaths, explainReads };
