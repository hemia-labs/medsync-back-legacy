'use strict';
// Real validator and DAO with in-memory query/permission/license stubs. No DB or HTTP.
const assert = require('node:assert/strict');
const { validateProfessionalPhone } = require('../../src/validators/professionalProfile.validator');
function stub(modulePath, exports) {
    const id = require.resolve(modulePath);
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const original = {
    id_doctor_professional_profile: 'qa-profile', professional_name: 'Doctor QA',
    professional_license: 'QA-license', university: 'Universidad QA', specialty: 'Especialidad QA',
    specialty_license: 'QA-specialty-license', professional_phone: '0012345678', signature_image: 'QA-signature',
    can_issue_prescriptions: 0, can_sign_documents: 0, is_active: 1
};
let profile = { ...original }, permitted = false, queries = 0, writes = [];
stub('../../src/db/Sequelize.connection', { async query(sql, options) {
    queries++;
    if(sql.includes('FROM login l')) {
        assert.equal(options.replacements._id_business, 'qa-tenant');
        return [{ id_login: options.replacements._id_login, id_business: 'qa-tenant', rol: 'doctor' }];
    }
    if(sql.includes('SELECT id_doctor_professional_profile')) return [{ id_doctor_professional_profile: profile.id_doctor_professional_profile }];
    if(sql.includes('SELECT can_issue_prescriptions')) return [{ ...profile }];
    if(sql.includes('UPDATE doctor_professional_profile')) {
        writes.push({ ...options.replacements });
        for(const key of Object.keys(profile)) if(Object.hasOwn(options.replacements, '_' + key)) profile[key] = options.replacements['_' + key];
        return [1];
    }
    throw new Error('Unexpected mocked query');
} });
stub('../../src/util/effectivePermissions', { hasPermission: async () => permitted });
stub('../../src/util/tracingPermissions', { seedTracingPermissions: async () => {} });
stub('../../src/util/dashboardAccess', { seedDashboardPermissions: async () => {} });
stub('../../src/util/licenseLimits', { validateLicenseForProfessionalProfile: async () => ({ allowed: true }) });
stub('../../src/Dao/mysql/licenseUsage.dao', {});
stub('../../src/util/sequelize.sp.util', {});
const dao = require('../../src/Dao/mysql/user.dao');
dao.getProfessionalProfile = async () => ({ status: 200, data: { ...profile } });
const base = { id_login: 'qa-doctor', target_id_login: 'qa-doctor', id_business: 'qa-tenant' };
(async () => {
    for(const input of [undefined, null, '', '   ']) assert.deepEqual(validateProfessionalPhone(input), { isValid: true, value: '' });
    for(const input of ['abc123', '123456789', '1234567890123456', '5512345678 ext 2', '55+12345678', 5512345678, {}, []]) {
        const validation = validateProfessionalPhone(input);
        assert.equal(validation.isValid, false); assert.match(validation.message, /10 a 15/);
        const before = queries;
        const response = await dao.saveProfessionalProfile({ ...base, professional_phone: input });
        assert.equal(response.status, 400); assert.equal(queries, before, 'Invalid values fail before profile queries/writes');
        assert.equal(response.data.fieldErrors.professional_phone, response.message);
        assert.doesNotMatch(response.message, /abc123|ext 2|5512345678/);
    }
    for(const [input, normalized] of [['', null], ['   ', null], ['0012345678', '0012345678'], ['+52 (55) 1234-5678', '+525512345678'], ['+001 (234) 567-8901', '+0012345678901']]) {
        profile = { ...original };
        const response = await dao.saveProfessionalProfile({ ...base, professional_phone: input });
        assert.equal(response.status, 200); assert.equal(writes.at(-1)._professional_phone, normalized);
        assert.equal(response.data.professional_phone, normalized);
        assert.equal(response.data.can_issue_prescriptions, 0, 'Saving contact never grants issuer permissions');
        assert.equal(response.data.can_sign_documents, 0, 'Saving contact never grants signature permissions');
        assert.equal(response.data.professional_name, original.professional_name, 'Partial contact updates retain identity');
    }
    permitted = true; profile = { ...original, professional_phone: 'histórico sin formato' };
    const authorization = await dao.saveProfessionalProfile({ ...base, id_login: 'qa-admin', can_issue_prescriptions: true, can_sign_documents: true, is_active: true });
    assert.equal(authorization.status, 200);
    for(const field of ['professional_name', 'professional_license', 'university', 'specialty', 'specialty_license', 'signature_image']) assert.equal(authorization.data[field], original[field], 'Authorization-only update retains ' + field);
    assert.equal(authorization.data.professional_phone, 'histórico sin formato', 'Omitted historical phone remains untouched and does not block authorizations');
    assert.equal(authorization.data.can_issue_prescriptions, 1); assert.equal(authorization.data.can_sign_documents, 1);
    permitted = false; const before = queries;
    assert.equal((await dao.saveProfessionalProfile({ ...base, id_login: 'qa-other', professional_phone: 'abc123' })).status, 401);
    assert.equal(queries, before, 'Cross-user permission gate remains before validation or queries');
    console.log('PASS professional phone: optional empty, invalid rejected without queries, formatted international accepted, leading zeroes preserved, normalized writes, clear field errors, unchanged clinical authorization requirements and safe partial authorization updates. No DB or HTTP.');
})().catch(error => { console.error(error); process.exitCode = 1; });
