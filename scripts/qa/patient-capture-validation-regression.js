const assert = require('node:assert/strict');
const patients = require('../../src/validators/px.validator');
const histories = require('../../src/validators/clinicalHistory.validator');
const { vitalSignError } = require('../../src/domain/clinicalHistory/vitalSignsValidation');
const birthday = '2000-01-01';
const age = new Date().getFullYear() - 2000;
const person = { id_person: 'QA_ONLY', name: 'Paciente ficticio', surname: 'QA', birthday, age, telephone: '(55) 1234-5678', local_telephone: '', ocupation: 'QA' };
const address = { direction: 'QA', cp: '01234', place_birth: 'QA', residence: 'QA' };
const body = { person, address, query: { reason_consultation: 'QA', current_condition: 'QA' }, allergy: { review_status: 'UNREVIEWED' } };
assert.equal(patients.validatePxCreateMinimal({ body }).isValid, true);
assert.equal(patients.validatePxAdministrative({ body }).isValid, true);
assert.equal(patients.validatePxSave({ body }).isValid, true);
for(const patch of [{ telephone: 'abc123' }, { telephone: '123' }, { local_telephone: 'A234567890' }, { birthday: '2030-02-31' }, { birthday: '2999-01-01' }, { age: -1 }, { age: age - 1 }]) {
  const invalid = { ...body, person: { ...person, ...patch } };
  assert.equal(patients.validatePxCreateMinimal({ body: invalid }).isValid, false);
  assert.equal(patients.validatePxAdministrative({ body: invalid }).isValid, false);
}
assert.equal(patients.validatePxCreateMinimal({ body: { ...body, address: { cp: 'ABCDE' } } }).isValid, false);
for(const [key, value] of [['weight', '-5'], ['oxygen_saturation', '150'], ['heart_rate', 'abc'], ['blood_pressure', '120mmHg']]) {
  const clinical_snapshot_json = { vital_signs: { [key]: value } };
  assert.equal(histories.validateDraftCreate({ body: { patient_id: 'QA_ONLY', clinical_snapshot_json } }).isValid, false);
  assert.equal(histories.validateDraftUpdate({ params: { id: 'QA_ONLY' }, body: { clinical_snapshot_json: JSON.stringify(clinical_snapshot_json) } }).isValid, false);
}
for(const [key, value] of [['weight', '0.7'], ['temperature', '45'], ['heart_rate', '350'], ['blood_pressure', '300/180'], ['oxygen_saturation', '0'], ['oxygen_saturation', '100'], ['height', '168'], ['height', '1.68']]) assert.equal(vitalSignError(key, value), '');
assert.equal(histories.validateDraftCreate({ body: { patient_id: 'QA_ONLY', clinical_snapshot_json: {} } }).isValid, true, 'Empty valid draft remains supported');
console.log('PASS patient capture API: minimal/administrative/legacy entry points, calendar/age/phone/postal validation, object/string clinical snapshots, optional measurements, physiological extremes. No database access.');
