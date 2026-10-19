'use strict';
const assert = require('node:assert/strict');
const { equivalent, createSql, makePlan, applyPlan, summarizePlan, outputPaths, explainReads } = require('../ops/po15-apply-indexes');
const path = require('node:path');
const candidates = require('../ops/po14-index-candidates.json');
function rows(candidate, overrides = {}) {
    return candidate.columns.map((column, index) => ({ TABLE_NAME: candidate.table, INDEX_NAME: candidate.name,
        SEQ_IN_INDEX: index + 1, COLUMN_NAME: column.split(' ')[0], COLLATION: column.endsWith(' DESC') ? 'D' : 'A',
        SUB_PART: null, IS_VISIBLE: 'YES', ...overrides }));
}
(async () => {
    assert.equal(makePlan([]).filter(item => item.action === 'create').length, 8);
    for (const candidate of candidates) {
        const metadata = rows(candidate);
        assert.equal(equivalent(candidate, metadata), candidate.name);
        assert.equal(equivalent(candidate, rows(candidate, { INDEX_NAME: 'existing_equivalent' })), 'existing_equivalent');
        assert.equal(equivalent(candidate, rows(candidate, { SUB_PART: 20 })), null, 'Prefix indexes cannot replace full keys');
        assert.equal(equivalent(candidate, rows(candidate, { IS_VISIBLE: 'NO' })), null);
        assert.equal(equivalent(candidate, rows(candidate, { COLUMN_NAME: 'different_column' })), null);
        assert.match(createSql(candidate), /^ALTER TABLE `[a-z_]+` ADD INDEX `idx_po14_[a-z_]+` \(.+\), ALGORITHM=INPLACE, LOCK=NONE$/);
        assert.equal(makePlan(metadata).find(item => item.name === candidate.name).action, 'skip-covered');
    }
    assert.equal(equivalent(candidates[1], rows(candidates[1], { COLLATION: 'A' })), candidates[1].name, 'Uniform reverse scan is equivalent');
    assert.throws(() => makePlan(rows(candidates[0], { COLUMN_NAME: 'wrong' })), /INDEX_NAME_CONFLICT/);
    assert.throws(() => createSql({ table: 'person;DROP TABLE x', name: 'bad', columns: ['id_person'] }), /INVALID_IDENTIFIER/);
    assert.throws(() => createSql({ table: 'person', name: 'bad', columns: ['id_person INVALID'] }), /INVALID_DIRECTION/);
    let metadata = [], queries = [], active = 0, peak = 0, failName;
    const events = [], plan = makePlan([]);
    const connection = { async query(sql) {
        queries.push(sql); active++; peak = Math.max(peak, active);
        try {
            await new Promise(resolve => setImmediate(resolve));
            if (sql.startsWith('SELECT TABLE_NAME')) return [metadata];
            if (sql.startsWith('ALTER')) {
                const candidate = candidates.find(item => sql.includes('`' + item.name + '`'));
                if (candidate.name === failName) { const error = Error('blocked'); error.code = 'ER_LOCK_WAIT_TIMEOUT'; throw error; }
                metadata.push(...rows(candidate));
            }
            return [[]];
        } finally { active--; }
    } };
    await applyPlan(connection, plan, event => events.push(event));
    assert.equal(peak, 1, 'One connection, sequential queries/DDL');
    assert.equal(events.filter(event => event.status === 'applied-verified').length, 8);
    queries = []; events.length = 0;
    await applyPlan(connection, plan, event => events.push(event));
    assert.equal(queries.filter(sql => sql.startsWith('ALTER')).length, 0, 'Rerun never recreates covered indexes');
    metadata = []; queries = []; events.length = 0; failName = candidates[1].name;
    await assert.rejects(applyPlan(connection, plan, event => events.push(event)), { code: 'ER_LOCK_WAIT_TIMEOUT' });
    assert.equal(queries.filter(sql => sql.startsWith('ALTER')).length, 2, 'Failure stops without trying later indexes');
    assert.ok(queries.every(sql => !/ALGORITHM=COPY|DROP INDEX|LOCK=EXCLUSIVE|INSERT |DELETE |UPDATE /i.test(sql)));
    const summary = summarizePlan({ query_block: { cost_info: { query_cost: '10' }, table: { table_name: 'person', key: 'idx_example',
        attached_condition: 'sensitive opaque ID', rows_examined_per_scan: 4 }, nested: { query_block: { cost_info: { query_cost: '2' } } } } });
    assert.equal(summary.queryCost, '10'); assert.doesNotMatch(JSON.stringify(summary), /sensitive|attached_condition/);
    const repoRoot = path.resolve(__dirname, '../..');
    assert.equal(outputPaths(repoRoot, false).evidence, path.join(repoRoot, '.local/po15/evidence'));
    assert.equal(outputPaths(repoRoot, true).backups, path.join(path.dirname(repoRoot), '_schema_backups'));
    assert.equal(outputPaths(repoRoot, false, path.join(repoRoot, 'tmp/output')).backups, path.join(repoRoot, 'tmp/output/backups'));
    let explains = 0;
    const portable = await explainReads({ async query(sql) {
        if (sql.startsWith('SELECT id_business')) return [[{ id_business: 'private-scope', id_person: 'private-patient', id_treatment_plan: 'private-plan' }]];
        assert.ok(sql.startsWith('EXPLAIN FORMAT=JSON SELECT'));
        explains++;
        return [[{ EXPLAIN: JSON.stringify({ query_block: { table: { table_name: 'fixture', access_type: 'ref', attached_condition: 'private-scope' } } }) }]];
    } });
    assert.equal(explains, 8); assert.equal(portable.length, 8);
    assert.doesNotMatch(JSON.stringify(portable), /private-scope|private-patient|private-plan/);
    console.log('PASS PO15 index application: eight fixed DDL statements, duplicate/prefix/visibility/direction guards, idempotent sequential application, verify after create, stop on lock failure, no destructive fallback and EXPLAIN redaction. No DB.');
})().catch(error => { console.error(error); process.exitCode = 1; });
