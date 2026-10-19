'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render, candidates } = require('../ops/po14-index-plan');
const root = path.resolve(__dirname, '../../..');
const names = new Set();
for (const candidate of candidates) {
    assert.ok(!names.has(candidate.name)); names.add(candidate.name);
    assert.match(candidate.table, /^[a-z_]+$/); assert.match(candidate.name, /^idx_po14_[a-z_]+$/);
    const schema = fs.readFileSync(path.join(root, 'u575589445_orrico/Tables', candidate.table + '.sql'), 'utf8');
    for (const column of candidate.columns) {
        assert.match(column, /^[a-z_]+(?: DESC)?$/);
        assert.ok(schema.includes('`' + column.split(' ')[0] + '`'), `Snapshot column exists: ${candidate.table}.${column}`);
    }
    assert.ok(!schema.includes('`' + candidate.name + '`'), 'Candidate has not been recorded as applied');
}
const sql = render();
assert.ok(sql.split('\n').every(line => !line.trim() || line.startsWith('--')), 'All proposed DDL and rollback remain comments');
assert.equal((sql.match(/ADD INDEX/g) || []).length, 8);
assert.equal((sql.match(/DROP INDEX/g) || []).length, 8);
const readonly = fs.readFileSync(path.join(__dirname, '../ops/po14-readonly-mysql.sql'), 'utf8').replace(/^--.*$/gm, '');
assert.doesNotMatch(readonly, /\b(ALTER|DROP|CREATE|INSERT|UPDATE|DELETE|TRUNCATE|SQL_TEXT|DIGEST_TEXT)\b/i);
assert.doesNotMatch(readonly, /EXPLAIN\s+ANALYZE|ANALYZE\s+TABLE/i);
assert.equal((readonly.match(/EXPLAIN FORMAT=JSON/g) || []).length, 3);
if (process.argv.includes('--record')) {
    const dir = path.join(root, 'docs/platform-operations/evidence/PO14'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index-candidates.sql'), sql);
    fs.writeFileSync(path.join(dir, 'index-review-results.json'), JSON.stringify({ result: 'PASS', candidates: 8,
        snapshotColumnsVerified: true, allDdlCommented: true, readOnlyInspectionChecked: true, mysqlExecuted: false, explainExecuted: false }, null, 2) + '\n');
    const templates = JSON.parse(fs.readFileSync(path.join(dir, 'query-templates.json'), 'utf8'));
    const parameters = { _limit: '10', _offset: '0', limit: '5', offset: '0',
        _id_business: '@po14_business', business: '@po14_business', _business: '@po14_business',
        _id_person: '@po14_patient', patient: '@po14_patient',
        _from: "'2026-10-01 00:00:00'", _to: "'2026-10-19 23:59:59'", _created: "'2026-10-19 12:00:00'",
        _date_from: "'2026-10-01'", _date_to: "'2026-10-19'", _status: "'draft'", _search: "'%sintetico%'",
        _event_type: "'SIGNATURE_REQUIREMENTS_SNAPSHOT'" };
    const explains = templates.filter(item => !/FROM `session`|INNER JOIN `session`|FROM business/.test(item.sql))
        .map(item => 'EXPLAIN FORMAT=JSON ' + item.sql.replace(/:(\w+)/g, (_match, key) => parameters[key] || "'__PO14_QA_ID__'") + ';');
    const fullSql = '-- Full DAO read templates captured by offline QA. MANUAL QA ONLY; never executed here.\n'
        + '-- Parameters are synthetic. Use representative synthetic fixtures and both scopes; empty tables cannot validate an index.\n'
        + '-- Compare exact query/filters/collations with and without ONE candidate. EXPLAIN is a plan estimate, not a benchmark.\n'
        + "SET @po14_business = '__PO14_QA_TENANT__';\nSET @po14_patient = '__PO14_QA_PATIENT__';\n\n" + explains.join('\n\n') + '\n';
    assert.doesNotMatch(fullSql, /:[A-Za-z_]\w*|EXPLAIN\s+ANALYZE/);
    assert.ok(explains.length > 10);
    fs.writeFileSync(path.join(dir, 'full-query-explains.sql'), fullSql);
}
console.log('PASS PO14 index review: 8 candidates reference snapshot columns, generated DDL/rollback commented, inspection uses no row data or schema/data writes. No MySQL/EXPLAIN executed.');
