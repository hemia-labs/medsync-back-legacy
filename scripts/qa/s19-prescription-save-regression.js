'use strict';
// Real prescription DAO with a simulated REPEATABLE READ snapshot. A competing
// issuer commits after the editor's earlier reads; FOR UPDATE must see its state.
const assert = require('node:assert/strict');
const path = require.resolve('../../src/db/Sequelize.connection');
let current, stale, writes, audits, failAudit, interleaveIssue;
const db = {
    async transaction() {
        const before = structuredClone(current);
        return { async commit() {}, async rollback() { if (failAudit) current = before; } };
    },
    async query(sql, options = {}) {
        if (/SELECT p\.\*/.test(sql)) {
            assert.ok(options.transaction, 'Mutation read belongs to its transaction');
            assert.doesNotMatch(sql,/FOR UPDATE/,'Presentation joins do not lock patients or doctors');
            return [structuredClone(stale)];
        }
        if (/SELECT \* FROM prescription/.test(sql)) {
            assert.match(sql,/FOR UPDATE/,'Canonical prescription state is a current locking read');
            assert.ok(options.transaction);
            return [structuredClone(current)];
        }
        if (/SELECT id_prescription/.test(sql)) return [{ id_prescription: 'qa-rx' }];
        if (/UPDATE prescription/.test(sql)) {
            writes++;
            if (/active = 0/.test(sql) && current.status === 'draft') current.active = 0;
            return [current.status === 'draft' ? 1 : 0];
        }
        if (/DELETE FROM prescription_item|INSERT INTO prescription_item/.test(sql)) { writes++; return []; }
        throw new Error(`Unexpected SQL: ${sql}`);
    }
};
require.cache[path] = { id: path, filename: path, loaded: true, exports: db };
const dao = require('../../src/Dao/mysql/prescription.dao');
dao.hasPermission = async () => true;
dao.getViewAccess = async () => ({ canViewAll: true, canViewOwn: true });
dao.getPatient = async () => ({ id_person: 'qa-patient' });
dao.getDoctor = async () => { if (interleaveIssue) current.status = 'issued'; return { id_login: 'qa-doctor' }; };
dao.audit = async () => { if (failAudit) throw new Error('QA audit unavailable'); audits++; };
dao.getById = async () => ({ status: 200, data: current });
const context = { id_business: 'qa-business', id_login: 'qa-doctor', id_prescription: 'qa-rx' };
const reset = () => {
    current = { id_prescription: 'qa-rx', id_person: 'qa-patient', issuer_doctor_id: 'qa-doctor', created_by: 'qa-doctor', active: 1, status: 'draft' };
    stale = structuredClone(current); writes = 0; audits = 0; failAudit = false; interleaveIssue = false;
};
(async () => {
    reset(); interleaveIssue = true;
    const edited = await dao.save({ ...context, prescription: { id_prescription: 'qa-rx', id_person: 'qa-patient', issuer_doctor_id: 'qa-doctor', items: [{ generic_name: 'Should not replace issued item' }] } });
    assert.equal(edited.status,400); assert.equal(writes,0); assert.equal(audits,0);
    reset(); current.status='issued';
    assert.equal((await dao.deleteDraft(context)).status,400); assert.equal(writes,0); assert.equal(audits,0);
    reset(); current.status='cancelled'; stale.status='issued';
    assert.equal((await dao.prepareOutput({...context,action:'pdf_generated'})).status,400); assert.equal(writes,0); assert.equal(audits,0);
    assert.equal((await dao.cancel({...context,reason:'Stale cancellation'})).status,400); assert.equal(writes,0); assert.equal(audits,0);
    reset(); current.status='issued'; current.doctor_name_snapshot='Issued immutable doctor'; stale.doctor_name='Older presentation';
    const locked = await dao.getPrescription('qa-rx','qa-business',await db.transaction(),true);
    assert.equal(locked.status,'issued'); assert.equal(locked.doctor_name,'Issued immutable doctor');
    reset(); failAudit=true;
    assert.equal((await dao.deleteDraft(context)).status,500); assert.equal(current.active,1,'Deletion rolls back if its audit fails');
    reset();
    assert.equal((await dao.deleteDraft(context)).status,200); assert.equal(current.active,0); assert.equal(audits,1);
    console.log('PASS S19 prescription mutation: live row lock/current read defeats stale snapshot after interleaved issue; no item writes to issued, no delete of issued, cancelled output/repeated cancellation refused, transactional delete/audit rollback. Real DAO, simulated SQL; no database.');
})().catch(error=>{console.error(error);process.exitCode=1;});
