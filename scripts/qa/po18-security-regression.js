'use strict';
// Real HTTP routes/permissions/controllers/DAO, synthetic identity and SQL only.
const assert = require('node:assert/strict');
const express = require('express');
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub('../../src/config/env', {});
stub('../../src/config/config', { BUCKETS: {} });
stub('../../src/services/aws/s3', {});
process.env.REQUIRE_ACTIVE_SESSION = 'false';
Object.assign(process.env, { AUTH_LOGIN_IP_LIMIT: '20', AUTH_LOGIN_PHONE_FAILED_LIMIT: '5', AUTH_RATE_LIMIT_WINDOW_MS: '900000', AUTH_LOCKOUT_MS: '900000', AUTH_RATE_LIMIT_MAX_KEYS: '20000' });
let allowed = new Set(), catalogEnabled = true;
const dataQueries = [];
stub('../../src/db/Sequelize.connection', {
    async query(sql, options = {}) {
        const permission = options.replacements?._permission;
        if (permission) return allowed.has(permission) && (!sql.includes('cp.is_active = 1') || catalogEnabled) ? [{ granted: 1 }] : [];
        dataQueries.push(sql);
        if (sql.includes('FROM person p')) {
            assert.equal(options.replacements.business || options.replacements._id_business, 'synthetic-tenant');
            const patient = options.replacements.patient || options.replacements._id_person;
            if (patient !== '11111111-1111-4111-8111-111111111111') return [];
            const record = { person: { id_person: patient }, address: {} };
            if (sql.includes('current_condition')) record.query = { current_condition: 'SYNTHETIC_PRIVATE_CONDITION' };
            return [record];
        }
        if (sql.includes('FROM pathological_personal')) return [{ id_pathological_personal: 'synthetic', json: { detail: 'SYNTHETIC_PRIVATE_HISTORY' } }];
        if (sql.includes('FROM allergy')) return [];
        throw new Error('Unexpected SQL in isolated test');
    }
});
stub('../../src/auth/authenticate', { Auth: (r, s, next) => {
    if (r.headers['x-synthetic-anonymous']) return s.sendStatus(401);
    r.tokenDecode = { id_login: 'synthetic-user', id_session: 'synthetic-session', id_business: 'synthetic-tenant', rol: 'doctor' }; next();
} });
stub('../../src/middleware/requireTenantOperational.middleware', (_r, _s, next) => next());

async function clinicalAccess() {
    const app = express();
    app.use('/api/px', require('../../src/routes/mysql/px'));
    app.use('/api/clinical-history', require('../../src/routes/mysql/clinical-history'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const id = '11111111-1111-4111-8111-111111111111';
    try {
        for (const permissions of [[], ['clinical_history.view'], ['clinical_history.view_sensitive'], ['clinical_history.view','clinical_history.view_sensitive']]) {
            allowed = new Set(['px.all', ...permissions]); dataQueries.length = 0;
            const response = await fetch(`${base}/api/px/get/${id}`);
            const json = await response.json();
            assert.equal(response.status, 200);
            if (permissions.length === 2) {
                assert.equal(json.data.query.current_condition, 'SYNTHETIC_PRIVATE_CONDITION');
                assert.equal(json.data.pathological_data[0].detail, 'SYNTHETIC_PRIVATE_HISTORY');
                assert.equal(json.data.access.clinical, true);
            } else {
                assert.equal(json.data.access.clinical, false);
                for (const field of ['query','pathological_data','allergy','social_media']) assert.equal(json.data[field], undefined);
                assert.ok(dataQueries.every(sql => !/current_condition|FROM pathological_personal|FROM allergy/.test(sql)));
                assert.equal((await fetch(`${base}/api/clinical-history/patient/${id}`)).status, 403);
            }
        }
        catalogEnabled = false;
        const disabled = await (await fetch(`${base}/api/px/get/${id}`)).json();
        assert.equal(disabled.data.access.clinical, false, 'Disabled catalog cannot expose clinical data');
        catalogEnabled = true;
        const foreign = await (await fetch(`${base}/api/px/get/22222222-2222-4222-8222-222222222222`)).json();
        assert.doesNotMatch(JSON.stringify(foreign), /SYNTHETIC_PRIVATE/);
        allowed = new Set(); dataQueries.length = 0;
        assert.equal((await fetch(`${base}/api/px/get/${id}`)).status, 403);
        assert.equal((await fetch(`${base}/api/px/get/${id}`, {headers:{'x-synthetic-anonymous':'1'}})).status, 401);
        assert.equal(dataQueries.length, 0);
    } finally { await new Promise(resolve => server.close(resolve)); }
}

function authLimits() {
    const validate = require('../../src/middleware/authPayloadValidation.middleware').validateAuthPayload;
    const rate = require('../../src/middleware/authRateLimit.middleware');
    const payloads = {
        login: phone => ({param:phone,pwd:'Synthetic123'}),
        sendOtp: phone => ({phone}), validateOtp: phone => ({phone,code:'123456'}),
        resetPassword: phone => ({phone,otp:'123456',password:'SyntheticPassword123'})
    };
    let tick = 1000000;
    const realNow = Date.now;
    Date.now = () => tick;
    const attempt = (phone, {type='login',failure=false,success=false,ip='127.0.0.1'}={}) => {
        const r = {body:payloads[type](phone),ip};
        const s = {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.statusCode=code;return this;},send(){}};
        let passed = false, failureResult;
        validate(type)(r,s,()=>rate(type)(r,s,()=>{passed=true;}));
        if (passed && failure) failureResult = r.authRateLimit.recordFailure();
        if (passed && success) r.authRateLimit.recordSuccess();
        return {passed,status:s.statusCode,headers:s.headers,key:r.authRateLimit?.identityKey,body:r.body,failureResult};
    };
    try {
        process.env.REGISTRATION_IDENTITY_ENABLED = 'true';
        for (const [type,limit] of [['login',6],['sendOtp',3],['validateOtp',5],['resetPassword',5]]) {
            rate._private.buckets.clear();
            for(let i=0;i<limit;i++) assert.ok(attempt('5550000000',{type,failure:type==='login'}).passed);
            for (const alias of ['5550000000','525550000000','+52 (555) 000-0000']) {
                assert.equal(attempt(alias,{type,ip:'127.0.0.2'}).status,429, `${type} alias must share quota`);
            }
        }
        rate._private.buckets.clear();
        attempt('5550000000',{failure:true});
        attempt('+525550000000',{success:true});
        assert.equal(rate._private.buckets.has('auth:login:identity:5550000000'),false);
        for (const type of Object.keys(payloads)) {
            rate._private.buckets.clear();
            const result = attempt('+525550000000',{type});
            assert.ok(result.passed);
            assert.equal(result.body.param || result.body.phone || result.body.telephone, '525550000000', 'Recovery payload/hash input remains unchanged');
        }
        process.env.REGISTRATION_IDENTITY_ENABLED = 'false';
        rate._private.buckets.clear();
        for(let i=0;i<6;i++) attempt('5550000000',{failure:true});
        assert.equal(attempt('5550000000').status,429);
        assert.ok(attempt('+525550000000').passed, 'Legacy lookup treats these as distinct identities');

        for (const lockMs of [900000,1800000]) {
            process.env.AUTH_LOCKOUT_MS = String(lockMs);
            rate._private.buckets.clear(); tick=1000000;
            attempt('5550000000',{failure:true}); tick+=899000;
            for(let i=0;i<5;i++) attempt('5550000000',{failure:true});
            const expiry=tick+lockMs;
            assert.equal(attempt('5550000000').status,429);
            tick+=1001;
            const blocked=attempt('5550000000');
            assert.equal(blocked.status,429);
            assert.equal(Number(blocked.headers['Retry-After']),Math.ceil((expiry-tick)/1000));
            tick=expiry-1; assert.equal(attempt('5550000000').status,429);
            tick=expiry; assert.ok(attempt('5550000000').passed, 'Denied attempts do not extend the lock');
        }
        // The IP quota uses the same bucket retention and must keep its lock too.
        rate._private.buckets.clear(); tick=1000000;
        process.env.AUTH_LOCKOUT_MS='900000';
        attempt('5550000000'); tick+=899000;
        for(let i=0;i<19;i++) attempt('5550000000');
        assert.equal(attempt('5550000000').status,429);
        tick+=1001; assert.equal(attempt('5550000001').status,429);
        tick=2799000; assert.ok(attempt('5550000001').passed);
    } finally { Date.now=realNow;rate._private.buckets.clear(); }
}

(async()=>{
    await clinicalAccess(); authLimits();
    console.log('PASS PO18: clinical permissions/projection, catalog/tenant/anonymous controls, S24 aliases and legacy compatibility, recovery payload preservation, successful-login cleanup, identity/IP lock expiry. No live DB/cloud.');
})().catch(error=>{console.error(error);process.exitCode=1;});
