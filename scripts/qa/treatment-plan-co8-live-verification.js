const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');

(async () => {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    try {
        const tenant = 'QA_BUSINESS_CLINICAL';
        const [plans] = await connection.execute(`SELECT id_treatment_plan, status, title, diagnosis FROM treatment_plan WHERE id_business=? AND id_person=? AND title=? ORDER BY created_at DESC LIMIT 1`, [tenant, 'QAC_PATIENT_20', 'PRUEBA UX CO8 - NO USAR EN ATENCIÓN']);
        assert.equal(plans.length, 1); const plan = plans[0]; assert.equal(plan.status, 'closed');
        assert.equal(plan.diagnosis, 'PRUEBA CO8 - contexto general ficticio.');
        const [items] = await connection.execute(`SELECT id_patient_treatment, status, cost, CAST(estimated_start_date AS CHAR) AS start_date, CAST(estimated_end_date AS CHAR) AS end_date FROM patient_treatment WHERE id_business=? AND id_treatment_plan=? AND active=1`, [tenant, plan.id_treatment_plan]);
        assert.equal(items.length, 1); assert.equal(items[0].status, 'paused'); assert.equal(Number(items[0].cost), 0);
        assert.equal(items[0].start_date, '2026-10-13'); assert.equal(items[0].end_date, '2026-10-14');
        const [audit] = await connection.execute('SELECT COUNT(*) AS total FROM treatment_plan_audit WHERE id_business=? AND id_treatment_plan=?', [tenant, plan.id_treatment_plan]);
        assert.ok(audit[0].total >= 1);
        const [consents] = await connection.execute('SELECT COUNT(*) AS total FROM treatment_plan_consent WHERE id_business=? AND id_person=?', [tenant, 'QAC_PATIENT_20']);
        const [versions] = await connection.execute('SELECT COUNT(*) AS total FROM treatment_plan_consent_version WHERE id_business=? AND id_person=?', [tenant, 'QAC_PATIENT_20']);
        assert.equal(consents[0].total, 0); assert.equal(versions[0].total, 0);
        const [original] = await connection.execute(`SELECT tp.status, COUNT(pt.id_patient_treatment) AS total, SUM(pt.cost) AS cost FROM treatment_plan tp INNER JOIN patient_treatment pt ON pt.id_treatment_plan=tp.id_treatment_plan AND pt.active=1 WHERE tp.id_business=? AND tp.id_treatment_plan=? GROUP BY tp.status`, [tenant, 'QAC_TPLAN_01']);
        assert.equal(original[0].status, 'active'); assert.equal(original[0].total, 2); assert.equal(Number(original[0].cost), 5400);
        const workspace = path.resolve(__dirname, '../../..');
        const evidence = path.join(workspace, 'docs/clinical-operations/phases/evidence/co8-treatment-continuity');
        await fs.mkdir(evidence, { recursive: true });
        const result = { checkedAt: new Date().toISOString(), fixture: { ...plan, treatments: items, metadataAuditCount: audit[0].total, consentCount: consents[0].total, consentVersionCount: versions[0].total }, original: original[0], connectionCount: 1, readOnlyQueries: true };
        await fs.writeFile(path.join(evidence, 'live-verification.json'), JSON.stringify(result, null, 2));
        const backup = path.join(workspace, '_schema_backups', `co8-docs-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        for (const table of ['treatment_plan_consent_version', 'treatment_plan_audit']) {
            const [ddl] = await connection.query(`SHOW CREATE TABLE \`${table}\``);
            const target = path.join(workspace, 'u575589445_orrico/Tables', `${table}.sql`);
            try { await fs.access(target); await fs.mkdir(backup, { recursive: true }); await fs.copyFile(target, path.join(backup, `${table}.sql`)); } catch(error) { if(error.code !== 'ENOENT') throw error; }
            await fs.writeFile(target, `${ddl[0]['Create Table']};\n`);
        }
        console.log('PASS live QA: closed fixture, paused state/zero cost/dates retained, metadata audit, no saved signatures, original active plan unchanged. Two new schema definitions saved; no Data export.');
    } finally { await connection.end(); }
})().catch(error => { console.error('CO8 verification failed:', error.code || error.message); process.exitCode = 1; });
