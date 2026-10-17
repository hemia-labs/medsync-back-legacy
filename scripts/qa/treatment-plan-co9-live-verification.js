const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');

(async () => {
    const connection = await mysql.createConnection({ host: config.HOSTMYSQL, port: config.PORTMYSQL, user: config.USERMYSQL, password: config.PASSWORDMYSQL, database: config.DATABASEMYSQL });
    try {
        const tenant = 'QA_BUSINESS_CLINICAL', patient = 'QAC_PATIENT_20';
        const [plans] = await connection.execute('SELECT id_treatment_plan, status, title FROM treatment_plan WHERE id_business=? AND id_person=? AND title=? ORDER BY created_at DESC LIMIT 1', [tenant, patient, 'PRUEBA UX CO9 - FIRMA MULTICANAL - NO USAR']);
        assert.equal(plans.length, 1); const plan = plans[0]; assert.equal(plan.status, 'closed');
        const [items] = await connection.execute('SELECT status, cost FROM patient_treatment WHERE id_business=? AND id_treatment_plan=? AND active=1', [tenant, plan.id_treatment_plan]);
        assert.equal(items.length, 1); assert.equal(items[0].status, 'pending'); assert.equal(Number(items[0].cost), 0);
        const [documents] = await connection.execute('SELECT pd.id_patient_document, pd.status FROM treatment_plan_consent_document link INNER JOIN patient_documents pd ON pd.id_patient_document=link.id_patient_document WHERE link.id_business=? AND link.id_person=? AND link.id_treatment_plan=?', [tenant, patient, plan.id_treatment_plan]);
        assert.equal(documents.length, 1, 'Repeated preparation reuses one pending copy'); assert.equal(documents[0].status, 'CANCELADO', 'Closing the plan cancels its pending copy');
        const totals = {};
        for (const table of ['patient_document_signatures', 'document_signature_requests']) {
            const [rows] = await connection.execute(`SELECT COUNT(*) AS total FROM ${table} WHERE id_business=? AND id_patient_document=?`, [tenant, documents[0].id_patient_document]);
            totals[table] = rows[0].total; assert.equal(rows[0].total, 0, 'No real signatures or remote requests were generated');
        }
        for (const table of ['treatment_plan_consent', 'treatment_plan_consent_version']) {
            const [rows] = await connection.execute(`SELECT COUNT(*) AS total FROM ${table} WHERE id_business=? AND id_person=?`, [tenant, patient]);
            totals[table] = rows[0].total; assert.equal(rows[0].total, 0);
        }
        const [original] = await connection.execute('SELECT tp.status, COUNT(pt.id_patient_treatment) AS total, SUM(pt.cost) AS cost FROM treatment_plan tp INNER JOIN patient_treatment pt ON pt.id_treatment_plan=tp.id_treatment_plan AND pt.active=1 WHERE tp.id_business=? AND tp.id_treatment_plan=? GROUP BY tp.status', [tenant, 'QAC_TPLAN_01']);
        assert.equal(original[0].status, 'active'); assert.equal(original[0].total, 2); assert.equal(Number(original[0].cost), 5400);
        const evidence = path.resolve(__dirname, '../../../docs/clinical-operations/phases/evidence/co9-treatment-signature-channels');
        await fs.mkdir(evidence, { recursive: true });
        await fs.writeFile(path.join(evidence, 'live-verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(), fixture: { ...plan, items, documentCount: documents.length, documentStatus: documents[0].status, ...totals }, original: original[0], connectionCount: 1, readOnlyQueries: true }, null, 2));
        console.log('PASS CO9 live QA: one reused prepared copy; closed fixture invalidates it; no signatures, requests or deliveries; original plan unchanged. One DB connection, read-only checks.');
    } finally { await connection.end(); }
})().catch(error => { console.error('CO9 live verification failed:', error.code || error.message); process.exitCode = 1; });
