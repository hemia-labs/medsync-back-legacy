#!/usr/bin/env node
'use strict';

require('../../src/config/env');

const { QueryTypes } = require('sequelize');
const sequelize = require('../../src/db/Sequelize.connection');
const SecurityConfig = require('../../src/config/security');
const { encript } = require('../../src/util/bcrypt');

const PREFIX = 'QA_D2_BROWSER_';
const PREFIX_LIKE = `${PREFIX}%`;
const CREATED_BY = 'QA_D2_BROWSER_FIXTURES';

const BUSINESS = {
  active: {
    id: 'QA_D2_BROWSER_ACTIVE_BUSINESS',
    name: 'QA_D2_BROWSER_ACTIVE_BUSINESS',
    slug: 'qa-d2-browser-active-business',
    email: 'qa.d2.browser.active.business@example.test',
    phone: '9994000000',
    status: 'active',
    subscriptionStatus: 'active',
    suspended: false
  },
  restricted: {
    id: 'QA_D2_BROWSER_RESTRICTED_BUSINESS',
    name: 'QA_D2_BROWSER_RESTRICTED_BUSINESS',
    slug: 'qa-d2-browser-restricted-business',
    email: 'qa.d2.browser.restricted.business@example.test',
    phone: '9994000090',
    status: 'suspended',
    subscriptionStatus: 'suspended',
    suspended: true
  }
};

const USERS = {
  admin: {
    id: 'QA_D2_BROWSER_ADMIN_USER',
    name: 'QA_D2_BROWSER_ADMIN_USER',
    email: 'qa.d2.browser.admin@example.test',
    phone: '9994000001',
    roleCode: 'admin',
    business: 'active',
    active: 1,
    locked: 0
  },
  doctor: {
    id: 'QA_D2_BROWSER_DOCTOR_USER',
    name: 'QA_D2_BROWSER_DOCTOR_USER',
    email: 'qa.d2.browser.doctor@example.test',
    phone: '9994000002',
    roleCode: 'doctor',
    business: 'active',
    active: 1,
    locked: 0
  },
  assistant: {
    id: 'QA_D2_BROWSER_ASSISTANT_USER',
    name: 'QA_D2_BROWSER_ASSISTANT_USER',
    email: 'qa.d2.browser.assistant@example.test',
    phone: '9994000003',
    roleCode: 'assistant',
    business: 'active',
    active: 1,
    locked: 0
  },
  reception: {
    id: 'QA_D2_BROWSER_RECEPTION_USER',
    name: 'QA_D2_BROWSER_RECEPTION_USER',
    email: 'qa.d2.browser.reception@example.test',
    phone: '9994000004',
    roleCode: 'reception',
    business: 'active',
    active: 1,
    locked: 0
  },
  restrictedAdmin: {
    id: 'QA_D2_BROWSER_RESTRICTED_ADMIN_USER',
    name: 'QA_D2_BROWSER_RESTRICTED_ADMIN_USER',
    email: 'qa.d2.browser.restricted.admin@example.test',
    phone: '9994000091',
    roleCode: 'admin',
    business: 'restricted',
    active: 1,
    locked: 0
  },
  inactive: {
    id: 'QA_D2_BROWSER_INACTIVE_USER',
    name: 'QA_D2_BROWSER_INACTIVE_USER',
    email: 'qa.d2.browser.inactive@example.test',
    phone: '9994000092',
    roleCode: 'admin',
    business: 'active',
    active: 0,
    locked: 1
  },
  superAdmin: {
    id: 'QA_D2_BROWSER_SUPER_ADMIN_USER',
    name: 'QA_D2_BROWSER_SUPER_ADMIN_USER',
    email: 'qa.d2.browser.superadmin@example.test',
    phone: '9994000099',
    roleCode: 'super_admin',
    business: null,
    active: 1,
    locked: 0
  }
};

const PATIENT = {
  id: 'QA_D2_BROWSER_PATIENT',
  code: 'D2BQA001',
  name: 'QA_D2_BROWSER_PATIENT',
  surname: 'FICTITIOUS',
  phone: '9994000101',
  age: 30,
  addressId: 'QA_D2_BROWSER_PATIENT_ADDRESS',
  queryId: 'QA_D2_BROWSER_PATIENT_QUERY',
  allergyId: 'QA_D2_BROWSER_PATIENT_ALLERGY'
};

const DOCTOR_PROFILE = {
  id: 'QA_D2_BROWSER_DOCTOR_PROFILE',
  license: 'QA-D2-BROWSER-LICENSE-NOT-REAL'
};

const CLINICAL_HISTORY = {
  id: 'QA_D2_BROWSER_CLINICAL_HISTORY'
};

const DOCUMENT = {
  templateId: 'QA_D2_BROWSER_DOCUMENT_TEMPLATE',
  templateVersionId: 'QA_D2_BROWSER_DOCUMENT_TEMPLATE_V1',
  documentId: 'QA_D2_BROWSER_PATIENT_DOCUMENT'
};

const TREATMENT = {
  planId: 'QA_D2_BROWSER_TREATMENT_PLAN',
  treatmentId: 'QA_D2_BROWSER_PATIENT_TREATMENT'
};

const REQUIRED_TABLES = [
  'business',
  'rol',
  'login',
  'person',
  'address',
  'query',
  'allergy',
  'doctor_professional_profile',
  'clinical_histories',
  'document_templates',
  'document_template_versions',
  'patient_documents',
  'treatment_plan',
  'patient_treatment',
  'session',
  'refresh_token'
];

const OPTIONAL_CLEANUP_TABLES = [
  'auth_password_change_tokens',
  'auth_password_reset_tokens',
  'clinical_history_events',
  'patient_document_events',
  'patient_document_signatures',
  'document_signature_requests',
  'treatment_plan_consent',
  'patient_treatment_tooth'
];

const userList = () => Object.values(USERS);
const userIds = () => userList().map((user) => user.id);
const userPhones = () => userList().map((user) => user.phone);
const businessIds = () => Object.values(BUSINESS).map((business) => business.id);
const patientIds = () => [PATIENT.id];
const documentIds = () => [DOCUMENT.documentId];
const templateIds = () => [DOCUMENT.templateId];
const templateVersionIds = () => [DOCUMENT.templateVersionId];
const clinicalHistoryIds = () => [CLINICAL_HISTORY.id];
const treatmentPlanIds = () => [TREATMENT.planId];
const treatmentIds = () => [TREATMENT.treatmentId];

const tableCache = new Map();

async function tableExists(tableName) {
  if (tableCache.has(tableName)) {
    return tableCache.get(tableName);
  }

  const rows = await sequelize.query(
    `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = :tableName`,
    { replacements: { tableName }, type: QueryTypes.SELECT }
  );
  const exists = Number(rows[0] ? rows[0].total : 0) > 0;
  tableCache.set(tableName, exists);
  return exists;
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

async function requireTables() {
  const missing = [];
  for (const tableName of REQUIRED_TABLES) {
    if (!(await tableExists(tableName))) {
      missing.push(tableName);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Faltan tablas requeridas para D2-7A: ${missing.join(', ')}.`);
  }
}

async function dbIdentity() {
  try {
    const rows = await sequelize.query(
      'SELECT DATABASE() AS database_name, @@hostname AS database_host, @@port AS database_port',
      { type: QueryTypes.SELECT }
    );
    return rows[0] || {};
  } catch (error) {
    return {
      database_name: null,
      database_host: null,
      database_port: null,
      lookup_error: error.message
    };
  }
}

function looksProductionLikeDatabase(identity) {
  const value = `${identity.database_name || ''} ${identity.database_host || ''}`.toLowerCase();
  return /\b(prod|production|live)\b/.test(value) ||
    value.indexOf('prod_') !== -1 ||
    value.indexOf('_prod') !== -1;
}

async function assertNotProductionLike() {
  const identity = await dbIdentity();
  const productionLike = SecurityConfig.isProductionLike() || looksProductionLikeDatabase(identity);
  const override = process.env.ALLOW_D2_QA_PRODUCTION_LIKE === 'I_UNDERSTAND_RISK';

  if (productionLike && !override) {
    throw new Error('Abortado: ambiente production-like detectado. Requiere ALLOW_D2_QA_PRODUCTION_LIKE=I_UNDERSTAND_RISK.');
  }
}

function missingEnv(options = {}) {
  const missing = [];
  if (process.env.ALLOW_D2_QA_DB !== '1') missing.push('ALLOW_D2_QA_DB=1');
  if (process.env.ALLOW_D2_BROWSER_QA_FIXTURES !== '1') missing.push('ALLOW_D2_BROWSER_QA_FIXTURES=1');
  if (options.requirePassword && !process.env.QA_AUTH_PASSWORD) missing.push('QA_AUTH_PASSWORD');
  return missing;
}

async function assertSafeCommand(command, options = {}) {
  await assertNotProductionLike();
  const missing = missingEnv(options);
  if (missing.length > 0) {
    throw new Error(`${command} requiere variables QA: ${missing.join(', ')}.`);
  }
}

async function roleByCode(code) {
  const rows = await sequelize.query(
    `SELECT id_rol, code, desc_rol
       FROM rol
      WHERE code COLLATE utf8mb4_unicode_ci = :code COLLATE utf8mb4_unicode_ci
        AND active = 1
      LIMIT 1`,
    { replacements: { code }, type: QueryTypes.SELECT }
  );
  return rows[0] || null;
}

async function requiredRoles() {
  const codes = Array.from(new Set(userList().map((user) => user.roleCode)));
  const roles = {};
  for (const code of codes) {
    roles[code] = await roleByCode(code);
    if (!roles[code]) {
      throw new Error(`No se encontro rol activo requerido para D2-7A: ${code}.`);
    }
  }
  return roles;
}

async function ensureBusiness(business, transaction) {
  await sequelize.query(
    `INSERT INTO business (
        id_business, name, legal_name, slug, email, phone, address, status, plan, active,
        subscription_status, current_period_starts_at, current_period_ends_at,
        suspended_at, status_reason, created_at, created_by
      ) VALUES (
        :id, :name, :name, :slug, :email, :phone, 'QA D2 browser fixture. No real data.',
        :status, 'enterprise', 1, :subscriptionStatus, NOW(), NULL,
        CASE WHEN :suspended = 1 THEN NOW() ELSE NULL END,
        CASE WHEN :suspended = 1 THEN 'QA_D2_BROWSER restricted tenant fixture' ELSE NULL END,
        NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        legal_name = VALUES(legal_name),
        email = VALUES(email),
        phone = VALUES(phone),
        status = VALUES(status),
        plan = 'enterprise',
        active = 1,
        subscription_status = VALUES(subscription_status),
        current_period_starts_at = NOW(),
        current_period_ends_at = NULL,
        suspended_at = VALUES(suspended_at),
        status_reason = VALUES(status_reason),
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        id: business.id,
        name: business.name,
        slug: business.slug,
        email: business.email,
        phone: business.phone,
        status: business.status,
        subscriptionStatus: business.subscriptionStatus,
        suspended: business.suspended ? 1 : 0,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureUser(user, role, passwordHash, transaction) {
  const business = user.business ? BUSINESS[user.business] : null;
  await sequelize.query(
    `INSERT INTO login (
        id_login, id_business, id_rol, name, email, telephone, password, locked,
        active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :id, :businessId, :roleId, :name, :email, :phone, :password, :locked,
        :active, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_rol = VALUES(id_rol),
        name = VALUES(name),
        email = VALUES(email),
        telephone = VALUES(telephone),
        password = VALUES(password),
        locked = VALUES(locked),
        active = VALUES(active),
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        id: user.id,
        businessId: business ? business.id : null,
        roleId: role.id_rol,
        name: user.name,
        email: user.email,
        phone: user.phone,
        password: passwordHash,
        locked: user.locked,
        active: user.active,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureDoctorProfile(transaction) {
  await sequelize.query(
    `INSERT INTO doctor_professional_profile (
        id_doctor_professional_profile, id_business, id_login, professional_name,
        professional_license, university, specialty, specialty_license,
        professional_phone, can_issue_prescriptions, can_sign_documents,
        is_active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :profileId, :businessId, :loginId, :professionalName,
        :license, 'QA University Not Real', 'QA Specialty Not Real', 'QA-SPECIALTY-NOT-REAL',
        :phone, 1, 1, 1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_login = VALUES(id_login),
        professional_name = VALUES(professional_name),
        professional_license = VALUES(professional_license),
        university = VALUES(university),
        specialty = VALUES(specialty),
        specialty_license = VALUES(specialty_license),
        professional_phone = VALUES(professional_phone),
        can_issue_prescriptions = 1,
        can_sign_documents = 1,
        is_active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        profileId: DOCTOR_PROFILE.id,
        businessId: BUSINESS.active.id,
        loginId: USERS.doctor.id,
        professionalName: USERS.doctor.name,
        license: DOCTOR_PROFILE.license,
        phone: USERS.doctor.phone,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensurePatient(transaction) {
  await sequelize.query(
    `INSERT INTO person (
        id_person, id_business, code, name, surname, birthday, age, ocupation, rfc,
        local_telephone, telephone, active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :idPerson, :idBusiness, :code, :name, :surname, '1996-01-01', :age, 'QA fixture', NULL,
        :phone, :phone, 1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        code = VALUES(code),
        name = VALUES(name),
        surname = VALUES(surname),
        age = VALUES(age),
        local_telephone = VALUES(local_telephone),
        telephone = VALUES(telephone),
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idPerson: PATIENT.id,
        idBusiness: BUSINESS.active.id,
        code: PATIENT.code,
        name: PATIENT.name,
        surname: PATIENT.surname,
        age: PATIENT.age,
        phone: PATIENT.phone,
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
        :idAddress, :idBusiness, :idPerson, 'QA', 'QA', 'QA fixture address', '00000',
        1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_person = VALUES(id_person),
        place_birth = VALUES(place_birth),
        residence = VALUES(residence),
        direction = VALUES(direction),
        cp = VALUES(cp),
        last = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idAddress: PATIENT.addressId,
        idBusiness: BUSINESS.active.id,
        idPerson: PATIENT.id,
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
        :idQuery, :idBusiness, :idPerson, 'QA fixture consultation', 'QA fictitious condition',
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
        idQuery: PATIENT.queryId,
        idBusiness: BUSINESS.active.id,
        idPerson: PATIENT.id,
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
        has_allergy = 0,
        description = NULL,
        active = 1,
        is_active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idAllergy: PATIENT.allergyId,
        idBusiness: BUSINESS.active.id,
        idPerson: PATIENT.id,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureClinicalHistory(transaction) {
  const snapshot = JSON.stringify({
    qa: true,
    prefix: PREFIX,
    note: 'Fictitious D2 browser QA clinical history draft.'
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
        updated_by_user_id = VALUES(updated_by_user_id),
        status = 'DRAFT',
        template_snapshot_json = VALUES(template_snapshot_json),
        clinical_snapshot_json = VALUES(clinical_snapshot_json),
        deleted_at = NULL,
        updated_at = NOW()`,
    {
      replacements: {
        historyId: CLINICAL_HISTORY.id,
        businessId: BUSINESS.active.id,
        patientId: PATIENT.id,
        doctorProfileId: DOCTOR_PROFILE.id,
        doctorUserId: USERS.doctor.id,
        snapshot
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureDocumentFixture(transaction) {
  const html = '<p>QA D2 browser fixture document. No real clinical data.</p>';
  await sequelize.query(
    `INSERT INTO document_templates (
        id_document_template, id_business, template_type, license_category, template_subtype,
        is_premium, clinical_legal_safe, minimum_plan, block_mode, licensing_review_required,
        licensing_notes, name, description, requires_patient_signature, requires_tutor_signature,
        requires_doctor_signature, requires_witness1_signature, requires_witness2_signature,
        is_active, active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :templateId, :businessId, 'CUSTOM_DOCUMENT', 'standard_document_template', 'qa_d2_browser',
        0, 1, NULL, NULL, 0,
        'QA D2 browser fixture. No real clinical data.', 'QA_D2_BROWSER_DOCUMENT_TEMPLATE',
        'QA fixture for browser document runtime checks.', 1, 0,
        1, 0, 0, 1, 1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        name = VALUES(name),
        description = VALUES(description),
        requires_patient_signature = VALUES(requires_patient_signature),
        requires_doctor_signature = VALUES(requires_doctor_signature),
        is_active = 1,
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        templateId: DOCUMENT.templateId,
        businessId: BUSINESS.active.id,
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
        versionId: DOCUMENT.templateVersionId,
        templateId: DOCUMENT.templateId,
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
        title, content_html_snapshot, signed_content_html_snapshot, responsible_doctor_user_id,
        responsible_doctor_profile_id, doctor_name_snapshot, professional_license_snapshot,
        clinical_history_id, active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :documentId, :businessId, :patientId, :templateId,
        :versionId, 1, 'CUSTOM_DOCUMENT', 'DOCUMENT_CENTER', 'BORRADOR',
        'QA_D2_BROWSER_PATIENT_DOCUMENT', :html, NULL, :doctorUserId,
        :doctorProfileId, :doctorName, :license,
        :historyId, 1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_person = VALUES(id_person),
        id_document_template = VALUES(id_document_template),
        id_document_template_version = VALUES(id_document_template_version),
        template_version_number = 1,
        document_type = 'CUSTOM_DOCUMENT',
        origin = 'DOCUMENT_CENTER',
        status = 'BORRADOR',
        title = VALUES(title),
        content_html_snapshot = VALUES(content_html_snapshot),
        signed_content_html_snapshot = NULL,
        responsible_doctor_user_id = VALUES(responsible_doctor_user_id),
        responsible_doctor_profile_id = VALUES(responsible_doctor_profile_id),
        doctor_name_snapshot = VALUES(doctor_name_snapshot),
        professional_license_snapshot = VALUES(professional_license_snapshot),
        clinical_history_id = VALUES(clinical_history_id),
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        documentId: DOCUMENT.documentId,
        businessId: BUSINESS.active.id,
        patientId: PATIENT.id,
        templateId: DOCUMENT.templateId,
        versionId: DOCUMENT.templateVersionId,
        html,
        doctorUserId: USERS.doctor.id,
        doctorProfileId: DOCTOR_PROFILE.id,
        doctorName: USERS.doctor.name,
        license: DOCTOR_PROFILE.license,
        historyId: CLINICAL_HISTORY.id,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureTreatmentFixture(transaction) {
  await sequelize.query(
    `INSERT INTO treatment_plan (
        id_treatment_plan, id_business, id_person, title, diagnosis, notes, status,
        started_at, active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :planId, :businessId, :patientId, 'QA_D2_BROWSER_TREATMENT_PLAN',
        'QA fictitious diagnosis', 'QA fixture. No real clinical data.', 'active',
        CURRENT_DATE(), 1, NOW(), :doctorUserId, NOW(), :doctorUserId
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_person = VALUES(id_person),
        title = VALUES(title),
        diagnosis = VALUES(diagnosis),
        notes = VALUES(notes),
        status = 'active',
        active = 1,
        updated_at = NOW(),
        updated_by = :doctorUserId`,
    {
      replacements: {
        planId: TREATMENT.planId,
        businessId: BUSINESS.active.id,
        patientId: PATIENT.id,
        doctorUserId: USERS.doctor.id
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  await sequelize.query(
    `INSERT INTO patient_treatment (
        id_patient_treatment, id_business, id_person, id_treatment_plan, name,
        description, category, status, priority, cost, notes, source, active,
        created_at, created_by, updated_at, updated_by
      ) VALUES (
        :treatmentId, :businessId, :patientId, :planId, 'QA_D2_BROWSER_PATIENT_TREATMENT',
        'QA fictitious treatment item.', 'QA', 'pending', 'low', 0.00,
        'QA fixture. No real clinical data.', 'manual', 1,
        NOW(), :doctorUserId, NOW(), :doctorUserId
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_person = VALUES(id_person),
        id_treatment_plan = VALUES(id_treatment_plan),
        name = VALUES(name),
        description = VALUES(description),
        category = VALUES(category),
        status = 'pending',
        priority = VALUES(priority),
        cost = VALUES(cost),
        notes = VALUES(notes),
        active = 1,
        updated_at = NOW(),
        updated_by = :doctorUserId`,
    {
      replacements: {
        treatmentId: TREATMENT.treatmentId,
        businessId: BUSINESS.active.id,
        patientId: PATIENT.id,
        planId: TREATMENT.planId,
        doctorUserId: USERS.doctor.id
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function removeFixtures(transaction = null) {
  const replacements = {
    prefixLike: PREFIX_LIKE,
    businessIds: businessIds(),
    loginIds: userIds(),
    phones: userPhones(),
    personIds: patientIds(),
    documentIds: documentIds(),
    templateIds: templateIds(),
    templateVersionIds: templateVersionIds(),
    clinicalHistoryIds: clinicalHistoryIds(),
    treatmentPlanIds: treatmentPlanIds(),
    treatmentIds: treatmentIds(),
    doctorProfileId: DOCTOR_PROFILE.id
  };

  await queryIfTable(
    'document_signature_requests',
    `DELETE FROM document_signature_requests
      WHERE id_business IN (:businessIds)
         OR id_person IN (:personIds)
         OR id_patient_document IN (:documentIds)
         OR id_document_signature_request LIKE :prefixLike`,
    replacements,
    QueryTypes.DELETE,
    transaction
  );
  await queryIfTable('patient_document_events', 'DELETE FROM patient_document_events WHERE id_business IN (:businessIds) OR id_patient_document IN (:documentIds) OR id_patient_document_event LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('patient_document_signatures', 'DELETE FROM patient_document_signatures WHERE id_business IN (:businessIds) OR id_patient_document IN (:documentIds) OR id_patient_document_signature LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('clinical_history_events', 'DELETE FROM clinical_history_events WHERE clinical_history_id IN (:clinicalHistoryIds) OR id_clinical_history_event LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('treatment_plan_consent', 'DELETE FROM treatment_plan_consent WHERE id_treatment_plan IN (:treatmentPlanIds) OR id_person IN (:personIds) OR id_treatment_plan_consent LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('patient_treatment_tooth', 'DELETE FROM patient_treatment_tooth WHERE id_patient_treatment IN (:treatmentIds) OR id_patient_treatment_tooth LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('patient_treatment', 'DELETE FROM patient_treatment WHERE id_patient_treatment IN (:treatmentIds) OR id_business IN (:businessIds) OR id_person IN (:personIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('treatment_plan', 'DELETE FROM treatment_plan WHERE id_treatment_plan IN (:treatmentPlanIds) OR id_business IN (:businessIds) OR id_person IN (:personIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('clinical_histories', 'DELETE FROM clinical_histories WHERE id_clinical_history IN (:clinicalHistoryIds) OR business_id IN (:businessIds) OR patient_id IN (:personIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('patient_documents', 'DELETE FROM patient_documents WHERE id_patient_document IN (:documentIds) OR id_business IN (:businessIds) OR id_person IN (:personIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('document_template_versions', 'DELETE FROM document_template_versions WHERE id_document_template_version IN (:templateVersionIds) OR id_document_template IN (:templateIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('document_templates', 'DELETE FROM document_templates WHERE id_document_template IN (:templateIds) OR id_business IN (:businessIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('allergy', 'DELETE FROM allergy WHERE id_patient IN (:personIds) OR id_allergy LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('query', 'DELETE FROM `query` WHERE id_person IN (:personIds) OR id_query LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('address', 'DELETE FROM address WHERE id_person IN (:personIds) OR id_address LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('person', 'DELETE FROM person WHERE id_person IN (:personIds) OR id_person LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('auth_password_change_tokens', 'DELETE FROM auth_password_change_tokens WHERE id_login IN (:loginIds) OR id_login LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('auth_password_reset_tokens', 'DELETE FROM auth_password_reset_tokens WHERE id_login IN (:loginIds) OR phone_normalized IN (:phones)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('refresh_token', 'DELETE FROM refresh_token WHERE id_login IN (:loginIds) OR id_login LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('session', 'DELETE FROM `session` WHERE id_login IN (:loginIds) OR id_login LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('doctor_professional_profile', 'DELETE FROM doctor_professional_profile WHERE id_doctor_professional_profile = :doctorProfileId OR id_login IN (:loginIds)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('login', 'DELETE FROM login WHERE id_login IN (:loginIds) OR id_login LIKE :prefixLike OR telephone IN (:phones)', replacements, QueryTypes.DELETE, transaction);
  await queryIfTable('business', 'DELETE FROM business WHERE id_business IN (:businessIds) OR id_business LIKE :prefixLike', replacements, QueryTypes.DELETE, transaction);
}

async function countRows(tableName, whereSql, replacements) {
  if (!(await tableExists(tableName))) {
    return 0;
  }

  const rows = await sequelize.query(
    `SELECT COUNT(*) AS total FROM ${tableName} ${whereSql}`,
    { replacements, type: QueryTypes.SELECT }
  );
  return Number(rows[0] ? rows[0].total : 0);
}

async function fixtureStatus() {
  const replacements = {
    prefixLike: PREFIX_LIKE,
    loginIds: userIds(),
    businessIds: businessIds(),
    personIds: patientIds(),
    clinicalHistoryIds: clinicalHistoryIds(),
    documentIds: documentIds(),
    treatmentPlanIds: treatmentPlanIds(),
    treatmentIds: treatmentIds()
  };

  const [businessRows, userRows, patientRows] = await Promise.all([
    sequelize.query(
      `SELECT id_business, name, status, active, subscription_status
         FROM business
        WHERE id_business LIKE :prefixLike
        ORDER BY id_business`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT l.id_login, l.email, l.telephone, l.active, l.locked, r.code AS role_code, l.id_business
         FROM login l
         INNER JOIN rol r ON r.id_rol = l.id_rol
        WHERE l.id_login LIKE :prefixLike
        ORDER BY l.id_login`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT id_person, id_business, code, name, surname, active
         FROM person
        WHERE id_person LIKE :prefixLike
        ORDER BY id_person`,
      { replacements, type: QueryTypes.SELECT }
    )
  ]);

  return {
    business: businessRows,
    users: userRows,
    patients: patientRows,
    clinicalHistoryCount: await countRows('clinical_histories', 'WHERE id_clinical_history IN (:clinicalHistoryIds) OR business_id IN (:businessIds) OR patient_id IN (:personIds)', replacements),
    documentCount: await countRows('patient_documents', 'WHERE id_patient_document IN (:documentIds) OR id_business IN (:businessIds) OR id_person IN (:personIds)', replacements),
    treatmentPlanCount: await countRows('treatment_plan', 'WHERE id_treatment_plan IN (:treatmentPlanIds) OR id_business IN (:businessIds) OR id_person IN (:personIds)', replacements),
    patientTreatmentCount: await countRows('patient_treatment', 'WHERE id_patient_treatment IN (:treatmentIds) OR id_business IN (:businessIds) OR id_person IN (:personIds)', replacements),
    sessionCount: await countRows('`session`', 'WHERE id_login IN (:loginIds) OR id_login LIKE :prefixLike', replacements),
    refreshTokenCount: await countRows('refresh_token', 'WHERE id_login IN (:loginIds) OR id_login LIKE :prefixLike', replacements)
  };
}

async function status() {
  const identity = await dbIdentity();
  const roles = {};
  for (const code of Array.from(new Set(userList().map((user) => user.roleCode)))) {
    const role = await roleByCode(code);
    roles[code] = {
      found: Boolean(role),
      id_rol: role ? role.id_rol : null
    };
  }

  const tables = {};
  for (const tableName of REQUIRED_TABLES.concat(OPTIONAL_CLEANUP_TABLES)) {
    tables[tableName] = await tableExists(tableName);
  }

  return {
    ok: true,
    script: 'd2-browser-qa-fixtures',
    phase: 'D2-7A QA Fixture Provisioning for Browser / Runtime QA',
    repo: 'hemia-assistance-back-legacy',
    mode: 'db fixture provisioning',
    database: {
      name: identity.database_name || null,
      host: identity.database_host || null,
      port: identity.database_port || null,
      productionLikeNameOrHost: looksProductionLikeDatabase(identity)
    },
    env: {
      allowD2QaDb: process.env.ALLOW_D2_QA_DB === '1',
      allowD2BrowserQaFixtures: process.env.ALLOW_D2_BROWSER_QA_FIXTURES === '1',
      hasQaPassword: Boolean(process.env.QA_AUTH_PASSWORD),
      productionLike: SecurityConfig.isProductionLike()
    },
    requiredEnv: [
      'ALLOW_D2_QA_DB=1',
      'ALLOW_D2_BROWSER_QA_FIXTURES=1',
      'QA_AUTH_PASSWORD for up/full/hold'
    ],
    roles,
    tables,
    fixtures: await fixtureStatus(),
    commands: ['status', 'up', 'validate', 'down', 'full', 'hold'],
    safeOutput: {
      passwordsPrinted: false,
      otpPrinted: false,
      accessTokensPrinted: false,
      refreshTokensPrinted: false,
      cookiesPrinted: false,
      csrfPrinted: false
    }
  };
}

async function up() {
  await assertSafeCommand('up', { requirePassword: true });
  await requireTables();
  const roles = await requiredRoles();
  const passwordHash = await encript(process.env.QA_AUTH_PASSWORD);
  const transaction = await sequelize.transaction();

  try {
    await removeFixtures(transaction);
    for (const business of Object.values(BUSINESS)) {
      await ensureBusiness(business, transaction);
    }
    for (const user of userList()) {
      await ensureUser(user, roles[user.roleCode], passwordHash, transaction);
    }
    await ensureDoctorProfile(transaction);
    await ensurePatient(transaction);
    await ensureClinicalHistory(transaction);
    await ensureDocumentFixture(transaction);
    await ensureTreatmentFixture(transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return {
    ok: true,
    createdBy: CREATED_BY,
    fixtures: browserQaSummary(),
    password: 'use QA_AUTH_PASSWORD from your local env',
    cleanup: 'node scripts/qa/d2-browser-qa-fixtures.js down'
  };
}

async function validate() {
  await assertSafeCommand('validate');
  await requireTables();
  const current = await fixtureStatus();
  const userById = new Map(current.users.map((user) => [user.id_login, user]));
  const businessById = new Map(current.business.map((business) => [business.id_business, business]));
  const patientById = new Map(current.patients.map((patient) => [patient.id_person, patient]));
  const checks = [];

  const addCheck = (name, ok, evidence) => {
    checks.push({ name, ok: Boolean(ok), evidence });
  };

  addCheck(
    'business activo existe',
    businessById.has(BUSINESS.active.id) &&
      Number(businessById.get(BUSINESS.active.id).active) === 1 &&
      businessById.get(BUSINESS.active.id).subscription_status === 'active',
    BUSINESS.active.id
  );
  addCheck(
    'doctor QA existe y se identifica por id_login',
    userById.has(USERS.doctor.id) && userById.get(USERS.doctor.id).role_code === 'doctor',
    USERS.doctor.id
  );
  addCheck(
    'assistant QA existe',
    userById.has(USERS.assistant.id) && userById.get(USERS.assistant.id).role_code === 'assistant',
    USERS.assistant.id
  );
  addCheck(
    'reception QA existe',
    userById.has(USERS.reception.id) && userById.get(USERS.reception.id).role_code === 'reception',
    USERS.reception.id
  );
  addCheck(
    'paciente QA existe',
    patientById.has(PATIENT.id),
    PATIENT.id
  );
  addCheck(
    'tenant suspendido/restringido existe',
    businessById.has(BUSINESS.restricted.id) &&
      businessById.get(BUSINESS.restricted.id).subscription_status === 'suspended',
    BUSINESS.restricted.id
  );
  addCheck(
    'usuario inactivo/bloqueado existe',
    userById.has(USERS.inactive.id) &&
      Number(userById.get(USERS.inactive.id).active) === 0 &&
      Number(userById.get(USERS.inactive.id).locked) === 1,
    USERS.inactive.id
  );
  addCheck(
    'super admin QA existe con patron seguro',
    userById.has(USERS.superAdmin.id) && userById.get(USERS.superAdmin.id).role_code === 'super_admin',
    USERS.superAdmin.id
  );
  addCheck('historia clinica QA existe', current.clinicalHistoryCount >= 1, String(current.clinicalHistoryCount));
  addCheck('documento/plantilla QA existe', current.documentCount >= 1, String(current.documentCount));
  addCheck('tratamiento/plan QA existe', current.treatmentPlanCount >= 1 && current.patientTreatmentCount >= 1, `${current.treatmentPlanCount}/${current.patientTreatmentCount}`);
  addCheck('cleanup puede identificar fixtures por prefijo', current.users.length >= userList().length && current.business.length >= Object.keys(BUSINESS).length, PREFIX);
  addCheck('no hay passwords impresos', true, 'script prints only QA_AUTH_PASSWORD instruction');
  addCheck('no hay tokens/cookies/CSRF impresos', true, 'no auth token/cookie/CSRF values are generated or printed');

  return {
    ok: checks.every((check) => check.ok),
    checks,
    fixtures: browserQaSummary(),
    cleanup: 'node scripts/qa/d2-browser-qa-fixtures.js down',
    safeOutput: {
      passwordsPrinted: false,
      otpPrinted: false,
      accessTokensPrinted: false,
      refreshTokensPrinted: false,
      cookiesPrinted: false,
      csrfPrinted: false
    }
  };
}

async function down() {
  await assertSafeCommand('down');
  const transaction = await sequelize.transaction();

  try {
    await removeFixtures(transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  const remaining = await fixtureStatus();
  const remainingTotal = remaining.business.length +
    remaining.users.length +
    remaining.patients.length +
    remaining.clinicalHistoryCount +
    remaining.documentCount +
    remaining.treatmentPlanCount +
    remaining.patientTreatmentCount +
    remaining.sessionCount +
    remaining.refreshTokenCount;

  return {
    ok: remainingTotal === 0,
    fixturesRemoved: true,
    remaining,
    cleanupZero: remainingTotal === 0
  };
}

async function full() {
  const steps = [];
  steps.push({ step: 'status-before', result: await status() });
  let upCompleted = false;
  try {
    const upResult = await up();
    upCompleted = true;
    steps.push({ step: 'up', result: upResult });
    const validateResult = await validate();
    steps.push({ step: 'validate', result: validateResult });
  } finally {
    if (upCompleted) {
      steps.push({ step: 'down', result: await down() });
    }
  }
  steps.push({ step: 'status-after', result: await status() });

  return {
    ok: steps.every((step) => step.result && step.result.ok !== false),
    steps
  };
}

async function hold() {
  const upResult = await up();
  const validateResult = await validate();
  return {
    ok: upResult.ok && validateResult.ok,
    fixturesHeldForManualBrowserQa: true,
    up: upResult,
    validate: validateResult,
    manualBrowserQa: browserQaSummary(),
    cleanupRequired: true,
    cleanup: 'node scripts/qa/d2-browser-qa-fixtures.js down'
  };
}

function browserQaSummary() {
  return {
    activeBusiness: BUSINESS.active.name,
    restrictedBusiness: BUSINESS.restricted.name,
    admin: safeUser(USERS.admin),
    doctor: safeUser(USERS.doctor),
    assistant: safeUser(USERS.assistant),
    reception: safeUser(USERS.reception),
    restrictedAdmin: safeUser(USERS.restrictedAdmin),
    inactiveUser: safeUser(USERS.inactive),
    superAdmin: safeUser(USERS.superAdmin),
    patient: {
      id_person: PATIENT.id,
      name: PATIENT.name,
      code: PATIENT.code
    },
    clinicalHistory: CLINICAL_HISTORY.id,
    patientDocument: DOCUMENT.documentId,
    treatmentPlan: TREATMENT.planId,
    patientTreatment: TREATMENT.treatmentId,
    password: 'use QA_AUTH_PASSWORD from your local env'
  };
}

function safeUser(user) {
  return {
    id_login: user.id,
    email: user.email,
    phone: user.phone,
    role: user.roleCode,
    business: user.business ? BUSINESS[user.business].name : null,
    active: user.active,
    locked: user.locked
  };
}

async function main() {
  const command = process.argv[2] || 'status';
  const commands = {
    status,
    up,
    validate,
    down,
    full,
    hold
  };

  if (!commands[command]) {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.stderr.write('Usage: node scripts/qa/d2-browser-qa-fixtures.js [status|up|validate|down|full|hold]\n');
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
    console.error(JSON.stringify({
      command,
      ok: false,
      error: error.message,
      secretsPrinted: false,
      passwordsPrinted: false,
      tokensPrinted: false,
      cookiesPrinted: false,
      csrfPrinted: false
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

main();
