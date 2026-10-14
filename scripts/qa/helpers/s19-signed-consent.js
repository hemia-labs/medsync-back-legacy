// Uses the caller's single connection/transaction and already installed DAO SQL
// adapter. Creates only a synthetic template/version/document; never sends links.
const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=';
async function createSignedConsent({ connection, business, patient, doctor }) {
    const dao = require('../../../src/Dao/mysql/document.dao');
    const idTemplate = uuid(), idVersion = uuid();
    const idBusiness = typeof business === 'string' ? business : business.id_business;
    const idPatient = typeof patient === 'string' ? patient : patient.id_person;
    const idDoctor = typeof doctor === 'string' ? doctor : doctor.id_login;
    const ok = response => { assert.equal(response.status, 200, response.message); return response.data; };
    await connection.query(`INSERT INTO document_templates (id_document_template,id_business,template_type,name,
        requires_patient_signature,requires_tutor_signature,requires_doctor_signature,requires_witness1_signature,requires_witness2_signature,is_active,active)
        VALUES (?,?,'SENSITIVE_DATA_CONSENT','S19 consentimiento ficticio integral',1,0,1,0,0,1,1)`, [idTemplate, idBusiness]);
    await connection.query(`INSERT INTO document_template_versions (id_document_template_version,id_document_template,version_number,content_html,status,is_current)
        VALUES (?,?,1,'<p>Prueba ficticia integral S19. Consentimiento de {{nombrePaciente}} con {{nombreDoctor}}.</p>','ACTIVE',1)`, [idVersion, idTemplate]);
    const body = { id_business: idBusiness, id_person: idPatient, id_login: idDoctor, responsible_doctor_user_id: idDoctor, id_document_template: idTemplate };
    const list = ok(await dao.createDocument({ ...body, status: 'PENDIENTE_FIRMA', origin: 'CLINICAL_HISTORY' }));
    const prepared = list.find(document => document.id_document_template === idTemplate);
    assert.ok(prepared, 'DAO must return the newly generated consent');
    assert.equal(prepared.status, 'PENDIENTE_FIRMA');
    assert.equal(prepared.requires_patient_signature, 1); assert.equal(prepared.requires_doctor_signature, 1);
    assert.equal((await dao.updateStatus({ ...body, id_patient_document: prepared.id_patient_document }, 'FIRMADO', 'SIGNED')).status, 400,
        'Clinical consent cannot be completed before patient signs');
    const signedList = ok(await dao.updateStatus({ ...body, id_patient_document: prepared.id_patient_document,
        patient_signature: png, signature_role: 'PATIENT', signer_name: 'Paciente ficticio S19' }, 'FIRMADO', 'SIGNED', 'Firma ficticia integral S19'));
    const signed = signedList.find(document => document.id_patient_document === prepared.id_patient_document);
    assert.equal(signed.status, 'FIRMADO'); assert.ok(signed.doctor_signature_snapshot);
    assert.equal(signed.content_html_snapshot, signed.signed_content_html_snapshot);
    assert.equal(signed.signatures.filter(signature => signature.signature_role === 'PATIENT').length, 1);
    return signed.id_patient_document;
}
module.exports = { createSignedConsent };
