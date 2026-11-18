'use strict';
// Run against a disposable local MySQL database named clinical_qa.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Sequelize } = require('sequelize');

async function run() {
    const port = Number(process.env.CLINICAL_QA_MYSQL_PORT);
    assert.ok(Number.isInteger(port) && port > 0, 'Set the port of the disposable MySQL container');
    const db = new Sequelize('clinical_qa', 'root', '', { host: '127.0.0.1', port, dialect: 'mysql', logging: false, pool: { max: 2 } });
    const moduleId = require.resolve('../../src/db/Sequelize.connection');
    require.cache[moduleId] = { id: moduleId, loaded: true, exports: db };
    const { save } = require('../../src/services/clinicalModuleChanges.service');
    const clinic = randomUUID(), other = randomUUID(), actor = 'synthetic';
    const change = (changes, expected, tenant = clinic) => save(tenant, actor, { changes, expected });
    try {
        await db.query('CREATE TABLE IF NOT EXISTS clinical_module_config (' +
            'id_clinical_module_config VARCHAR(80) PRIMARY KEY, id_business VARCHAR(50) NOT NULL UNIQUE, ' +
            'odontogram_enabled TINYINT NOT NULL DEFAULT 0, treatment_plan_enabled TINYINT NOT NULL DEFAULT 1, ' +
            'allow_treatment_tooth_selection TINYINT NOT NULL DEFAULT 0, show_treatment_costs TINYINT NOT NULL DEFAULT 1, ' +
            'show_treatment_status TINYINT NOT NULL DEFAULT 1, created_by VARCHAR(50), updated_by VARCHAR(50), updated_at DATETIME) ENGINE=InnoDB');
        await Promise.all([
            change({ showTreatmentCosts: false }, { showTreatmentCosts: true }),
            change({ showTreatmentStatus: false }, { showTreatmentStatus: true })
        ]);
        const merged = await change({ odontogramEnabled: true }, { odontogramEnabled: false });
        assert.equal(merged.showTreatmentCosts, false);
        assert.equal(merged.showTreatmentStatus, false);
        await assert.rejects(change({ showTreatmentStatus: false, showTreatmentCosts: true }, { showTreatmentStatus: true, showTreatmentCosts: false }),
            e => e.status === 409 && e.current.showTreatmentCosts === false);
        await change({ allowTreatmentToothSelection: true }, { allowTreatmentToothSelection: false, odontogramEnabled: true });
        await assert.rejects(change({ odontogramEnabled: false }, { odontogramEnabled: true, allowTreatmentToothSelection: false }), e => e.status === 409);
        const off = await change({ odontogramEnabled: false }, { odontogramEnabled: true, allowTreatmentToothSelection: true });
        assert.equal(off.allowTreatmentToothSelection, false);
        assert.equal(off.showTreatmentCosts, false);
        await assert.rejects(change({ allowTreatmentToothSelection: true }, { allowTreatmentToothSelection: false, odontogramEnabled: false }), e => e.status === 422);
        const independent = await change({ showTreatmentStatus: false }, { showTreatmentStatus: true }, other);
        assert.equal(independent.showTreatmentCosts, true);
        console.log('PASS MySQL: concurrent initial insert, disjoint edits, atomic conflict, dental dependency, tenant scope.');
    } finally { await db.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
