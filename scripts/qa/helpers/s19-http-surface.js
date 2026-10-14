'use strict';

// Called from the live rollback suite. Uses its SINGLE SQL connection and real
// permissions, tenant middleware, routes, validators, controllers and DAOs.
// Authentication/CSRF are injected at the boundary: this is not a login or UI test.
const assert = require('node:assert/strict');
const express = require('express');

module.exports = async function checkHttpSurface(fixture) {
    const { business, patient, doctor, reception, assistant, historyId, prescriptionId, planId } = fixture;
    const actors = {
        doctor: { ...doctor, id_business: business },
        reception: { ...reception, id_business: business },
        ...(assistant ? { assistant: { ...assistant, id_business: business } } : {})
    };
    const mocked = [];
    function inject(path, exports) {
        const id = require.resolve(path);
        mocked.push([id, require.cache[id]]);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    }
    inject('../../../src/auth/authenticate', {
        Auth(req, res, next) {
            const actor = actors[req.get('x-qa-actor')];
            if (!actor) return res.status(401).json({ status: 401 });
            req.tokenDecode = { ...actor };
            next();
        }
    });
    inject('../../../src/middleware/csrf.middleware', { csrfProtection: () => (req, res, next) => next() });
    const app = express();
    app.use(express.json());
    for (const route of ['px', 'clinical-history', 'prescription', 'treatment', 'appointment', 'home', 'business-dashboard']) {
        app.use(`/api/${route}`, require(`../../../src/routes/mysql/${route}`));
    }
    app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
        res.status(500).json({ status: 500, message: error.code || 'QA HTTP failure' });
    });
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    let count = 0;
    async function call(actor, path, expected, method = 'GET', body) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
            method,
            headers: { 'x-qa-actor': actor, 'content-type': 'application/json', connection: 'close' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(15000)
        });
        const result = await response.json();
        assert.equal(response.status, expected, `${actor} ${method} ${path}: ${result.message || response.status}`);
        count += 1;
        return result.data;
    }
    try {
        const administrative = await call('reception', `/px/get/${patient}`, 200);
        assert.deepEqual(Object.keys(administrative).sort(), ['access', 'address', 'person']);
        assert.equal(administrative.access.clinical, false);
        assert.equal(administrative.person.id_person, patient);
        const intake = await call('reception', `/clinical-history/patient/${patient}/intake`, 200);
        assert.equal(intake.editable, false);
        assert.equal(intake.history.status, 'FINALIZED');
        assert.ok(!Object.hasOwn(intake.history, 'clinical_snapshot_json'));
        assert.ok(Object.values(intake.consultation).every(value => value === ''), 'Finalized consultation not exposed to reception');
        await call('reception', `/clinical-history/${historyId}`, 403);
        await call('reception', `/clinical-history/patient/${patient}`, 403);
        // Forged actor/business fields must never grant the doctor's authority.
        const forged = { id_login: doctor.id_login, id_business: business, rol: doctor.rol };
        await call('reception', `/clinical-history/${historyId}/finalize`, 403, 'POST', forged);
        // Prescription DAOs retain their legacy 401 denial contract.
        await call('reception', `/prescription/${prescriptionId}`, 401);
        await call('reception', '/prescription/issue', 401, 'POST', { ...forged, id_prescription: prescriptionId });
        await call('reception', `/treatment/plan/${patient}`, 403);
        await call('reception', '/treatment/plan/close', 403, 'POST', { ...forged, id_person: patient, id_treatment_plan: planId });
        await call('reception', '/appointment/save', 403, 'POST', { ...forged, appointment: { patientId: patient } });
        await call('reception', `/appointment/patient/${patient}/history`, 200);
        await call('reception', '/home/appointments?date=2026-10-14', 403);
        const home = await call('reception', '/home/continuity-summary', 200);
        assert.deepEqual(home.families, { administrative: false, clinical: false, financial: false });
        for (const section of Object.values(home.sections)) {
            assert.equal(section.available, false, 'Unavailable Home family must not expose patient details');
            assert.equal((section.items || []).length, 0);
            assert.equal((section.cards || []).length, 0);
        }
        await call('reception', '/business-dashboard/summary', 403);
        await call('reception', '/home/continuity-summary?scope=own', 403);
        const chart = await call('doctor', `/clinical-history/${historyId}`, 200);
        assert.equal(chart.history.status, 'FINALIZED');
        const prescription = await call('doctor', `/prescription/${prescriptionId}`, 200);
        assert.equal(prescription.status, 'cancelled');
        await call('doctor', '/prescription/output', 400, 'POST', { id_prescription: prescriptionId, action: 'pdf_generated' });
        const plan = await call('doctor', `/treatment/plan/${patient}`, 200);
        assert.equal(plan.activePlan, null);
        assert.ok(plan.history.some(item => item.id_treatment_plan === planId && item.status === 'closed'));
        await call('doctor', '/business-dashboard/summary?id_business=QA_FORBIDDEN_TENANT', 400);
        if (assistant) {
            await call('assistant', `/clinical-history/${historyId}`, 200);
            await call('assistant', `/clinical-history/${historyId}/finalize`, 403, 'POST', forged);
            await call('assistant', '/prescription/issue', 401, 'POST', { ...forged, id_prescription: prescriptionId });
            const readPlan = await call('assistant', `/treatment/plan/${patient}`, 200);
            assert.equal(readPlan.permissions.costView, false);
            for (const historical of readPlan.history) {
                for (const item of historical.treatments || []) assert.equal(Object.hasOwn(item, 'cost'), false);
            }
            await call('assistant', '/appointment/save', 403, 'POST', { appointment: { patientId: patient } });
        }
        return `${count} HTTP requests: reception projection/denials, forged actor rejected, closed records, agenda permission separation, Home/Dashboard privacy${assistant ? ', assistant read without finalize/issue/cost/booking' : ''}; authenticated principal and CSRF simulated`;
    } finally {
        await new Promise(resolve => server.close(resolve));
        for (const [id, previous] of mocked.reverse()) {
            if (previous) require.cache[id] = previous;
            else delete require.cache[id];
        }
    }
};
