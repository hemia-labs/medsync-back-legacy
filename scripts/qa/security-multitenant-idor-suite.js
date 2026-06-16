#!/usr/bin/env node
'use strict';

require('../../src/config/env');

const { QueryTypes } = require('sequelize');
const sequelize = require('../../src/db/Sequelize.connection');
const { encript } = require('../../src/util/bcrypt');
const PxDao = require('../../src/Dao/mysql/px.dao');
const AppointmentDao = require('../../src/Dao/mysql/appointment.Dao');
const ClinicalHistoryDao = require('../../src/Dao/mysql/clinicalHistory.dao');
const PrescriptionDao = require('../../src/Dao/mysql/prescription.dao');
const DocumentDao = require('../../src/Dao/mysql/document.dao');
const FilesDao = require('../../src/Dao/mysql/file.Dao');
const requireTenantOperational = require('../../src/middleware/requireTenantOperational.middleware');

const WRITE_FLAG = 'ALLOW_SECURITY_IDOR_FIXTURES';
const WRITE_FLAG_VALUE = '1';
const CREATED_BY = 'QA_SECURITY_IDOR_FIXTURES';
const PREFIX = 'QA_SECURITY_IDOR_';
const PREFIX_LIKE = `${PREFIX}%`;
const MARKER_A = `${PREFIX}BUSINESS_A_MARKER`;
const MARKER_B = `${PREFIX}BUSINESS_B_MARKER`;

const BUSINESS = {
  A: {
    id: `${PREFIX}BUSINESS_A`,
    name: `${MARKER_A} Clinic`,
    slug: 'qa-security-idor-business-a',
    email: 'qa.security.idor.a@example.test',
    phone: '9995000001'
  },
  B: {
    id: `${PREFIX}BUSINESS_B`,
    name: `${MARKER_B} Clinic`,
    slug: 'qa-security-idor-business-b',
    email: 'qa.security.idor.b@example.test',
    phone: '9995000002'
  }
};

const USERS = {
  adminA: { id: `${PREFIX}ADMIN_A`, role: 'admin', business: 'A', name: `${PREFIX}ADMIN_A`, email: 'qa.security.idor.admin.a@example.test', phone: '9995000101' },
  doctorA: { id: `${PREFIX}DOCTOR_A`, role: 'doctor', business: 'A', name: `${PREFIX}DOCTOR_A`, email: 'qa.security.idor.doctor.a@example.test', phone: '9995000102' },
  assistantA: { id: `${PREFIX}ASSISTANT_A`, role: 'assistant', business: 'A', name: `${PREFIX}ASSISTANT_A`, email: 'qa.security.idor.assistant.a@example.test', phone: '9995000103' },
  receptionA: { id: `${PREFIX}RECEPTION_A`, role: 'reception', business: 'A', name: `${PREFIX}RECEPTION_A`, email: 'qa.security.idor.reception.a@example.test', phone: '9995000104' },
  noPermissionA: { id: `${PREFIX}NO_PERMISSION_A`, role: 'qa_security_idor_no_permission', business: 'A', name: `${PREFIX}NO_PERMISSION_A`, email: 'qa.security.idor.noperm.a@example.test', phone: '9995000105' },
  doctorB: { id: `${PREFIX}DOCTOR_B`, role: 'doctor', business: 'B', name: `${PREFIX}DOCTOR_B`, email: 'qa.security.idor.doctor.b@example.test', phone: '9995000202' },
  superAdmin: { id: `${PREFIX}SUPER_ADMIN`, role: 'super_admin', business: null, name: `${PREFIX}SUPER_ADMIN`, email: 'qa.security.idor.super@example.test', phone: '9995000999' }
};

const ROLE_NO_PERMISSION = {
  id: `${PREFIX}ROLE_NO_PERMISSION`,
  code: 'qa_security_idor_no_permission',
  description: 'QA Security IDOR No Permission'
};

const PATIENT = {
  A: { id: `${PREFIX}PATIENT_A`, code: 'IDORA001', name: `${PREFIX}PATIENT_A`, surname: 'FICTITIOUS_A', phone: '9995001001' },
  B: { id: `${PREFIX}PATIENT_B`, code: 'IDORB001', name: `${PREFIX}PATIENT_B_${MARKER_B}`, surname: 'FICTITIOUS_B', phone: '9995002001' }
};

const APPOINTMENT = {
  A: { id: `${PREFIX}APPOINTMENT_A`, title: `${PREFIX}APPOINTMENT_A` },
  B: { id: `${PREFIX}APPOINTMENT_B`, title: `${PREFIX}APPOINTMENT_B_${MARKER_B}` }
};

const CLINICAL_HISTORY = {
  A: { id: `${PREFIX}CLINICAL_HISTORY_A` },
  B: { id: `${PREFIX}CLINICAL_HISTORY_B` }
};

const PRESCRIPTION = {
  A: { id: `${PREFIX}PRESCRIPTION_A` },
  B: { id: `${PREFIX}PRESCRIPTION_B` }
};

const DOCUMENT = {
  A: { templateId: `${PREFIX}DOC_TEMPLATE_A`, versionId: `${PREFIX}DOC_TEMPLATE_VERSION_A`, documentId: `${PREFIX}PATIENT_DOCUMENT_A` },
  B: { templateId: `${PREFIX}DOC_TEMPLATE_B`, versionId: `${PREFIX}DOC_TEMPLATE_VERSION_B`, documentId: `${PREFIX}PATIENT_DOCUMENT_B` }
};

const FILES = {
  A: { id: `${PREFIX}FILE_A`, url: `https://example.test/${PREFIX}file-a.png` },
  B: { id: `${PREFIX}FILE_B`, url: `https://example.test/${PREFIX}file-b-${MARKER_B}.png` }
};

const DOCTOR_PROFILE = {
  A: `${PREFIX}DOCTOR_PROFILE_A`,
  B: `${PREFIX}DOCTOR_PROFILE_B`
};

function userList() {
  return Object.keys(USERS).map((key) => USERS[key]);
}

function businessList() {
  return Object.keys(BUSINESS).map((key) => BUSINESS[key]);
}

function assertWriteAllowed(command) {
  const missing = [];
  if (process.env.ALLOW_D2_QA_DB !== '1') {
    missing.push('ALLOW_D2_QA_DB=1');
  }
  if (process.env[WRITE_FLAG] !== WRITE_FLAG_VALUE) {
    missing.push(`${WRITE_FLAG}=${WRITE_FLAG_VALUE}`);
  }
  if (!process.env.QA_AUTH_PASSWORD) {
    missing.push('QA_AUTH_PASSWORD');
  }

  if (missing.length) {
    const error = new Error(`${command} requiere flags explicitos para escribir fixtures QA: ${missing.join(', ')}`);
    error.code = 'QA_WRITE_FLAGS_REQUIRED';
    throw error;
  }
}

async function tableExists(tableName) {
  const rows = await sequelize.query(
    `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = :tableName`,
    { replacements: { tableName }, type: QueryTypes.SELECT }
  );
  return Number(rows[0] ? rows[0].total : 0) > 0;
}

async function queryIfTable(tableName, sql, replacements, type, transaction = null) {
  if (!(await tableExists(tableName))) {
    return [];
  }

  return sequelize.query(sql, {
    replacements,
    type,
    transaction
  });
}

async function currentDatabase() {
  const rows = await sequelize.query(
    'SELECT DATABASE() AS db, @@hostname AS host, @@port AS port',
    { type: QueryTypes.SELECT }
  );
  return rows[0] || {};
}

async function roleByCode(code) {
  const rows = await sequelize.query(
    `SELECT id_rol, code
       FROM rol
      WHERE code COLLATE utf8mb4_unicode_ci = :code COLLATE utf8mb4_unicode_ci
        AND active = 1
      LIMIT 1`,
    { replacements: { code }, type: QueryTypes.SELECT }
  );
  return rows[0] || null;
}

async function rolesStatus() {
  const codes = ['admin', 'doctor', 'assistant', 'reception', 'super_admin', ROLE_NO_PERMISSION.code];
  const out = {};
  for (const code of codes) {
    const role = await roleByCode(code);
    out[code] = role ? { found: true, id_rol: role.id_rol } : { found: false };
  }
  return out;
}

async function requiredRoles() {
  const roles = await rolesStatus();
  const missing = ['admin', 'doctor', 'assistant', 'reception', 'super_admin']
    .filter((code) => !roles[code].found);
  if (missing.length) {
    throw new Error(`Roles requeridos no encontrados: ${missing.join(', ')}`);
  }
  return roles;
}

async function ensureNoPermissionRole(transaction) {
  await sequelize.query(
    `INSERT INTO rol (id_rol, desc_rol, code, active)
     VALUES (:id, :description, :code, 1)
     ON DUPLICATE KEY UPDATE desc_rol = VALUES(desc_rol), active = 1`,
    {
      replacements: ROLE_NO_PERMISSION,
      type: QueryTypes.INSERT,
      transaction
    }
  );

  await sequelize.query(
    'DELETE FROM permission_rol WHERE id_rol COLLATE utf8mb4_unicode_ci = :id COLLATE utf8mb4_unicode_ci',
    { replacements: { id: ROLE_NO_PERMISSION.id }, type: QueryTypes.DELETE, transaction }
  );
}

async function ensureBusiness(business, transaction) {
  await sequelize.query(
    `INSERT INTO business (
        id_business, name, legal_name, slug, email, phone, address, status, plan, active,
        subscription_status, current_period_starts_at, current_period_ends_at, created_at, created_by
      ) VALUES (
        :id, :name, :name, :slug, :email, :phone, 'QA Security IDOR fixture. No real data.',
        'active', 'enterprise', 1, 'active', NOW(), NULL, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        legal_name = VALUES(legal_name),
        email = VALUES(email),
        phone = VALUES(phone),
        status = 'active',
        plan = 'enterprise',
        active = 1,
        subscription_status = 'active',
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        id: business.id,
        name: business.name,
        slug: business.slug,
        email: business.email,
        phone: business.phone,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureUser(user, roleId, passwordHash, transaction) {
  const business = user.business ? BUSINESS[user.business] : null;
  await sequelize.query(
    `INSERT INTO login (
        id_login, id_business, id_rol, name, email, telephone, password, locked,
        active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :id, :businessId, :roleId, :name, :email, :phone, :password, 0,
        1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_rol = VALUES(id_rol),
        name = VALUES(name),
        email = VALUES(email),
        telephone = VALUES(telephone),
        password = VALUES(password),
        locked = 0,
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        id: user.id,
        businessId: business ? business.id : null,
        roleId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        password: passwordHash,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureDoctorProfile(key, transaction) {
  const business = BUSINESS[key];
  const doctor = key === 'A' ? USERS.doctorA : USERS.doctorB;
  await sequelize.query(
    `INSERT INTO doctor_professional_profile (
        id_doctor_professional_profile, id_business, id_login, professional_name,
        professional_license, university, specialty, specialty_license, professional_phone,
        can_issue_prescriptions, can_sign_documents, is_active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :profileId, :businessId, :loginId, :professionalName,
        :license, 'QA University Not Real', 'QA Specialty Not Real', 'QA-SPECIALTY-NOT-REAL', :phone,
        1, 1, 1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_login = VALUES(id_login),
        professional_name = VALUES(professional_name),
        professional_license = VALUES(professional_license),
        can_issue_prescriptions = 1,
        can_sign_documents = 1,
        is_active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        profileId: DOCTOR_PROFILE[key],
        businessId: business.id,
        loginId: doctor.id,
        professionalName: doctor.name,
        license: `${PREFIX}LICENSE_${key}`,
        phone: doctor.phone,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensurePatient(key, transaction) {
  const business = BUSINESS[key];
  const patient = PATIENT[key];
  await sequelize.query(
    `INSERT INTO person (
        id_person, id_business, code, name, surname, birthday, age, ocupation, rfc,
        local_telephone, telephone, active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :idPerson, :idBusiness, :code, :name, :surname, '1990-01-01', 35, 'QA fixture', NULL,
        :phone, :phone, 1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        code = VALUES(code),
        name = VALUES(name),
        surname = VALUES(surname),
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idPerson: patient.id,
        idBusiness: business.id,
        code: patient.code,
        name: patient.name,
        surname: patient.surname,
        phone: patient.phone,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  await sequelize.query(
    `INSERT INTO address (
        id_address, id_business, id_person, place_birth, residence, direction, cp,
        last, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :idAddress, :idBusiness, :idPerson, 'QA', 'QA', :direction, '00000',
        1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_person = VALUES(id_person),
        direction = VALUES(direction),
        last = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idAddress: `${patient.id}_ADDRESS`,
        idBusiness: business.id,
        idPerson: patient.id,
        direction: `${patient.name} address`,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  await sequelize.query(
    `INSERT INTO \`query\` (
        id_query, id_business, id_person, reason_consultation, current_condition,
        pulse, blood_pressure, dia, oxygenation, tou, last, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :idQuery, :idBusiness, :idPerson, :reason, :condition,
        NULL, NULL, NULL, NULL, NULL, 1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_person = VALUES(id_person),
        reason_consultation = VALUES(reason_consultation),
        current_condition = VALUES(current_condition),
        last = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idQuery: `${patient.id}_QUERY`,
        idBusiness: business.id,
        idPerson: patient.id,
        reason: `QA reason ${key}`,
        condition: `${patient.name} condition`,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  await sequelize.query(
    `INSERT INTO allergy (
        id_allergy, id_business, id_patient, has_allergy, description, active,
        is_active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :idAllergy, :idBusiness, :idPerson, 0, NULL, 1,
        1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_patient = VALUES(id_patient),
        active = 1,
        is_active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idAllergy: `${patient.id}_ALLERGY`,
        idBusiness: business.id,
        idPerson: patient.id,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureAppointment(key, transaction) {
  const business = BUSINESS[key];
  const patient = PATIENT[key];
  const appointment = APPOINTMENT[key];
  const doctor = key === 'A' ? USERS.doctorA : USERS.doctorB;
  await sequelize.query(
    `INSERT INTO appointment (
        id_appointment, id_business, id_person, patient_name, appointment_date,
        start_time, end_time, status, title, description, source, active,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        :idAppointment, :idBusiness, :idPerson, :patientName, CURRENT_DATE(),
        '09:00:00', '09:30:00', 'pending_confirmation', :title, :description, 'manual', 1,
        NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_person = VALUES(id_person),
        patient_name = VALUES(patient_name),
        title = VALUES(title),
        description = VALUES(description),
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idAppointment: appointment.id,
        idBusiness: business.id,
        idPerson: patient.id,
        patientName: `${patient.name} ${patient.surname}`,
        title: appointment.title,
        description: `${appointment.title} no real data`,
        createdBy: doctor.id
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureClinicalHistory(key, transaction) {
  const business = BUSINESS[key];
  const patient = PATIENT[key];
  const doctor = key === 'A' ? USERS.doctorA : USERS.doctorB;
  const snapshot = JSON.stringify({
    qa: true,
    business: key,
    marker: key === 'B' ? MARKER_B : MARKER_A
  });

  await sequelize.query(
    `INSERT INTO clinical_histories (
        id_clinical_history, business_id, patient_id, doctor_responsible_profile_id,
        doctor_responsible_user_id, created_by_user_id, updated_by_user_id,
        status, version_number, source, template_snapshot_json, clinical_snapshot_json,
        created_at, updated_at
      ) VALUES (
        :historyId, :businessId, :patientId, :doctorProfileId,
        :doctorUserId, :doctorUserId, :doctorUserId,
        'DRAFT', 1, 'MANUAL', :snapshot, :snapshot,
        NOW(), NOW()
      )
      ON DUPLICATE KEY UPDATE
        business_id = VALUES(business_id),
        patient_id = VALUES(patient_id),
        doctor_responsible_profile_id = VALUES(doctor_responsible_profile_id),
        doctor_responsible_user_id = VALUES(doctor_responsible_user_id),
        status = 'DRAFT',
        template_snapshot_json = VALUES(template_snapshot_json),
        clinical_snapshot_json = VALUES(clinical_snapshot_json),
        deleted_at = NULL,
        updated_at = NOW()`,
    {
      replacements: {
        historyId: CLINICAL_HISTORY[key].id,
        businessId: business.id,
        patientId: patient.id,
        doctorProfileId: DOCTOR_PROFILE[key],
        doctorUserId: doctor.id,
        snapshot
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensurePrescription(key, transaction) {
  const business = BUSINESS[key];
  const patient = PATIENT[key];
  const doctor = key === 'A' ? USERS.doctorA : USERS.doctorB;
  const marker = key === 'B' ? MARKER_B : MARKER_A;

  await sequelize.query(
    `INSERT INTO prescription (
        id_prescription, id_business, id_person, issuer_doctor_id, issuer_doctor_profile_id,
        created_by, folio, status, issue_date, diagnosis, notes, doctor_name_snapshot,
        professional_license_snapshot, clinic_name_snapshot, active, created_at, updated_at, updated_by
      ) VALUES (
        :idPrescription, :idBusiness, :idPerson, :doctorId, :profileId,
        :doctorId, :folio, 'DRAFT', CURRENT_DATE(), :diagnosis, :notes, :doctorName,
        :license, :clinicName, 1, NOW(), NOW(), :doctorId
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_person = VALUES(id_person),
        issuer_doctor_id = VALUES(issuer_doctor_id),
        issuer_doctor_profile_id = VALUES(issuer_doctor_profile_id),
        status = 'DRAFT',
        diagnosis = VALUES(diagnosis),
        notes = VALUES(notes),
        clinic_name_snapshot = VALUES(clinic_name_snapshot),
        active = 1,
        updated_at = NOW(),
        updated_by = :doctorId`,
    {
      replacements: {
        idPrescription: PRESCRIPTION[key].id,
        idBusiness: business.id,
        idPerson: patient.id,
        doctorId: doctor.id,
        profileId: DOCTOR_PROFILE[key],
        folio: `${key}-1`,
        diagnosis: `${PREFIX} diagnosis ${marker}`,
        notes: `${PREFIX} notes ${marker}`,
        doctorName: doctor.name,
        license: `${PREFIX}LICENSE_${key}`,
        clinicName: business.name
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  await sequelize.query(
    `INSERT INTO prescription_item (
        id_prescription_item, id_prescription, id_business, generic_name,
        dose, administration_route, frequency, duration, quantity, indications,
        sort_order, created_at, updated_at
      ) VALUES (
        :idItem, :idPrescription, :idBusiness, :genericName,
        '1', 'oral', 'daily', '1 day', '1', 'QA fictitious indication',
        1, NOW(), NOW()
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        generic_name = VALUES(generic_name),
        administration_route = VALUES(administration_route),
        quantity = VALUES(quantity),
        indications = VALUES(indications),
        updated_at = NOW()`,
    {
      replacements: {
        idItem: `${PRESCRIPTION[key].id}_ITEM`,
        idPrescription: PRESCRIPTION[key].id,
        idBusiness: business.id,
        genericName: `${PREFIX}MED_${key}`
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureDocument(key, transaction) {
  const business = BUSINESS[key];
  const patient = PATIENT[key];
  const doctor = key === 'A' ? USERS.doctorA : USERS.doctorB;
  const doc = DOCUMENT[key];
  const marker = key === 'B' ? MARKER_B : MARKER_A;
  const html = `<p>${PREFIX} document ${marker}. No real data.</p>`;

  await sequelize.query(
    `INSERT INTO document_templates (
        id_document_template, id_business, template_type, license_category, template_subtype,
        is_premium, clinical_legal_safe, minimum_plan, block_mode, licensing_review_required,
        licensing_notes, name, description, requires_patient_signature, requires_tutor_signature,
        requires_doctor_signature, requires_witness1_signature, requires_witness2_signature,
        is_active, active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :templateId, :businessId, 'CUSTOM_DOCUMENT', 'standard_document_template', 'qa_security_idor',
        0, 1, NULL, NULL, 0,
        'QA Security IDOR fixture. No real data.', :name, :description, 1, 0,
        1, 0, 0, 1, 1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        name = VALUES(name),
        description = VALUES(description),
        is_active = 1,
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        templateId: doc.templateId,
        businessId: business.id,
        name: `${PREFIX}DOC_TEMPLATE_${key}`,
        description: `QA Security IDOR template ${marker}`,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  await sequelize.query(
    `INSERT INTO document_template_versions (
        id_document_template_version, id_document_template, version_number, content_html,
        status, is_current, created_at, created_by
      ) VALUES (
        :versionId, :templateId, 1, :html, 'ACTIVE', 1, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        content_html = VALUES(content_html),
        status = 'ACTIVE',
        is_current = 1`,
    {
      replacements: {
        versionId: doc.versionId,
        templateId: doc.templateId,
        html,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  await sequelize.query(
    `INSERT INTO patient_documents (
        id_patient_document, id_business, id_person, id_document_template,
        id_document_template_version, template_version_number, document_type, origin, status,
        title, content_html_snapshot, responsible_doctor_user_id, responsible_doctor_profile_id,
        doctor_name_snapshot, professional_license_snapshot, clinical_history_id,
        active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :documentId, :businessId, :patientId, :templateId,
        :versionId, 1, 'CUSTOM_DOCUMENT', 'DOCUMENT_CENTER', 'BORRADOR',
        :title, :html, :doctorUserId, :doctorProfileId,
        :doctorName, :license, :historyId,
        1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_person = VALUES(id_person),
        id_document_template = VALUES(id_document_template),
        id_document_template_version = VALUES(id_document_template_version),
        status = 'BORRADOR',
        title = VALUES(title),
        content_html_snapshot = VALUES(content_html_snapshot),
        responsible_doctor_user_id = VALUES(responsible_doctor_user_id),
        responsible_doctor_profile_id = VALUES(responsible_doctor_profile_id),
        clinical_history_id = VALUES(clinical_history_id),
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        documentId: doc.documentId,
        businessId: business.id,
        patientId: patient.id,
        templateId: doc.templateId,
        versionId: doc.versionId,
        title: `${PREFIX}PATIENT_DOCUMENT_${key}_${marker}`,
        html,
        doctorUserId: doctor.id,
        doctorProfileId: DOCTOR_PROFILE[key],
        doctorName: doctor.name,
        license: `${PREFIX}LICENSE_${key}`,
        historyId: CLINICAL_HISTORY[key].id,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureConfig(key, transaction) {
  const business = BUSINESS[key];
  await sequelize.query(
    `INSERT INTO clinical_module_config (
        id_clinical_module_config, id_business, odontogram_enabled, treatment_plan_enabled,
        allow_treatment_tooth_selection, show_treatment_costs, show_treatment_status,
        active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :idConfig, :idBusiness, 1, 1, 1, 1, 1, 1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        odontogram_enabled = 1,
        treatment_plan_enabled = 1,
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idConfig: `${PREFIX}CLINICAL_MODULE_CONFIG_${key}`,
        idBusiness: business.id,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureFile(key, transaction) {
  const business = BUSINESS[key];
  const patient = PATIENT[key];
  const file = FILES[key];
  const catRows = await sequelize.query(
    'SELECT id_cat_files FROM cat_files WHERE active = 1 LIMIT 1',
    { type: QueryTypes.SELECT, transaction }
  );
  if (!catRows[0]) {
    return;
  }

  await sequelize.query(
    `INSERT INTO files (
        id_files, id_cat_files, id_person, url, active, sec, last, created_at,
        created_by, updated_at, updated_by, id_business
      ) VALUES (
        :idFile, :idCatFiles, :idPerson, :url, 1, 1, 1, NOW(),
        :createdBy, NOW(), :createdBy, :idBusiness
      )
      ON DUPLICATE KEY UPDATE
        id_cat_files = VALUES(id_cat_files),
        id_person = VALUES(id_person),
        url = VALUES(url),
        active = 1,
        id_business = VALUES(id_business),
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idFile: file.id,
        idCatFiles: catRows[0].id_cat_files,
        idPerson: patient.id,
        url: file.url,
        idBusiness: business.id,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function removeFixtures(transaction = null) {
  const replacements = {
    prefixLike: PREFIX_LIKE,
    businessIds: businessList().map((item) => item.id),
    loginIds: userList().map((item) => item.id),
    personIds: [PATIENT.A.id, PATIENT.B.id],
    appointmentIds: [APPOINTMENT.A.id, APPOINTMENT.B.id],
    historyIds: [CLINICAL_HISTORY.A.id, CLINICAL_HISTORY.B.id],
    prescriptionIds: [PRESCRIPTION.A.id, PRESCRIPTION.B.id],
    documentIds: [DOCUMENT.A.documentId, DOCUMENT.B.documentId],
    templateIds: [DOCUMENT.A.templateId, DOCUMENT.B.templateId],
    templateVersionIds: [DOCUMENT.A.versionId, DOCUMENT.B.versionId],
    fileIds: [FILES.A.id, FILES.B.id],
    doctorProfileIds: [DOCTOR_PROFILE.A, DOCTOR_PROFILE.B],
    noPermissionRoleId: ROLE_NO_PERMISSION.id
  };

  await queryIfTable('document_signature_requests', 'DELETE FROM document_signature_requests WHERE id_patient_document IN (:documentIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('patient_document_signatures', 'DELETE FROM patient_document_signatures WHERE id_patient_document IN (:documentIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('patient_document_events', 'DELETE FROM patient_document_events WHERE id_patient_document IN (:documentIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('patient_documents', 'DELETE FROM patient_documents WHERE id_patient_document IN (:documentIds) OR id_business IN (:businessIds) OR id_person IN (:personIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('document_template_versions', 'DELETE FROM document_template_versions WHERE id_document_template_version IN (:templateVersionIds) OR id_document_template IN (:templateIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('document_templates', 'DELETE FROM document_templates WHERE id_document_template IN (:templateIds) OR id_business IN (:businessIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('prescription_item', 'DELETE FROM prescription_item WHERE id_prescription IN (:prescriptionIds) OR id_business IN (:businessIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('prescription_audit_log', 'DELETE FROM prescription_audit_log WHERE id_prescription IN (:prescriptionIds) OR id_business IN (:businessIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('prescription', 'DELETE FROM prescription WHERE id_prescription IN (:prescriptionIds) OR id_business IN (:businessIds) OR id_person IN (:personIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('clinical_history_events', 'DELETE FROM clinical_history_events WHERE clinical_history_id IN (:historyIds) OR business_id IN (:businessIds) OR patient_id IN (:personIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('clinical_histories', 'DELETE FROM clinical_histories WHERE id_clinical_history IN (:historyIds) OR business_id IN (:businessIds) OR patient_id IN (:personIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('files', 'DELETE FROM files WHERE id_files IN (:fileIds) OR id_business IN (:businessIds) OR id_person IN (:personIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('appointment', 'DELETE FROM appointment WHERE id_appointment IN (:appointmentIds) OR id_business IN (:businessIds) OR id_person IN (:personIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('clinical_module_config', 'DELETE FROM clinical_module_config WHERE id_business IN (:businessIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('doctor_professional_profile', 'DELETE FROM doctor_professional_profile WHERE id_doctor_professional_profile IN (:doctorProfileIds) OR id_login IN (:loginIds) OR id_business IN (:businessIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('allergy', 'DELETE FROM allergy WHERE id_patient IN (:personIds) OR id_business IN (:businessIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('query', 'DELETE FROM `query` WHERE id_person IN (:personIds) OR id_business IN (:businessIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('address', 'DELETE FROM address WHERE id_person IN (:personIds) OR id_business IN (:businessIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('person', 'DELETE FROM person WHERE id_person IN (:personIds) OR id_business IN (:businessIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('session', 'DELETE FROM `session` WHERE id_login IN (:loginIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('refresh_token', 'DELETE FROM refresh_token WHERE id_login IN (:loginIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('login', 'DELETE FROM login WHERE id_login IN (:loginIds) OR telephone LIKE :prefixLike OR email LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('permission_rol', 'DELETE FROM permission_rol WHERE id_rol = :noPermissionRoleId', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('rol', 'DELETE FROM rol WHERE id_rol = :noPermissionRoleId', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('business', 'DELETE FROM business WHERE id_business IN (:businessIds) OR slug LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
}

async function fixtureStatus() {
  const replacements = {
    prefixLike: PREFIX_LIKE,
    businessIds: businessList().map((item) => item.id),
    loginIds: userList().map((item) => item.id),
    personIds: [PATIENT.A.id, PATIENT.B.id]
  };
  const business = await queryIfTable('business', 'SELECT id_business, name, active, subscription_status FROM business WHERE id_business IN (:businessIds)', replacements, QueryTypes.SELECT);
  const users = await queryIfTable('login', 'SELECT id_login, id_business, id_rol, active FROM login WHERE id_login IN (:loginIds)', replacements, QueryTypes.SELECT);
  const patients = await queryIfTable('person', 'SELECT id_person, id_business, name, active FROM person WHERE id_person IN (:personIds)', replacements, QueryTypes.SELECT);
  const counts = {};
  const countQueries = {
    appointment: 'SELECT COUNT(*) AS total FROM appointment WHERE id_business IN (:businessIds)',
    clinical_histories: 'SELECT COUNT(*) AS total FROM clinical_histories WHERE business_id IN (:businessIds)',
    prescription: 'SELECT COUNT(*) AS total FROM prescription WHERE id_business IN (:businessIds)',
    patient_documents: 'SELECT COUNT(*) AS total FROM patient_documents WHERE id_business IN (:businessIds)',
    files: 'SELECT COUNT(*) AS total FROM files WHERE id_business IN (:businessIds)',
    clinical_module_config: 'SELECT COUNT(*) AS total FROM clinical_module_config WHERE id_business IN (:businessIds)'
  };

  for (const tableName of Object.keys(countQueries)) {
    const rows = await queryIfTable(tableName, countQueries[tableName], replacements, QueryTypes.SELECT);
    counts[tableName] = Number(rows[0] ? rows[0].total : 0);
  }

  return { business, users, patients, counts };
}

async function status() {
  return {
    ok: true,
    script: 'security-multitenant-idor-suite',
    mode: 'db fixture + DAO isolation validation',
    database: await currentDatabase(),
    env: {
      allowD2QaDb: process.env.ALLOW_D2_QA_DB === '1',
      allowSecurityIdorFixtures: process.env[WRITE_FLAG] === WRITE_FLAG_VALUE,
      hasQaPassword: Boolean(process.env.QA_AUTH_PASSWORD)
    },
    requiredEnvForWrites: [
      'ALLOW_D2_QA_DB=1',
      `${WRITE_FLAG}=${WRITE_FLAG_VALUE}`,
      'QA_AUTH_PASSWORD'
    ],
    roles: await rolesStatus(),
    fixtures: await fixtureStatus(),
    commands: ['status', 'up', 'validate', 'down', 'full'],
    safeOutput: {
      passwordsPrinted: false,
      accessTokensPrinted: false,
      refreshTokensPrinted: false,
      cookiesPrinted: false,
      csrfPrinted: false
    }
  };
}

async function up() {
  assertWriteAllowed('up');
  await requiredRoles();
  const roles = await rolesStatus();
  const passwordHash = await encript(process.env.QA_AUTH_PASSWORD);
  const transaction = await sequelize.transaction();
  try {
    await removeFixtures(transaction);
    await ensureNoPermissionRole(transaction);
    for (const business of businessList()) {
      await ensureBusiness(business, transaction);
    }
    for (const user of userList()) {
      const roleId = user.role === ROLE_NO_PERMISSION.code
        ? ROLE_NO_PERMISSION.id
        : roles[user.role].id_rol;
      await ensureUser(user, roleId, passwordHash, transaction);
    }
    await ensureDoctorProfile('A', transaction);
    await ensureDoctorProfile('B', transaction);
    await ensurePatient('A', transaction);
    await ensurePatient('B', transaction);
    await ensureAppointment('A', transaction);
    await ensureAppointment('B', transaction);
    await ensureClinicalHistory('A', transaction);
    await ensureClinicalHistory('B', transaction);
    await ensurePrescription('A', transaction);
    await ensurePrescription('B', transaction);
    await ensureDocument('A', transaction);
    await ensureDocument('B', transaction);
    await ensureConfig('A', transaction);
    await ensureConfig('B', transaction);
    await ensureFile('A', transaction);
    await ensureFile('B', transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return {
    ok: true,
    fixtures: await fixtureStatus(),
    password: 'use QA_AUTH_PASSWORD from local env',
    cleanup: 'node scripts/qa/security-multitenant-idor-suite.js down'
  };
}

function containsMarker(value, marker) {
  return JSON.stringify(value || {}).indexOf(marker) !== -1;
}

function successWithData(response) {
  return response && Number(response.status) === 200 && response.data !== null && response.data !== undefined;
}

async function scalar(sql, replacements) {
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  return rows[0] || null;
}

function invokeTenantMiddleware(reqOverrides) {
  return new Promise((resolve, reject) => {
    const req = Object.assign({
      method: 'GET',
      baseUrl: '/api/px',
      path: '/get/qa',
      url: '/get/qa',
      get() {
        return null;
      },
      tokenDecode: {
        id_login: USERS.superAdmin.id,
        id_business: BUSINESS.A.id,
        rol: 'super_admin'
      }
    }, reqOverrides || {});

    const res = {
      statusCode: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(payload) {
        resolve({ nextCalled: false, status: this.statusCode, payload });
      }
    };

    requireTenantOperational(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ nextCalled: true, status: null, payload: null });
    });
  });
}

async function validate() {
  const current = await fixtureStatus();
  const checks = [];
  const addCheck = (name, ok, evidence) => {
    checks.push({ name, ok: Boolean(ok), evidence });
  };

  addCheck('fixtures A/B exist', current.business.length === 2 && current.patients.length === 2, current);

  const patientCross = await PxDao.getPxById(PATIENT.B.id, BUSINESS.A.id);
  addCheck('IDOR patient B by user A returns no B data', !containsMarker(patientCross, MARKER_B) && !successWithData(patientCross), {
    status: patientCross.status,
    leakedMarker: containsMarker(patientCross, MARKER_B)
  });

  const filesCross = await FilesDao.getfiles(PATIENT.B.id, BUSINESS.A.id);
  addCheck('IDOR files for patient B by user A returns 404/no B data', !containsMarker(filesCross, MARKER_B) && !successWithData(filesCross), {
    status: filesCross.status,
    leakedMarker: containsMarker(filesCross, MARKER_B)
  });

  const appointmentListCross = await AppointmentDao.list({
    id_person: PATIENT.B.id,
    date_from: '2000-01-01',
    date_to: '2100-01-01',
    id_business: BUSINESS.A.id
  });
  addCheck('IDOR appointment list with patient B under business A leaks no B data', !containsMarker(appointmentListCross, MARKER_B), {
    status: appointmentListCross.status,
    leakedMarker: containsMarker(appointmentListCross, MARKER_B)
  });

  await AppointmentDao.delete({
    id_appointment: APPOINTMENT.B.id,
    id_login: USERS.adminA.id,
    id_business: BUSINESS.A.id
  });
  const appointmentB = await scalar('SELECT active FROM appointment WHERE id_appointment = :id', { id: APPOINTMENT.B.id });
  addCheck('IDOR appointment delete B with business A does not modify B', appointmentB && Number(appointmentB.active) === 1, appointmentB);

  const historyCross = await ClinicalHistoryDao.getById({
    id_clinical_history: CLINICAL_HISTORY.B.id,
    id_login: USERS.adminA.id,
    id_business: BUSINESS.A.id
  });
  addCheck('IDOR clinical history B by user A returns no B data', !containsMarker(historyCross, MARKER_B) && !successWithData(historyCross), {
    status: historyCross.status,
    leakedMarker: containsMarker(historyCross, MARKER_B)
  });

  const prescriptionCross = await PrescriptionDao.getById({
    id_prescription: PRESCRIPTION.B.id,
    id_login: USERS.adminA.id,
    id_business: BUSINESS.A.id
  });
  addCheck('IDOR prescription B by user A returns no B data', !containsMarker(prescriptionCross, MARKER_B) && !successWithData(prescriptionCross), {
    status: prescriptionCross.status,
    leakedMarker: containsMarker(prescriptionCross, MARKER_B)
  });

  const documentCross = await DocumentDao.listPatientDocuments({
    id_person: PATIENT.B.id,
    id_login: USERS.adminA.id,
    id_business: BUSINESS.A.id
  });
  addCheck('IDOR documents for patient B by user A leak no B data', !containsMarker(documentCross, MARKER_B), {
    status: documentCross.status,
    leakedMarker: containsMarker(documentCross, MARKER_B)
  });

  await DocumentDao.updateStatus({
    id_patient_document: DOCUMENT.B.documentId,
    id_login: USERS.adminA.id,
    id_business: BUSINESS.A.id
  }, 'CANCELADO', 'CANCELLED', 'QA cross-tenant cancel attempt');
  const documentB = await scalar('SELECT status, active FROM patient_documents WHERE id_patient_document = :id', { id: DOCUMENT.B.documentId });
  addCheck('IDOR document status B with business A does not modify B', documentB && documentB.status === 'BORRADOR' && Number(documentB.active) === 1, documentB);

  const configA = await scalar('SELECT id_business FROM clinical_module_config WHERE id_business = :id', { id: BUSINESS.A.id });
  const configBCross = await scalar('SELECT id_business FROM clinical_module_config WHERE id_business = :id', { id: BUSINESS.B.id });
  addCheck('clinical config fixtures exist per business for IDOR coverage', Boolean(configA && configBCross), { configA, configBCross });

  const superAdminRoutes = [
    ['/api/px', `/get/${PATIENT.B.id}`],
    ['/api/clinical-history', `/patient/${PATIENT.B.id}`],
    ['/api/prescription', `/patient/${PATIENT.B.id}`],
    ['/api/document', `/patient/${PATIENT.B.id}`],
    ['/api/appointment', '/list'],
    ['/api/file', `/px/file/${PATIENT.B.id}`],
    ['/api/config', '/clinical-modules/get']
  ];
  for (const route of superAdminRoutes) {
    const result = await invokeTenantMiddleware({ baseUrl: route[0], path: route[1], url: route[1] });
    addCheck(`super_admin receives 403 on ${route[0]}${route[1]}`, result.status === 403 && result.payload && result.payload.code === 'SUPER_ADMIN_PHI_FORBIDDEN', {
      status: result.status,
      code: result.payload ? result.payload.code : null
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    safeOutput: {
      passwordsPrinted: false,
      accessTokensPrinted: false,
      refreshTokensPrinted: false,
      cookiesPrinted: false,
      csrfPrinted: false
    }
  };
}

async function down() {
  assertWriteAllowed('down');
  const transaction = await sequelize.transaction();
  try {
    await removeFixtures(transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  const remaining = await fixtureStatus();
  const totalRemaining = remaining.business.length +
    remaining.users.length +
    remaining.patients.length +
    Object.keys(remaining.counts).reduce((sum, key) => sum + Number(remaining.counts[key] || 0), 0);

  return {
    ok: totalRemaining === 0,
    remaining
  };
}

async function full() {
  assertWriteAllowed('full');
  const steps = [];
  let upCompleted = false;
  try {
    steps.push({ step: 'status-before', result: await status() });
    steps.push({ step: 'up', result: await up() });
    upCompleted = true;
    steps.push({ step: 'validate', result: await validate() });
  } finally {
    if (upCompleted) {
      steps.push({ step: 'down', result: await down() });
    }
    steps.push({ step: 'status-after', result: await status() });
  }

  return {
    ok: steps.every((step) => step.result && step.result.ok !== false),
    steps
  };
}

async function main() {
  const command = process.argv[2] || 'status';
  const commands = { status, up, validate, down, full };

  if (!commands[command]) {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.stderr.write('Usage: node scripts/qa/security-multitenant-idor-suite.js [status|up|validate|down|full]\n');
    process.exitCode = 2;
    return;
  }

  try {
    const result = await commands[command]();
    const output = {
      command,
      ok: result && result.ok !== false,
      result
    };
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    const output = {
      command,
      ok: false,
      error: error.message,
      code: error.code || null,
      safeOutput: {
        passwordsPrinted: false,
        accessTokensPrinted: false,
        refreshTokensPrinted: false,
        cookiesPrinted: false,
        csrfPrinted: false
      }
    };
    console.error(JSON.stringify(output, null, 2));
    process.exitCode = error.code === 'QA_WRITE_FLAGS_REQUIRED' ? 2 : 1;
  } finally {
    await sequelize.close();
  }
}

main();
