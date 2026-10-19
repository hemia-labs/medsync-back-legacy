'use strict';
const assert = require('node:assert/strict');
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
let queries = [], plan = 'enterprise', doctor = null, metric = 5, failRetention = false, sessionActive = true;
const full = ['dashboard.tenant', 'dashboard.operations', 'dashboard.clinical', 'dashboard.financial', 'dashboard.scope.all'];
let granted = [...full];
stub('../../src/config/config', {});
stub('../../src/db/Sequelize.connection', { async query(sql, options = {}) {
    queries.push({ sql, options });
    await new Promise(resolve => setImmediate(resolve));
    if (sql.includes('INNER JOIN `session`')) return sessionActive ? [{ id_login: 'actor-a', id_business: 'tenant-a', id_rol: 'role', rol: 'admin', id_session: 'session-a' }] : [];
    if (sql.includes('trial_starts_at') && sql.includes('FROM business')) return [{ id_business: 'tenant-a', active: 1, status: 'active', subscription_status: 'active' }];
    if (sql.includes('INNER JOIN cat_permission cp')) return granted.map(code => ({ code, is_active: 1 }));
    if (sql.includes('FROM login l LEFT JOIN doctor_professional_profile')) return [{ id_login: options.replacements.login,
        id_doctor_professional_profile: doctor, professional_name: doctor ? 'Synthetic Doctor' : null }];
    if (sql.includes('SELECT id_business, name, plan, subscription_status, active, status')) return [{ id_business: options.replacements._id_business,
        name: 'Synthetic', plan, active: 1, subscription_status: 'active' }];
    if (sql.includes('AS firstVisitPatients')) {
        if (failRetention) throw new Error('Synthetic retention failure');
        return [{ firstVisitPatients: 2, retainedPatients: 1 }];
    }
    if (sql.includes('AS dueFollowUps')) return [{ dueFollowUps: 3, scheduledFollowUps: 1 }];
    if (sql.includes('AS patientsWithEstimatedTreatment')) return [{ patientsWithEstimatedTreatment: 2, totalEstimatedTreatmentValue: 123 }];
    if (sql.includes('AS actorKey')) return [{ actorKey: 'profile:synthetic', professionalName: 'Synthetic Doctor', prescriptionsIssued: metric }];
    if (sql.includes('AS period')) return [{ period: '2026-10', total: metric }];
    if (sql.includes('AS status')) return [{ status: sql.includes('FROM clinical_histories') ? 'FINALIZED' : (sql.includes('FROM prescription') ? 'issued' : 'completed'), total: metric }];
    if (sql.includes('COUNT(*) AS total')) return [{ total: metric }];
    return [];
} });
const controller = require('../../src/controller/mysql/businessDashboard.controller');
const range = { from: '2026-10-01', to: '2026-10-19' };
async function invoke(method, query = {}, tenant = 'tenant-a', actor = 'actor-a') {
    const res = { status(code) { this.code = code; return this; }, send(body) { this.body = body; } };
    await controller[method]({ query: { ...range, ...query }, tokenDecode: { id_business: tenant, id_login: actor },
        method: 'GET', originalUrl: '/api/business/dashboard/' + method }, res);
    return res.body;
}
const normalize = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'asOf' ? undefined : item));
const clinicalRead = () => queries.some(q => /FROM (prescription|clinical_histories|patient_documents|tracing|patient_treatment)\b/.test(q.sql));
async function checkHttp() {
    const express = require('express');
    const secret = 'synthetic-po13-key-for-local-tests-only';
    stub('../../src/config/jwt', { key: secret, expiresIn: { expiresIn: '10m' } });
    stub('../../src/config/authCookie.config', { getAuthCookieConfig: () => ({ isCookieAuthEnabled: false }) });
    stub('../../src/services/security/securityLogger.service', { record() {} });
    const Token = require('../../src/auth/authenticate');
    const token = Token.GetAccessToken({ id_login: 'actor-a', id_business: 'tenant-a', id_session: 'session-a' }).token;
    const app = express();
    app.use('/api/business/dashboard', require('../../src/routes/mysql/business-dashboard'));
    app.use((error, req, res, next) => res.status(500).json({ message: error.message }));
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    let checks = 0;
    try {
        const url = `http://127.0.0.1:${server.address().port}/api/business/dashboard/overview?from=2026-10-01&to=2026-10-19`;
        async function request(credential = token, extra = '') {
            const response = await fetch(url + extra, { headers: credential ? { Authorization: 'Bearer ' + credential } : {} });
            checks++; return { status: response.status, body: await response.json() };
        }
        assert.equal((await request(null)).status, 401);
        const allowed = await request();
        assert.equal(allowed.status, 200);
        assert.equal(allowed.body.data.summary.business.id_business, 'tenant-a');
        assert.equal((await request(token, '&id_business=foreign')).status, 400);
        assert.equal((await request(token, '&granularity=invalid')).status, 400);
        sessionActive = false; queries = [];
        assert.equal((await request()).status, 401);
        assert.equal(clinicalRead(), false, 'Revoked session stops before metric queries');
        sessionActive = true; granted = [];
        assert.equal((await request()).status, 403);
        return checks;
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
(async () => {
    queries = [];
    const baseline = {};
    for (const method of ['summary', 'trends', 'operationalSummary', 'professionalBreakdown', 'teamBreakdown']) baseline[method] = await invoke(method);
    const before = queries.length;
    queries = [];
    let result = await invoke('overview');
    const after = queries.length;
    assert.equal(result.status, 200, result.message);
    assert.deepEqual(normalize(result.data.summary), normalize(baseline.summary.data));
    for (const [key, method] of [['trends', 'trends'], ['operational', 'operationalSummary'],
        ['professionalBreakdown', 'professionalBreakdown'], ['teamBreakdown', 'teamBreakdown']]) {
        assert.deepEqual(normalize(result.data.widgets[key]), normalize(baseline[method]), key + ' retains its contract');
    }
    assert.equal(before, 56, 'Legacy controllers include one extra navigation query per endpoint');
    assert.equal(after, 28);
    assert.equal(queries.filter(q => q.sql.includes('SELECT id_business, name, plan, subscription_status, active, status')).length, 1);
    assert.equal(queries.filter(q => q.sql.includes('FROM login l LEFT JOIN doctor_professional_profile')).length, 1);
    assert.equal(queries.filter(q => q.sql.includes('INNER JOIN cat_permission cp')).length, 2, 'Navigation and family catalog semantics remain separate');
    failRetention = true;
    result = await invoke('overview');
    assert.equal(result.status, 200);
    assert.equal(result.data.widgets.operational.status, 500);
    assert.equal(result.data.widgets.trends.status, 200);
    assert.equal(result.data.widgets.teamBreakdown.status, 200, 'A failed widget does not discard unrelated results');
    failRetention = false;
    plan = 'basic'; queries = [];
    result = await invoke('overview');
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.data.widgets), [], 'Locked plan widgets do not run');
    assert.ok(!queries.some(q => q.sql.includes('AS firstVisitPatients') || q.sql.includes('AS actorKey')));
    plan = 'enterprise'; granted = ['dashboard.operations']; queries = [];
    result = await invoke('overview');
    assert.equal(result.status, 200);
    assert.equal(clinicalRead(), false, 'Reception never queries denied clinical/financial tables');
    assert.deepEqual(Object.keys(result.data.widgets).sort(), ['operational', 'trends']);
    granted = ['dashboard.clinical', 'dashboard.operations']; doctor = 'synthetic-profile'; queries = [];
    result = await invoke('overview');
    assert.equal(result.data.summary.access.scope.mode, 'own');
    assert.equal(result.data.summary.activity.patientsCreated, null);
    assert.ok(queries.filter(q => /FROM (prescription|clinical_histories|appointment)\b/.test(q.sql))
        .every(q => q.sql.includes(':_doctor_profile') && q.options.replacements._doctor_profile === doctor));
    assert.equal(result.data.widgets.teamBreakdown, undefined);
    assert.equal((await invoke('overview', { scope: 'tenant' })).status, 403);
    doctor = null; granted = ['dashboard.financial', 'dashboard.scope.all']; queries = [];
    result = await invoke('overview');
    assert.deepEqual(Object.keys(result.data.widgets), ['operational']);
    assert.ok(!queries.some(q => /FROM (person|prescription|clinical_histories|appointment|tracing)\b/.test(q.sql)));
    granted = [...full]; queries = [];
    const concurrent = await Promise.all(Array.from({ length: 5 }, (_, index) => invoke('overview', {}, 'tenant-' + index, 'actor-' + index)));
    assert.ok(concurrent.every(response => response.status === 200));
    assert.deepEqual(concurrent.map(response => response.data.summary.business.id_business), ['tenant-0', 'tenant-1', 'tenant-2', 'tenant-3', 'tenant-4']);
    assert.equal(queries.filter(q => q.sql.includes('SELECT id_business, name, plan, subscription_status, active, status')).length, 5, 'Each request has its own live license read');
    metric = 11;
    result = await invoke('overview');
    assert.equal(result.data.summary.activity.patientsCreated, 11, 'Next request sees changed metrics');
    granted = []; queries = [];
    assert.equal((await invoke('overview')).status, 403);
    assert.equal(clinicalRead(), false, 'Revocation applies on the next request');
    granted = [...full]; queries = [];
    assert.equal((await invoke('overview', { id_business: 'foreign' })).status, 400);
    assert.equal(queries.length, 0);
    assert.equal((await invoke('overview', { granularity: 'invalid' })).status, 400);
    const httpChecks = process.argv.includes('--http') ? await checkHttp() : 0;
    console.log(JSON.stringify({ result: 'PASS', legacyControllerSql: before, overviewControllerSql: after,
        expectedIncludingAuthAndTenant: { before: before + 10, after: after + 2 },
        concurrentTenants: 5, httpChecks, contractsAuthorizationRevocationPartialFailures: 'PASS' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
