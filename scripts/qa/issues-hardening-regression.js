'use strict';
const assert = require('node:assert/strict');
const express = require('express');
const net = require('node:net');
const fs = require('node:fs');
const { DatabaseError } = require('sequelize');
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub('../../src/config/env', {});
stub('../../src/config/config', { BUCKETS: {} });
stub('../../src/services/aws/s3', {});
let calls = [], role = 'super_admin', failSql = false, rollbacks = 0, commits = 0;
const db = {
    async transaction() { return { async commit() { commits++; this.finished = 'commit'; }, async rollback() { rollbacks++; this.finished = 'rollback'; } }; },
    async query(sql, options = {}) {
        calls.push({ sql, options });
        if (failSql) throw new DatabaseError(new Error('PRIVATE_SQL_COLUMN_AND_VALUE'));
        if (sql.includes('FROM rol')) return [{ id_rol: 'reserved', code: role }];
        if (sql.includes('FROM business')) return [{ id_business: 'tenant' }];
        return [];
    }
};
stub('../../src/db/Sequelize.connection', db);

(async () => {
    await require('./runtime-environment-regression').run();
    const users = require('../../src/Dao/mysql/user.dao');
    const body = { id_business: 'tenant', id_login: 'actor', id_rol: 'reserved', phone: '5550000000', email: 'qa@example.invalid' };
    for (role of ['super_admin', 'unknown-platform-role']) {
        calls = [];
        assert.equal((await users.saveUser(body)).status, 403);
        assert.ok(calls.every(c => !/INSERT|UPDATE/.test(c.sql)), 'Reserved role rejection cannot write users or permissions');
    }
    // Actual controller -> DAO -> error helper, with only SQL replaced.
    const app = express(); app.use(express.json());
    app.post('/users', (req, _res, next) => { req.tokenDecode = { id_login: 'actor', id_business: 'tenant', rol: 'admin' }; next(); }, require('../../src/controller/mysql/user.controller').SaveUser);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
        failSql = true;
        const response = await fetch(`http://127.0.0.1:${server.address().port}/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(response.status, 500);
        assert.doesNotMatch(await response.text(), /PRIVATE_SQL/);
    } finally { failSql = false; await new Promise(resolve => server.close(resolve)); }

    const histories = require('../../src/Dao/mysql/clinicalHistory.dao');
    const templates = require('../../src/Dao/mysql/clinicalHistoryTemplate.dao');
    templates.getCurrentTemplateForBusiness = async () => { throw Error('Synthetic SELECT failure'); };
    await assert.rejects(histories.resolveTemplateSnapshot('tenant'), /SELECT failure/);
    histories.hasPermission = async () => true;
    histories.getPatient = async () => ({ id_person: 'patient' });
    histories.resolveResponsibleDoctor = async () => ({ doctorProfileId: 'profile', doctorUserId: 'actor' });
    histories.nextVersion = async () => 1;
    const allergies = require('../../src/Dao/mysql/patientAllergy.dao');
    allergies.lockPatient = async () => true;
    allergies.getCurrent = async () => null;
    calls = []; const beforeRollback = rollbacks, beforeCommit = commits;
    assert.equal((await histories.createDraft({ id_login: 'actor', id_business: 'tenant', patient_id: 'patient' })).status, 500);
    assert.equal(commits, beforeCommit); assert.equal(rollbacks, beforeRollback + 1);
    assert.ok(calls.every(c => !/INSERT INTO clinical_histories/.test(c.sql)), 'Template SELECT failure cannot create a degraded history');
    templates.getCurrentTemplateForBusiness = async () => null;
    assert.deepEqual(await histories.resolveTemplateSnapshot('tenant'), { templateVersionId: null, templateSnapshotJson: null });
    templates.getCurrentTemplateForBusiness = async () => ({ template: { id_clinical_history_template_version: 'v1', schema_json: { required: ['symptom'] } } });
    assert.match((await histories.resolveTemplateSnapshot('tenant')).templateSnapshotJson, /symptom/);
    histories.hasPermission = async (_actor, permission) => permission === 'clinical_history.view';
    calls = [];
    for (const method of ['getLatestByPatient', 'getById', 'listVersionsByPatient']) assert.equal((await histories[method]({ id_login: 'actor', id_business: 'tenant', patient_id: 'patient' })).status, 403);
    assert.equal(calls.length, 0, 'No clinical data read without sensitive permission');
    const prescriptions = require('../../src/Dao/mysql/prescription.dao');
    prescriptions.hasPermission = async () => false;
    assert.equal((await prescriptions.doctors('tenant', 'actor')).status, 403);
    assert.equal(calls.length, 0, 'Denied directory does not query profiles/signatures');

    let entitlementChecks = 0;
    stub('../../src/util/planFeatures', { async assertPlanFeature() { entitlementChecks++; return { error: { status: 403, data: null, message: 'Synthetic Basic plan denial' } }; } });
    const documents = require('../../src/Dao/mysql/document.dao');
    const metadata = documents.resolveTemplateLicensingMetadata({ template_type: 'CUSTOM', template_subtype: 'custom_premium',
        license_category: 'premium_document_template', block_mode: 'never', clinical_legal_safe: true, minimum_plan: 'basic', is_premium: false });
    assert.notEqual(metadata._block_mode, 'never');
    assert.equal(metadata._clinical_legal_safe, 0);
    assert.equal(metadata._is_premium, 1);
    assert.ok(documents.getTemplateLicensingFeature(metadata), 'Forged licensing metadata still requires entitlement');
    documents.hasPermission = async () => true;
    calls = [];
    assert.equal((await documents.saveTemplate({ id_business: 'tenant', id_login: 'actor', name: 'Synthetic template', content_html: '<p>Synthetic content</p>',
        template_type: 'CUSTOM', template_subtype: 'custom_premium', block_mode: 'never', clinical_legal_safe: true })).status, 403);
    assert.equal(entitlementChecks, 1); assert.equal(calls.length, 0, 'Plan rejection happens before persistence');

    const security = require('../../src/config/security');
    const previous = Object.fromEntries(['APP_ENV','NODE_ENV','ENVIRONMENT','SUPER_ADMIN_SESSION_REAUTH_REQUIRED'].map(k => [k, process.env[k]]));
    try {
        process.env.APP_ENV = 'development'; process.env.NODE_ENV = 'production';
        assert.equal(security.isProductionLike(), true);
        process.env.NODE_ENV = 'development'; process.env.APP_ENV = 'production';
        assert.equal(security.isProductionLike(), true);
        process.env.SUPER_ADMIN_SESSION_REAUTH_REQUIRED = 'true';
        calls = [];
        assert.equal((await require('../../src/Dao/mysql/superAdmin.dao').closeSession('session', {})).status, 403);
        assert.equal(calls.length, 0);
    } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }

    const { createReadiness } = require('../../src/services/readiness');
    let initialized = false, queries = 0, release;
    const readiness = createReadiness({ async sync() { initialized = true; }, query(sql) {
        if (sql.includes('patient_code_counter')) return Promise.resolve([{ next_value: 2 }]);
        if (sql.startsWith('SHOW INDEX')) return Promise.resolve([{ Non_unique: 0, Column_name: 'code', Key_name: 'uq_person_code' }]);
        queries++; return new Promise(resolve => { release = resolve; });
    } }, 15);
    assert.equal(await readiness.check(), false); assert.equal(queries, 0);
    await readiness.initialize(); assert.equal(initialized, true);
    assert.deepEqual(await Promise.all([readiness.check(), readiness.check()]), [false, false]);
    assert.equal(queries, 1); // Timeout must not flood the pool.
    const probe = readiness.check(); release([]); assert.equal(await probe, true);
    const failed = createReadiness({ async sync() { throw Error('offline'); } });
    await assert.rejects(failed.initialize()); assert.equal(await failed.check(), false);
    const missingSchema = createReadiness({ async sync() {}, async query() { return []; } });
    await assert.rejects(missingSchema.initialize(), /MIGRATION_REQUIRED/); assert.equal(await missingSchema.check(), false);

    const { RegistrationRateLimit } = require('../../src/services/registration/registrationRateLimit');
    let cleanups = 0;
    const limiter = new RegistrationRateLimit({ transaction: db.transaction, async query(sql) {
        if (sql.startsWith('DELETE')) { cleanups++; assert.match(sql, /LIMIT 1000/); }
        if (sql.startsWith('SELECT')) return [{ hits: 0, expired: false, retry: 1 }];
        return [];
    } });
    await limiter.consume([]); await limiter.consume([]); assert.equal(cleanups, 1);
    const route = fs.readFileSync(require.resolve('../../src/routes/mysql/registration'), 'utf8');
    const context = route.slice(route.indexOf("router.get('/registration/context'"), route.indexOf('const documents=[];'));
    assert.ok(context.indexOf('await limiter.consume') < context.indexOf('await Passwords.configuredBlocklist'));

    const cookies = require('../../src/config/authCookie.config');
    const attemptSecurity = require('../../src/services/registration/registrationSecurity');
    const passwords = require('../../src/services/security/registrationPassword.service');
    const { RegistrationError } = require('../../src/services/registration/errors');
    const auth = require('../../src/auth/authenticate');
    const savedMethods = [cookies.assertAuthCookieConfig, security.isCsrfEnabled, attemptSecurity.key, passwords.configuredBlocklist, RegistrationRateLimit.prototype.consume, auth.Auth];
    const savedFlags = [process.env.REGISTRATION_ENABLED, process.env.REGISTRATION_IDENTITY_ENABLED];
    let blocklistReads = 0;
    cookies.assertAuthCookieConfig = () => ({ isCookieAuthEnabled: true });
    security.isCsrfEnabled = () => true;
    attemptSecurity.key = () => Buffer.alloc(32);
    passwords.configuredBlocklist = async () => { blocklistReads++; return new Set(['synthetic']); };
    RegistrationRateLimit.prototype.consume = async () => { throw new RegistrationError('REGISTRATION_RATE_LIMITED', 429); };
    process.env.REGISTRATION_ENABLED = process.env.REGISTRATION_IDENTITY_ENABLED = 'true';
    auth.Auth = (req, _res, next) => { req.tokenDecode = { id_login: 'actor', id_business: 'tenant', rol: 'admin' }; next(); };
    const publicApp = express();
    stub('../../src/Dao/mysql/auth.dao', {});
    stub('../../src/controller/mysql/auth.controller', {});
    publicApp.use(require('../../src/routes/mysql/registration').createRouter({ database: db, delivery: { ready: () => true }, optionalAuth: (_req, _res, next) => next() }));
    publicApp.use('/file', require('../../src/routes/mysql/file'));
    const publicServer = publicApp.listen(0, '127.0.0.1'); await new Promise(resolve => publicServer.once('listening', resolve));
    try {
        const base = `http://127.0.0.1:${publicServer.address().port}`;
        assert.equal((await fetch(base + '/registration/context')).status, 429);
        assert.equal(blocklistReads, 0, 'Rate-limited HTTP context never reads or normalizes the password file');
        calls = [];
        assert.equal((await fetch(base + '/file/buckets')).status, 403);
        assert.equal(calls.length, 0, 'Tenant cannot reach global bucket inventory');
    } finally {
        await new Promise(resolve => publicServer.close(resolve));
        [cookies.assertAuthCookieConfig, security.isCsrfEnabled, attemptSecurity.key, passwords.configuredBlocklist, RegistrationRateLimit.prototype.consume, auth.Auth] = savedMethods;
        ['REGISTRATION_ENABLED','REGISTRATION_IDENTITY_ENABLED'].forEach((key, i) => { if (savedFlags[i] === undefined) delete process.env[key]; else process.env[key] = savedFlags[i]; });
    }

    // Real installed Nodemailer against loopback SMTP with no STARTTLS support.
    const smtpCommands = [], sockets = new Set();
    const smtp = net.createServer(socket => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket));
        socket.write('220 synthetic.invalid ESMTP\r\n');
        let buffer = '';
        socket.on('data', bytes => {
            buffer += bytes;
            while (buffer.includes('\n')) {
                const pos = buffer.indexOf('\n'); const line = buffer.slice(0,pos).trim(); buffer = buffer.slice(pos+1);
                smtpCommands.push(line.split(' ')[0]);
                socket.write(/^EHLO/i.test(line) ? '250-synthetic.invalid\r\n250 AUTH LOGIN\r\n' : '500 TLS unavailable\r\n');
            }
        });
    });
    smtp.listen(0, '127.0.0.1'); await new Promise(resolve => smtp.once('listening', resolve));
    try {
        const Provider = require('../../src/services/email/providers/nodemailer.provider');
        const provider = new Provider();
        provider.config = { host: '127.0.0.1', port: smtp.address().port, secure: false, user: 'synthetic-user', password: 'synthetic-password', from: 'qa@example.invalid' };
        await assert.rejects(provider.send({ to: 'qa@example.invalid', subject: 'QA', text: '000000', html: '<p>QA</p>' }));
        assert.ok(smtpCommands.includes('STARTTLS'));
        assert.ok(!smtpCommands.some(command => ['AUTH', 'MAIL', 'DATA'].includes(command)), 'No credentials or code before TLS');
    } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => smtp.close(resolve)); }
    console.log('PASS issues hardening: tenant roles, SQL HTTP sanitization, template failures, sensitive permissions, premium policy, production flags, reauth fail-closed, readiness, retention, SMTP TLS.');
})().catch(error => { console.error(error); process.exitCode = 1; });
