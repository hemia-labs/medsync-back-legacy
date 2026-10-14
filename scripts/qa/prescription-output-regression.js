const assert = require('node:assert/strict');
const connectionPath = require.resolve('../../src/db/Sequelize.connection');
let state, calls, commits, rollbacks, audits;
const db = {
    async transaction() {
        calls.push('transaction');
        return { async commit() { commits++; }, async rollback() { rollbacks++; } };
    },
    async query(sql, options) {
        assert.match(sql, /FROM prescription.*FOR UPDATE/s);
        assert.match(sql, /id_business/);
        assert.equal(options.replacements._id_business, 'qa-tenant');
        assert.equal(options.replacements._id_prescription, 'qa-rx');
        assert.ok(options.transaction);
        calls.push('lock');
        if(state.cancelBeforeLock) state.status = 'cancelled';
        return state.missing ? [] : [{ id_prescription: 'qa-rx' }];
    }
};
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: db };
const dao = require('../../src/Dao/mysql/prescription.dao');
dao.hasPermission = async (_id, permission) => state.permissions.includes(permission);
dao.getViewAccess = async () => state.access;
dao.getPrescription = async (_id, tenant, tx) => { calls.push('read'); assert.ok(tx); assert.equal(tenant, 'qa-tenant'); return state.missing ? null : { id_prescription: 'qa-rx', status: state.status, issuer_doctor_id: state.owner, created_by: 'qa-creator', doctor_name_snapshot: 'Frozen QA doctor', signature_snapshot: 'Frozen QA signature', cancellation_reason: 'QA cancellation', cancelled_at: '2026-10-13T12:00:00Z' }; };
dao.getItems = async (_id, _tenant, tx) => { assert.ok(tx); calls.push('items'); return [{ generic_name: 'Fictitious procedure data' }]; };
dao.getRawConfig = async (_tenant, tx) => { assert.ok(tx); calls.push('config'); return { clinic_name: 'QA clinic' }; };
dao.audit = async (entry, tx) => { assert.ok(tx); if(state.failAudit) throw new Error('Simulated audit failure'); assert.equal(entry.previous_status, 'issued'); audits++; };
const body = { id_business: 'qa-tenant', id_prescription: 'qa-rx', id_login: 'qa-doctor', action: 'printed', status: 'issued' };
const reset = (status='issued') => { state = { status, owner: 'qa-doctor', access: { canViewOwn: true, canViewAll: false }, permissions: ['prescriptions.print', 'prescriptions.download'] }; calls=[]; commits=rollbacks=audits=0; };
(async () => {
    for(const status of ['draft', 'cancelled', 'unknown', null]) {
        reset(status); const r=await dao.prepareOutput(body);
        assert.equal(r.status, 400); assert.equal(r.data.status, status); assert.equal(r.data.prescription, undefined);
        assert.equal(audits, 0); assert.equal(commits, 0); assert.equal(rollbacks, 1);
        assert.equal(calls.includes('items'), false); assert.equal(calls.includes('config'), false);
    }
    for(const action of ['printed', 'downloaded', 'pdf_generated']) {
        reset(); const r=await dao.prepareOutput({ ...body, action });
        assert.equal(r.status, 200); assert.equal(r.data.prescription.status, 'issued');
        assert.equal(r.data.prescription.doctor_name_snapshot, 'Frozen QA doctor');
        assert.equal(r.data.prescription.signature_snapshot, 'Frozen QA signature');
        assert.equal(r.data.prescription.items.length, 1); assert.equal(r.data.config.clinic_name, 'QA clinic');
        assert.equal(commits, 1); assert.equal(audits, 1); assert.ok(calls.indexOf('lock') < calls.indexOf('read'));
    }
    reset(); state.cancelBeforeLock=true;
    assert.equal((await dao.prepareOutput(body)).status, 400, 'A cached issued status cannot bypass a cancellation before authorization'); assert.equal(audits, 0);
    reset(); state.permissions=['prescriptions.print'];
    assert.equal((await dao.prepareOutput({ ...body, action:'downloaded' })).status, 403); assert.equal(calls.length, 0);
    reset(); state.permissions=[];
    assert.equal((await dao.prepareOutput(body)).status, 403); assert.equal(calls.length, 0);
    reset(); state.access={ canViewOwn:false, canViewAll:false };
    assert.equal((await dao.prepareOutput(body)).status, 403); assert.equal(calls.length, 0);
    reset(); state.owner='qa-other-doctor';
    assert.equal((await dao.prepareOutput(body)).status, 403); assert.equal(audits, 0);
    reset(); state.missing=true;
    assert.equal((await dao.prepareOutput(body)).status, 404); assert.equal(audits, 0);
    reset(); state.failAudit=true;
    const failed=await dao.prepareOutput(body); assert.equal(failed.status, 500); assert.equal(failed.data, null); assert.equal(rollbacks, 1); assert.equal(commits, 0);
    reset('cancelled'); assert.equal((await dao.auditAction(body)).status, 400, 'Old audit endpoint also rejects non-issued copies');
    reset(); const legacy=await dao.auditAction(body); assert.equal(legacy.status, 200); assert.deepEqual(legacy.data, { id_prescription:'qa-rx', action:'printed' });
    reset(); assert.equal((await dao.prepareOutput({ ...body, action:'unknown' })).status, 400); assert.equal(calls.length, 0);
    console.log('PASS prescription output: issued only, stale cancellation, scoped permissions/ownership, transactional authorization/audit, rollback, frozen data and old endpoint protection. Mock DB; no real prints or clinical writes.');
})().catch(error => { console.error(error); process.exitCode=1; });
