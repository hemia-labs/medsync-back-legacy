'use strict';
// NC1 identidad integrada: one professional form, one atomic save. Real MySQL (isolated container from
// nc1-identity.docker.sh), real user.dao + identity service. Synthetic rows only.
//   - three plain names, statuses derived (empty = unknown, never a declaration);
//   - profile + identity commit together, including creation; 409/400/403 leave nothing half-written;
//   - professional_name derived from the names, legacy value kept when no names exist, cleared names clear it;
//   - a failed save removes the uploaded signature and keeps the stored one.
const test = require('node:test'), assert = require('node:assert/strict');
const mysql = require('mysql2/promise'), { Sequelize } = require('sequelize');

test('NC1 identidad integrada: atomic profile + identity save on MySQL', { skip: process.env.NC1_ISOLATED_QA !== '1' }, async () => {
    const database = 'nc1_qa_integrated_' + Date.now();
    const port = Number(process.env.NC1_ISOLATED_PORT || 33381);
    const conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'nc1-synthetic-only' });
    let db;
    try {
        await conn.query('CREATE DATABASE ' + database); await conn.changeUser({ database });
        await conn.query(`CREATE TABLE doctor_professional_profile (id_doctor_professional_profile VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50),id_login VARCHAR(50),professional_name VARCHAR(250),professional_license VARCHAR(50),university VARCHAR(100),specialty VARCHAR(100),specialty_license VARCHAR(50),professional_phone VARCHAR(50),signature_image TEXT,can_issue_prescriptions INT,can_sign_documents INT,is_active INT,created_at DATETIME,created_by VARCHAR(50),updated_at DATETIME,updated_by VARCHAR(50)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await conn.query(`CREATE TABLE person(id_business VARCHAR(50),id_person VARCHAR(50) PRIMARY KEY,name VARCHAR(250),surname VARCHAR(250),birthday DATE,age INT,updated_at DATETIME,updated_by VARCHAR(50)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await require('../migrations/nc1-identity').apply(conn, { isolated: true });
        await conn.query('CREATE TABLE login(id_login VARCHAR(50),id_business VARCHAR(50),id_rol VARCHAR(50),name VARCHAR(100),email VARCHAR(100),telephone VARCHAR(50),active INT) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        await conn.query('CREATE TABLE rol(id_rol VARCHAR(50),code VARCHAR(50)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        await conn.query("INSERT INTO rol VALUES ('r','doctor')");
        for (const id of ['new-doctor', 'legacy-doctor', 'failing-doctor']) await conn.query("INSERT INTO login VALUES (?,'qa','r','Ficticio','fixture@example.invalid','5512345678',1)", [id]);
        await conn.query("INSERT INTO doctor_professional_profile (id_doctor_professional_profile,id_business,id_login,professional_name,signature_image,is_active,can_issue_prescriptions,can_sign_documents) VALUES ('legacy-profile','qa','legacy-doctor','Dra. Nombre Antiguo','consultorios/qa/firma-anterior.png',1,0,0)");
        await conn.query("INSERT INTO person (id_business,id_person,name,surname) VALUES ('qa','patient','Paciente','Antiguo Apellido')");

        db = new Sequelize(database, 'root', 'nc1-synthetic-only', { host: '127.0.0.1', port, dialect: 'mysql', logging: false, pool: { max: 1, min: 0 } });
        const stub = (p, exports) => { const id = require.resolve(p); require.cache[id] = { id, filename: id, loaded: true, exports }; };
        const removed = [], uploads = [];
        let admins = new Set();
        stub('../../src/db/Sequelize.connection', db);
        stub('../../src/util/licenseMutation', { beginLicenseMutation: () => db.transaction() });
        stub('../../src/util/effectivePermissions', { hasPermission: async (login, permission) => permission === 'admin.users' && admins.has(login) });
        stub('../../src/util/tracingPermissions', { seedTracingPermissions: async () => {} });
        stub('../../src/util/dashboardAccess', { seedDashboardPermissions: async () => {} });
        stub('../../src/util/licenseLimits', { validateLicenseForProfessionalProfile: async () => ({ allowed: true }) });
        stub('../../src/Dao/mysql/licenseUsage.dao', {});
        stub('../../src/services/documentSignature/signatureImage.service', { validateSignatureImage: () => ({ image: Buffer.from('synthetic') }) });
        stub('../../src/services/aws/privateImages', {
            upload: async (_image, business, login) => { const key = `consultorios/${business}/${login}/nueva-${uploads.length}.png`; uploads.push(key); return { Key: key }; },
            remove: async key => { removed.push(key); }, pending: async () => {}
        });
        const dao = require('../../src/Dao/mysql/user.dao');
        const service = require('../../src/domain/identity/service').createService(db);
        const profileRow = async login => (await conn.query('SELECT * FROM doctor_professional_profile WHERE id_login=?', [login]))[0][0];
        const identityRow = async profile => (await conn.query('SELECT * FROM professional_identity WHERE id_doctor_professional_profile=?', [profile]))[0][0];
        const save = body => dao.saveProfessionalProfile({ id_login: 'new-doctor', id_business: 'qa', ...body });

        // 1. Creation: profile and identity in one action, compound names, second surname empty.
        const created = await save({ university: 'Universidad ficticia', professional_license: '12345678',
            identity: { givenNames: 'María José', firstSurname: 'De la Prueba', secondSurname: null, birthDate: '1985-02-03',
                curp: { value: 'XEXX850203MNEXXXA1', kind: 'real' }, birthCountry: { family: 'sis.country', code: '223' } }, identity_expected_revision: 0 });
        assert.equal(created.status, 200, JSON.stringify(created));
        assert.equal(created.data.professional_name, 'María José De la Prueba', 'Display name derived, no title, nothing split');
        assert.equal(created.data.identity.revision, 1);
        assert.equal(created.data.identity.firstSurnameStatus, 'present');
        assert.equal(created.data.identity.secondSurnameStatus, 'unknown', 'Empty second surname is not a declaration');
        assert.equal(created.data.identity.secondSurname, null);
        const createdId = created.data.id_doctor_professional_profile;

        // 2. Edit name, CURP and a professional field together.
        const edited = await save({ university: 'Universidad editada', identity: { secondSurname: 'Ensayo', curp: { value: 'XEXX850203MNEXXXA2', kind: 'real' } }, identity_expected_revision: 1 });
        assert.equal(edited.status, 200, JSON.stringify(edited));
        assert.equal(edited.data.university, 'Universidad editada');
        assert.equal(edited.data.professional_name, 'María José De la Prueba Ensayo');
        assert.equal(edited.data.identity.revision, 2);
        assert.equal(edited.data.identity.curp.value, 'XEXX850203MNEXXXA2');

        // 3. Stale revision: 409 and neither half persists.
        const before = { profile: await profileRow('new-doctor'), identity: await identityRow(createdId) };
        const stale = await save({ university: 'No debe guardarse', identity: { givenNames: 'Otro' }, identity_expected_revision: 1 });
        assert.equal(stale.status, 409); assert.equal(stale.data.code, 'IDENTITY_CONFLICT');
        assert.deepEqual(await profileRow('new-doctor'), before.profile, 'Profile untouched after identity conflict');
        assert.deepEqual(await identityRow(createdId), before.identity);

        // 4. Field validation (code with spaces) and restricted personnel types: same guarantee.
        const invalid = await save({ specialty: 'No debe guardarse', identity: { birthCountry: { family: 'sis.country', code: ' 223' } }, identity_expected_revision: 2 });
        assert.equal(invalid.status, 400); assert.equal(invalid.data.field, 'birthCountry');
        const restricted = await save({ specialty: 'No debe guardarse', identity: { authorizedPersonnelTypes: [{ family: 'sis.personnel_type', code: '01' }] }, identity_expected_revision: 2 });
        assert.equal(restricted.status, 403); assert.equal(restricted.data.code, 'IDENTITY_FORBIDDEN');
        assert.deepEqual(await profileRow('new-doctor'), before.profile);
        assert.deepEqual(await identityRow(createdId), before.identity);
        admins = new Set(['new-doctor']);
        const managed = await save({ identity: { authorizedPersonnelTypes: [{ family: 'sis.personnel_type', code: '01' }] }, identity_expected_revision: 2 });
        assert.equal(managed.status, 200, 'Administrators keep managing personnel types');
        admins = new Set();

        // 5. A failing creation leaves no profile behind.
        const failingCreate = await dao.saveProfessionalProfile({ id_login: 'failing-doctor', id_business: 'qa', university: 'X',
            identity: { givenNames: 'Falla', birthCountry: { family: 'sis.country', code: '' } }, identity_expected_revision: 0 });
        assert.equal(failingCreate.status, 400);
        assert.equal(await profileRow('failing-doctor'), undefined, 'No half-created profile');

        // 6. Explicit clearing of a surname does not bring the old value back.
        const cleared = await save({ identity: { secondSurname: null }, identity_expected_revision: 3 });
        assert.equal(cleared.status, 200, JSON.stringify(cleared));
        assert.equal(cleared.data.professional_name, 'María José De la Prueba');
        const reopened = await dao.getProfessionalProfile('new-doctor', 'qa', 'new-doctor');
        assert.equal(reopened.data.identity.secondSurname, null);
        assert.equal(reopened.data.identity.secondSurnameStatus, 'unknown');

        // 7. Legacy profile: identity without names keeps the legacy display name (never split by spaces).
        const legacyCurp = await dao.saveProfessionalProfile({ id_login: 'legacy-doctor', id_business: 'qa',
            identity: { curp: { value: 'XEXX800101HNEXXXA3', kind: 'real' } }, identity_expected_revision: 0 });
        assert.equal(legacyCurp.status, 200, JSON.stringify(legacyCurp));
        assert.equal(legacyCurp.data.professional_name, 'Dra. Nombre Antiguo');
        assert.equal(legacyCurp.data.identity.legacyProfessionalName, 'Dra. Nombre Antiguo');
        assert.equal(legacyCurp.data.identity.givenNames, null);

        // 8. Signature + conflict: uploaded file removed, stored signature kept, nothing else written.
        const legacyBefore = await profileRow('legacy-doctor');
        const signatureConflict = await dao.saveProfessionalProfile({ id_login: 'legacy-doctor', id_business: 'qa', signature_image: 'data:image/png;base64,c3ludGhldGlj',
            identity: { givenNames: 'Nombre' }, identity_expected_revision: 0 });
        assert.equal(signatureConflict.status, 409);
        assert.equal(uploads.length, 1); assert.deepEqual(removed.filter(Boolean), [uploads[0]], 'The new upload is removed after rollback');
        // (Pre-existing: a successful save without signatures calls remove(undefined); privateImages ignores it.)
        assert.deepEqual(await profileRow('legacy-doctor'), legacyBefore, 'Stored signature and fields unchanged');

        // 9. Older clients still sending statuses: accepted, derived from values.
        const patient = await service.save('patient', 'patient', 'qa', 'actor', { givenNames: 'Paciente', firstSurname: 'Uno', secondSurname: null, firstSurnameStatus: 'unknown', secondSurnameStatus: 'absent_declared' }, 0);
        assert.equal(patient.firstSurnameStatus, 'present'); assert.equal(patient.secondSurnameStatus, 'unknown');
        assert.equal((await conn.query("SELECT surname FROM person WHERE id_person='patient'"))[0][0].surname, 'Uno');

        // 10. Clearing the last structured surname must not resurrect the previous search/display value.
        const clearedPatient = await service.save('patient', 'patient', 'qa', 'actor', { firstSurname: null, secondSurname: null }, 1);
        assert.equal(clearedPatient.firstSurname, null);
        assert.equal((await conn.query("SELECT surname FROM person WHERE id_person='patient'"))[0][0].surname, null);
        await service.save('patient', 'patient', 'qa', 'actor', { curp: null }, 2);
        assert.equal((await conn.query("SELECT surname FROM person WHERE id_person='patient'"))[0][0].surname, null, 'Unrelated save cannot bring surname back');

        // A legacy surname with no structured capture is retained on an unrelated change.
        await conn.query("INSERT INTO person (id_business,id_person,name,surname) VALUES ('qa','legacy-patient','Paciente','De la Prueba Antigua')");
        await service.save('patient', 'legacy-patient', 'qa', 'actor', { curp: null }, 0);
        assert.equal((await conn.query("SELECT surname FROM person WHERE id_person='legacy-patient'"))[0][0].surname, 'De la Prueba Antigua');
        // NC1-CATALOGS: install a test-only reference release and exercise actual domain writes/rollback.
        await require('../migrations/nc4-catalogs').install(conn,()=>{});
        const manifest={releaseId:'qa-country',family:'sis.country',sourceCatalogName:'Isolated QA only',sourceUrl:null,sourceVersion:'QA',downloadedAt:new Date().toISOString(),sha256:'c'.repeat(64),encoding:'utf-8',validFrom:'2020-01-01',validTo:null,validityBasis:'download_date',provenance:'official',status:'staged',verifiedAt:null,columnMapping:{}};
        const release=require('../../src/domain/sisCatalog/release').buildRelease(manifest,[{code:'001',label:'País sintético QA',attributes:{}}]);
        await require('../../src/domain/sisCatalog/installRelease').installRelease(conn,release,{verify:true,sourceSha256:manifest.sha256});
        const catalogRef={family:'sis.country',releaseId:'qa-country',code:'001'};
        const catalogPatient=await service.save('patient','patient','qa','actor',{birthCountry:catalogRef},3);
        assert.equal(catalogPatient.catalogValidation,'verified');assert.deepEqual(catalogPatient.birthCountry,catalogRef);
        const patientBefore=(await conn.query("SELECT * FROM patient_identity WHERE id_person='patient'"))[0][0];
        await assert.rejects(()=>service.save('patient','patient','qa','actor',{givenNames:'No guardar',birthCountry:{...catalogRef,code:'999'}},4),e=>e.code==='CATALOG_CODE_NOT_FOUND'&&e.field==='birthCountry');
        assert.deepEqual((await conn.query("SELECT * FROM patient_identity WHERE id_person='patient'"))[0][0],patientBefore);
        const profileBeforeCatalog=await profileRow('new-doctor'), identityBeforeCatalog=await identityRow(createdId);
        const failedCatalog=await save({university:'No guardar catálogo',identity:{birthCountry:{...catalogRef,code:'999'}},identity_expected_revision:identityBeforeCatalog.revision});
        assert.equal(failedCatalog.status,400);assert.equal(failedCatalog.data.code,'CATALOG_CODE_NOT_FOUND');
        assert.deepEqual(await profileRow('new-doctor'),profileBeforeCatalog);assert.deepEqual(await identityRow(createdId),identityBeforeCatalog);
        await assert.rejects(()=>service.save('patient','patient','foreign','actor',{birthCountry:catalogRef},4),e=>e.status===404);
        await conn.query('CREATE TABLE business (id_business VARCHAR(50) PRIMARY KEY)');await conn.query("INSERT INTO business VALUES ('qa')");
        const cluesManifest={...manifest,releaseId:'qa-clues',family:'sis.establishments',sha256:'d'.repeat(64)};
        const cluesRelease=require('../../src/domain/sisCatalog/release').buildRelease(cluesManifest,[{code:'QATEST00001',label:'Unidad QA',attributes:{en_operacion:'1'}}]);
        await require('../../src/domain/sisCatalog/installRelease').installRelease(conn,cluesRelease,{verify:true,sourceSha256:cluesManifest.sha256});
        const cluesRef={family:'sis.establishments',releaseId:'qa-clues',code:'QATEST00001'};
        const establishment=await service.save('establishment',null,'qa','actor',{displayName:'Unidad QA',cluesRef},0);
        const reopenedEstablishment=await service.read('establishment',establishment.id,'qa');
        assert.deepEqual(reopenedEstablishment.data.cluesRef,cluesRef);assert.equal(establishment.catalogValidation,'verified');
        await assert.rejects(()=>service.save('establishment',establishment.id,'qa','actor',{displayName:'No guardar',cluesRef:{...cluesRef,code:'QATEST00002'}},1),e=>e.code==='CLUES_NOT_IN_SIS_RELEASE');
        assert.equal((await service.read('establishment',establishment.id,'qa')).data.displayName,'Unidad QA');
        // CAT-O2: a nested residence PATCH cannot combine a saved foreign country with INEGI.
        await service.save('patient','patient','qa','actor',{residence:{country:catalogRef}},4);
        const beforeResidence=(await conn.query("SELECT * FROM patient_identity WHERE id_person='patient'"))[0][0];
        await assert.rejects(()=>service.save('patient','patient','qa','actor',{givenNames:'No guardar país',residence:{entity:{family:'inegi.state',code:'01'}}},5),e=>e.code==='RESIDENCE_COUNTRY_GEO_MISMATCH'&&e.field==='residence.country');
        assert.deepEqual((await conn.query("SELECT * FROM patient_identity WHERE id_person='patient'"))[0][0],beforeResidence);
    } finally { if (db) await db.close(); await conn.query('DROP DATABASE IF EXISTS ' + database).catch(() => {}); await conn.end(); }
});
