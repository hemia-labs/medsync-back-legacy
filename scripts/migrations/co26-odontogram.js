'use strict';
// Additive, resumable schema install. Importing this module never connects to DB.
const { createHash } = require('node:crypto');
const permissions = [
    ['capture', 'Capturar odontograma'], ['finalize', 'Finalizar odontograma'],
    ['reopen', 'Reabrir odontograma'], ['delete', 'Eliminar odontograma']
];
const ddl = [
    ['odontogram_v2_chart', `id_business VARCHAR(50) NOT NULL, id_chart VARCHAR(50) NOT NULL,
        id_person VARCHAR(50) NOT NULL, dentition VARCHAR(16) NOT NULL, revision INT UNSIGNED NOT NULL,
        generation INT UNSIGNED NOT NULL, status VARCHAR(16) NOT NULL, snapshot_json LONGTEXT NOT NULL,
        created_by VARCHAR(50) NOT NULL, created_at DATETIME(3) NOT NULL, updated_by VARCHAR(50) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        active_person VARCHAR(50) GENERATED ALWAYS AS (IF(status='active',id_person,NULL)) STORED,
        PRIMARY KEY(id_business,id_chart), UNIQUE KEY co26_one_active(id_business,active_person), KEY co26_patient(id_business,id_person,status)`],
    ['odontogram_v2_revision', `id_business VARCHAR(50) NOT NULL, id_chart VARCHAR(50) NOT NULL,
        revision INT UNSIGNED NOT NULL, snapshot_json LONGTEXT NOT NULL, actor VARCHAR(50) NOT NULL,
        created_at DATETIME(3) NOT NULL, PRIMARY KEY(id_business,id_chart,revision),
        FOREIGN KEY(id_business,id_chart) REFERENCES odontogram_v2_chart(id_business,id_chart)`],
    ['odontogram_v2_batch', `id_business VARCHAR(50) NOT NULL, batch_id VARCHAR(50) NOT NULL,
        id_chart VARCHAR(50) NOT NULL, actor VARCHAR(50) NOT NULL, request_hash CHAR(64) NOT NULL,
        result_json LONGTEXT NOT NULL, created_at DATETIME(3) NOT NULL,
        PRIMARY KEY(id_business,batch_id),
        FOREIGN KEY(id_business,id_chart) REFERENCES odontogram_v2_chart(id_business,id_chart)`],
    ['odontogram_v2_operation', `id_business VARCHAR(50) NOT NULL, client_op_id VARCHAR(50) NOT NULL,
        id_chart VARCHAR(50) NOT NULL, batch_id VARCHAR(50) NOT NULL, revision INT UNSIGNED NOT NULL,
        actor VARCHAR(50) NOT NULL, event_json LONGTEXT NOT NULL, created_at DATETIME(3) NOT NULL,
        PRIMARY KEY(id_business,client_op_id), KEY co26_events(id_business,id_chart,revision),
        FOREIGN KEY(id_business,id_chart) REFERENCES odontogram_v2_chart(id_business,id_chart),
        FOREIGN KEY(id_business,batch_id) REFERENCES odontogram_v2_batch(id_business,batch_id)`],
    ['odontogram_v2_finding', `id_business VARCHAR(50) NOT NULL, id_chart VARCHAR(50) NOT NULL,
        finding_id VARCHAR(80) NOT NULL, tooth SMALLINT UNSIGNED NOT NULL, status VARCHAR(16) NOT NULL,
        finding_json LONGTEXT NOT NULL, PRIMARY KEY(id_business,id_chart,finding_id),
        FOREIGN KEY(id_business,id_chart) REFERENCES odontogram_v2_chart(id_business,id_chart)`],
    ['odontogram_v2_tooth', `id_business VARCHAR(50) NOT NULL, id_chart VARCHAR(50) NOT NULL,
        tooth SMALLINT UNSIGNED NOT NULL, revision INT UNSIGNED NOT NULL, review_revision INT UNSIGNED NULL,
        note VARCHAR(1000) NOT NULL, PRIMARY KEY(id_business,id_chart,tooth),
        FOREIGN KEY(id_business,id_chart) REFERENCES odontogram_v2_chart(id_business,id_chart)`],
    ['odontogram_plan_dental_revision', `id_business VARCHAR(50) NOT NULL, id_treatment VARCHAR(50) NOT NULL,
        revision INT UNSIGNED NOT NULL, form_revision INT UNSIGNED NOT NULL DEFAULT 0, create_request_hash CHAR(64) NULL,
        PRIMARY KEY(id_business,id_treatment)`],
    ['odontogram_plan_dental_detail', `id_business VARCHAR(50) NOT NULL, id_treatment VARCHAR(50) NOT NULL,
        tooth_number VARCHAR(3) NOT NULL, surfaces VARCHAR(5) NULL, manual TINYINT UNSIGNED NOT NULL,
        PRIMARY KEY(id_business,id_treatment,tooth_number),
        FOREIGN KEY(id_business,id_treatment) REFERENCES odontogram_plan_dental_revision(id_business,id_treatment)`],
    ['odontogram_plan_dental_source', `id_business VARCHAR(50) NOT NULL, id_treatment VARCHAR(50) NOT NULL,
        tooth_number VARCHAR(3) NOT NULL, source_key CHAR(64) NOT NULL, id_chart VARCHAR(50) NOT NULL,
        finding_id VARCHAR(80) NULL, source_revision INT UNSIGNED NOT NULL, context_json LONGTEXT NOT NULL,
        PRIMARY KEY(id_business,id_treatment,tooth_number,source_key),
        FOREIGN KEY(id_business,id_treatment,tooth_number) REFERENCES odontogram_plan_dental_detail(id_business,id_treatment,tooth_number)`],
    ['odontogram_plan_dental_event', `id_event VARCHAR(36) NOT NULL PRIMARY KEY, id_business VARCHAR(50) NOT NULL,
        id_treatment VARCHAR(50) NOT NULL, revision INT UNSIGNED NOT NULL, event_kind VARCHAR(30) NOT NULL, actor VARCHAR(50) NOT NULL,
        before_json LONGTEXT NOT NULL, after_json LONGTEXT NOT NULL, created_at DATETIME(3) NOT NULL,
        FOREIGN KEY(id_business,id_treatment) REFERENCES odontogram_plan_dental_revision(id_business,id_treatment)`],
    ['odontogram_alias', `scope_key VARCHAR(64) NOT NULL, scope_kind VARCHAR(10) NOT NULL, id_business VARCHAR(50) NULL,
        alias VARCHAR(30) NOT NULL, target VARCHAR(30) NOT NULL, version INT UNSIGNED NOT NULL, active TINYINT UNSIGNED NOT NULL,
        updated_by VARCHAR(50) NOT NULL, updated_at DATETIME(3) NOT NULL, PRIMARY KEY(scope_key,alias)`],
    ['odontogram_alias_event', `id_event VARCHAR(36) NOT NULL PRIMARY KEY, scope_key VARCHAR(64) NOT NULL,
        alias VARCHAR(30) NOT NULL, version INT UNSIGNED NOT NULL, actor VARCHAR(50) NOT NULL,
        before_json LONGTEXT NOT NULL, after_json LONGTEXT NOT NULL, created_at DATETIME(3) NOT NULL,
        FOREIGN KEY(scope_key,alias) REFERENCES odontogram_alias(scope_key,alias)`],
    ['odontogram_preference', `id_business VARCHAR(50) NOT NULL PRIMARY KEY, revision INT UNSIGNED NOT NULL,
        traversal_json LONGTEXT NOT NULL, updated_by VARCHAR(50) NOT NULL, updated_at DATETIME(3) NOT NULL`],
    ['odontogram_preference_event', `id_event VARCHAR(36) NOT NULL PRIMARY KEY, id_business VARCHAR(50) NOT NULL,
        revision INT UNSIGNED NOT NULL, actor VARCHAR(50) NOT NULL, before_json LONGTEXT NOT NULL, after_json LONGTEXT NOT NULL,
        created_at DATETIME(3) NOT NULL, FOREIGN KEY(id_business) REFERENCES odontogram_preference(id_business)`],
    ['odontogram_plan_dental_manual', `id_business VARCHAR(50) NOT NULL, id_treatment VARCHAR(50) NOT NULL,
        tooth_number VARCHAR(3) NOT NULL, surfaces VARCHAR(5) NULL,
        PRIMARY KEY(id_business,id_treatment,tooth_number),
        FOREIGN KEY(id_business,id_treatment,tooth_number) REFERENCES odontogram_plan_dental_detail(id_business,id_treatment,tooth_number)`],
    ['odontogram_v2_migration', `step VARCHAR(80) NOT NULL PRIMARY KEY, checksum CHAR(64) NOT NULL,
        installed_at DATETIME(3) NOT NULL`]
];
function definitions(fields) {
    let depth = 0, part = '', result = [];
    for (const char of fields) {
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (char === ',' && depth === 0) { result.push(part.trim()); part = ''; } else part += char;
    }
    if (part.trim()) result.push(part.trim());
    return result;
}
const normalizeType = type => type.toLowerCase().replace(/\b(int|smallint)\(\d+\)/g, '$1');
async function migrate(db, backup) {
    const installPlan={created_tables:[],mode_added:false};
    await backup('install-plan.json',installPlan);
    const [engine] = await db.query('SELECT VERSION() AS version, DATABASE() AS db');
    const [teeth] = await db.query('SELECT id_tooth,sec FROM cat_tooth');
    if (teeth.length !== 52 || new Set(teeth.map(tooth => Number(tooth.sec))).size !== 52 || teeth.some(tooth => !/^(?:[1-4][1-8]|[5-8][1-5])$/.test(String(tooth.sec)))) throw Error('CO26 requires the existing 52 distinct FDI teeth; no IDs will be generated or renumbered.');
    const [legacy] = await db.query('SHOW CREATE TABLE clinical_module_config');
    await backup('clinical_module_config-before.json', legacy);
    const [columns] = await db.query('SHOW COLUMNS FROM clinical_module_config');
    const column = columns.find(c => c.Field === 'odontogram_mode');
    if (column && (!String(column.Type).startsWith('varchar(16)') || column.Default !== 'v1')) throw Error('Incompatible odontogram_mode; manual review required.');
    if (!column) { installPlan.mode_added=true;await backup('install-plan.json',installPlan);await db.query("ALTER TABLE clinical_module_config ADD COLUMN odontogram_mode VARCHAR(16) NOT NULL DEFAULT 'v1'"); }
    for (const [table, fields] of ddl) {
        const sql = `CREATE TABLE IF NOT EXISTS ${table} (${fields}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
        const [existing] = await db.query('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table]);
        if(!existing.length){installPlan.created_tables.push(table);await backup('install-plan.json',installPlan);}
        if (existing.length && (String(existing[0].ENGINE).toLowerCase() !== 'innodb' || existing[0].TABLE_COLLATION !== 'utf8mb4_unicode_ci')) throw Error('Incompatible engine/collation: ' + table);
        if (existing.length) {
            const [definition] = await db.query('SHOW CREATE TABLE ' + table);
            await backup(table + '-before.json', definition);
        }
        await db.query(sql);
        const [actual] = await db.query('SHOW COLUMNS FROM ' + table);
        const specs = definitions(fields);
        for (const spec of specs.filter(field => !/^(PRIMARY|KEY|UNIQUE|FOREIGN)\b/.test(field))) {
            const match = spec.match(/^(\w+)\s+((?:(?:VAR)?CHAR\(\d+\)|DATETIME\(\d+\)|LONGTEXT|SMALLINT|TINYINT|INT)(?:\s+UNSIGNED)?)/);
            const column = match && actual.find(c => c.Field === match[1]);
            if (!column || normalizeType(column.Type) !== normalizeType(match[2]) || /NOT NULL/.test(spec) && column.Null !== 'NO') throw Error('Incompatible column in ' + table + ': ' + spec.split(/\s/)[0]);
        }
        const [indexes] = await db.query('SHOW INDEX FROM ' + table);
        for (const spec of specs.filter(field => /^(PRIMARY|UNIQUE)\b/.test(field))) {
            const expected = spec.match(/\(([^)]+)\)/)[1].split(',').map(value => value.trim());
            const name = spec.startsWith('PRIMARY') ? 'PRIMARY' : spec.match(/^UNIQUE KEY (\w+)/)[1];
            const actualKey = indexes.filter(index => index.Key_name === name && !Number(index.Non_unique)).sort((a,b) => a.Seq_in_index-b.Seq_in_index).map(index => index.Column_name);
            if (expected.join(',') !== actualKey.join(',')) throw Error('Incompatible unique key: ' + table + '.' + name);
        }
        const expectedFks = specs.filter(field => field.startsWith('FOREIGN KEY'));
        if (expectedFks.length) {
            const [keys] = await db.query('SELECT CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME,ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL', [table]);
            const grouped = new Map();
            for (const key of keys) { if (!grouped.has(key.CONSTRAINT_NAME)) grouped.set(key.CONSTRAINT_NAME, []); grouped.get(key.CONSTRAINT_NAME).push(key); }
            for (const expected of expectedFks) {
                const match = expected.match(/^FOREIGN KEY\(([^)]+)\) REFERENCES (\w+)\(([^)]+)\)/);
                const found = [...grouped.values()].some(group => {
                    const ordered = group.sort((a,b) => a.ORDINAL_POSITION-b.ORDINAL_POSITION);
                    return ordered.every(key => key.REFERENCED_TABLE_NAME === match[2]) && ordered.map(key => key.COLUMN_NAME).join(',') === match[1] && ordered.map(key => key.REFERENCED_COLUMN_NAME).join(',') === match[3];
                });
                if (!found) throw Error('Incompatible foreign key: ' + table);
            }
        }
    }
    await db.beginTransaction();
    try {
        const changes = [];
        for (const [action, name] of permissions) {
            const code = 'odontogram.' + action;
            const [rows] = await db.query('SELECT * FROM cat_permission WHERE code=?', [code]);
            if (rows.length) continue;
            const id = 'PERM-CO26-' + action.toUpperCase();
            await db.query(`INSERT INTO cat_permission(id_cat_permission,code,name,description,sec,value,active,is_active,created_at)
                VALUES(?,?,?,?,?,'Odontograma',1,1,NOW())`, [id, code, name, name + ' con trazabilidad.', 140 + changes.length]);
            changes.push({ id, code, before: null });
        }
        await backup('permission-delta.json', changes);
        const permissionSnapshots=[];
        for(const change of changes){const [rows]=await db.query('SELECT * FROM cat_permission WHERE code=?',[change.code]);permissionSnapshots.push(rows[0]);}
        await backup('permission-created.json',permissionSnapshots);
        for (const [table, fields] of ddl) {
            const checksum = createHash('sha256').update(fields).digest('hex');
            const [previous] = await db.query('SELECT checksum FROM odontogram_v2_migration WHERE step=?', [table]);
            if (previous.length && previous[0].checksum !== checksum) throw Error('Migration checksum mismatch: ' + table);
            await db.query('INSERT IGNORE INTO odontogram_v2_migration(step,checksum,installed_at) VALUES(?,?,NOW(3))', [table, checksum]);
        }
        await db.commit();
    } catch (error) { await db.rollback(); throw error; }
    await backup('manifest.json', { engine, tables: ddl.map(([table]) => table), mode: 'v1', grantsApplied: false });
}
module.exports = { migrate, ddl, permissions, definitions };
if (require.main === module) (async () => {
    if (!process.argv.includes('--apply') || !process.argv.includes('--qa') && !process.argv.includes('--configured')) throw Error('Use --apply --qa, or --apply --configured for an explicitly authorized configured database.');
    const config = require('../../src/config/config');
    if (!process.argv.includes('--configured') && !/(?:^qa_|_qa(?:_|$)|test)/i.test(config.DATABASEMYSQL || '')) throw Error('Refusing a database without a QA/test name.');
    const fs = require('node:fs/promises'), path = require('node:path');
    const target = path.resolve(__dirname, '../../../_schema_backups/CO26-' + new Date().toISOString().replace(/[:.]/g, '-'));
    await fs.mkdir(target, { recursive: true });
    const db = await require('mysql2/promise').createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    try { await migrate(db, (name, data) => fs.writeFile(path.join(target, name), JSON.stringify(data, null, 2))); console.log('CO26 schema installed, v1 remains default. No permission grants.'); }
    finally { await db.end(); }
})().catch(error => { console.error('CO26 migration:', error.code || error.message); process.exitCode = 1; });
