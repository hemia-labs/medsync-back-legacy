const assert = require('node:assert/strict');
const connectionPath = require.resolve('../../src/db/Sequelize.connection');
let status, audits, updates, reads, hasPermission, issuer, issuedBy, lockHeld = false, queue = [];
const calls = [];
const db = {
    async transaction() {
        let release = null;
        return {
            setRelease(value) { release = value; },
            async commit() { if (release) release(); },
            async rollback() { if (release) release(); }
        };
    },
    async query(sql, options) {
        calls.push(sql);
        assert.equal(options.replacements._id_business, 'qa-tenant');
        assert.equal(options.replacements._id_prescription, 'qa-rx');
        assert.ok(options.transaction);
        if (/FOR UPDATE/.test(sql)) {
            if (lockHeld) await new Promise(resolve => queue.push(resolve));
            lockHeld = true;
            options.transaction.setRelease(() => { lockHeld = false; const next = queue.shift(); if (next) next(); });
            return [{ id_prescription: 'qa-rx' }];
        }
        assert.match(sql, /UPDATE prescription/);
        updates++; status = 'issued'; issuedBy = 'qa-doctor';
        return [1];
    }
};
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: db };
const dao = require('../../src/Dao/mysql/prescription.dao');
dao.getPatientIdentity = async () => ({ patient_name: 'QA', patient_birthday: '2000-01-01', patient_age: 26 });
dao.hasPermission = async () => hasPermission;
dao.getPrescription = async () => { reads++; return { status, issuer_doctor_id: issuer, issued_by: issuedBy }; };
dao.getBusiness = async () => ({ active: 1, status: 'active' });
dao.getItems = async () => [{ generic_name: 'QA', dose: 'QA', administration_route: 'QA', frequency: 'QA', duration: 'QA' }];
dao.getRawConfig = async () => ({ clinic_name: 'QA', clinic_address: 'QA', clinic_phone: 'QA' });
dao.getDoctor = async id => ({ id_login: id, professional_name: 'QA', professional_license: 'QA', signature_image: 'QA', is_active: 1, can_issue_prescriptions: 1 });
dao.validateDoctorProfileForIssue = () => ({ isValid: true });
dao.validateConfigForIssue = () => ({ isValid: true });
dao.audit = async () => { audits++; };
dao.getById = async () => ({ status: 200, data: { id_prescription: 'qa-rx', status } });
const body = { id_login: 'qa-doctor', id_business: 'qa-tenant', id_prescription: 'qa-rx' };
const reset = (value = 'draft') => { status = value; audits = 0; updates = 0; reads = 0; hasPermission = true; issuer = 'qa-doctor'; issuedBy = value === 'issued' ? 'qa-doctor' : null; calls.length = 0; };
(async () => {
    reset();
    const result = await Promise.all([dao.issue(body), dao.issue(body)]);
    assert.ok(result.every(value => value.status === 200));
    assert.equal(updates, 1, 'Concurrent attempts must only issue once');
    assert.equal(audits, 1, 'Idempotent retry must not repeat the clinical audit');
    assert.equal(reads, 2);
    reset('issued');
    assert.equal((await dao.issue(body)).status, 200);
    assert.equal(updates, 0);
    reset('issued'); issuer = 'another-doctor';
    assert.notEqual((await dao.issue(body)).status, 200, 'Another issuer must not claim the idempotent result');
    reset('cancelled');
    assert.notEqual((await dao.issue(body)).status, 200);
    reset(); hasPermission = false;
    assert.notEqual((await dao.issue(body)).status, 200);
    assert.equal(calls.length, 0, 'Permission failure must not access or lock clinical data');
    console.log('PASS prescription issue: serialized attempts, one audit/update, own-actor retry, cancelled state and permission denial. Mocked transactions; no database writes.');
})().catch(error => { console.error(error); process.exitCode = 1; });
