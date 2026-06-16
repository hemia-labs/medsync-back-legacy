require('../../src/config/env');

const crypto = require('crypto');
const sequelize = require('../../src/db/Sequelize.connection');
const { QueryTypes } = require('sequelize');
const { encript } = require('../../src/util/bcrypt');
const DocumentSignatureRequestDao = require('../../src/Dao/mysql/documentSignatureRequest.dao');
const PublicDocumentSignatureDao = require('../../src/Dao/mysql/publicDocumentSignature.dao');

const PREFIX = 'QA_REMOTE_SIGNING';
const CREATED_BY = 'QA_REMOTE_SIGNING_FIXTURES';
const ALLOW_FLAG = 'ALLOW_QA_REMOTE_SIGNING_FIXTURES';
const PASSWORD_ENV = 'QA_REMOTE_SIGNING_PASSWORD';
const EMAIL_TO_ENV = 'QA_REMOTE_SIGNING_EMAIL_TO';
const SUPER_ADMIN_ID_ENV = 'QA_REMOTE_SIGNING_SUPER_ADMIN_ID_LOGIN';
const SUPER_ADMIN_PHONE_ENV = 'QA_REMOTE_SIGNING_SUPER_ADMIN_TELEPHONE';

const QA_HTML = '<p>Documento QA de firma remota. No contiene informacion clinica real.</p>';

const BUSINESS = {
  A: {
    id: 'QA_REMOTE_SIGNING_TENANT_A',
    name: 'QA_REMOTE_SIGNING_TENANT_A',
    slug: 'qa-remote-signing-tenant-a',
    email: 'qa-remote-signing-a@example.invalid',
    phone: '520000009001',
    plan: 'enterprise'
  },
  B: {
    id: 'QA_REMOTE_SIGNING_TENANT_B',
    name: 'QA_REMOTE_SIGNING_TENANT_B',
    slug: 'qa-remote-signing-tenant-b',
    email: 'qa-remote-signing-b@example.invalid',
    phone: '520000009002',
    plan: 'enterprise'
  }
};

const ROLE_IDS = {
  admin: 'ROL-ADMIN',
  doctor: 'ROL-DOCTOR',
  assistant: 'ROL-ASSISTANT',
  reception: 'ROL-RECEPTION',
  noRemote: 'QA_REMOTE_SIGNING_ROLE_LOCAL'
};

const USERS = {
  aAdmin: {
    key: 'aAdmin',
    tenant: 'A',
    id: 'QA_REMOTE_SIGNING_A_ADMIN',
    roleId: ROLE_IDS.admin,
    roleCode: 'admin',
    name: 'QA Remote Signing Admin A',
    email: 'qa-remote-signing-a-admin@example.invalid',
    phone: '520000009011'
  },
  aDoctor: {
    key: 'aDoctor',
    tenant: 'A',
    id: 'QA_REMOTE_SIGNING_A_DOCTOR',
    roleId: ROLE_IDS.doctor,
    roleCode: 'doctor',
    name: 'QA Remote Signing Doctor A',
    email: 'qa-remote-signing-a-doctor@example.invalid',
    phone: '520000009012'
  },
  aAssistant: {
    key: 'aAssistant',
    tenant: 'A',
    id: 'QA_REMOTE_SIGNING_A_ASSISTANT',
    roleId: ROLE_IDS.assistant,
    roleCode: 'assistant',
    name: 'QA Remote Signing Assistant A',
    email: 'qa-remote-signing-a-assistant@example.invalid',
    phone: '520000009013'
  },
  aReception: {
    key: 'aReception',
    tenant: 'A',
    id: 'QA_REMOTE_SIGNING_A_RECEPTION',
    roleId: ROLE_IDS.reception,
    roleCode: 'reception',
    name: 'QA Remote Signing Reception A',
    email: 'qa-remote-signing-a-reception@example.invalid',
    phone: '520000009014'
  },
  aNoRemote: {
    key: 'aNoRemote',
    tenant: 'A',
    id: 'QA_REMOTE_SIGNING_A_NO_REMOTE',
    roleId: ROLE_IDS.noRemote,
    roleCode: 'qa_remote_signing_local_only',
    name: 'QA Remote Signing Local Only A',
    email: 'qa-remote-signing-a-local-only@example.invalid',
    phone: '520000009015'
  },
  bAdmin: {
    key: 'bAdmin',
    tenant: 'B',
    id: 'QA_REMOTE_SIGNING_B_ADMIN',
    roleId: ROLE_IDS.admin,
    roleCode: 'admin',
    name: 'QA Remote Signing Admin B',
    email: 'qa-remote-signing-b-admin@example.invalid',
    phone: '520000009021'
  }
};

const PATIENTS = {
  A: {
    id: 'QA_REMOTE_SIGNING_PERSON_A',
    businessId: BUSINESS.A.id,
    code: 'QARSA001',
    name: 'QA Remote',
    surname: 'Signing A',
    phone: '520000009101',
    age: 30
  },
  B: {
    id: 'QA_REMOTE_SIGNING_PERSON_B',
    businessId: BUSINESS.B.id,
    code: 'QARSB001',
    name: 'QA Remote',
    surname: 'Signing B',
    phone: '520000009102',
    age: 31
  }
};

const TEMPLATES = {
  aPatient: {
    id: 'QA_REMOTE_SIGNING_TPL_A_PATIENT',
    versionId: 'QA_REMOTE_SIGNING_TPL_A_PAT_V1',
    tenant: 'A',
    name: 'QA remote signing patient template A',
    requiresPatient: 1,
    requiresTutor: 0
  },
  aTutor: {
    id: 'QA_REMOTE_SIGNING_TPL_A_TUTOR',
    versionId: 'QA_REMOTE_SIGNING_TPL_A_TUT_V1',
    tenant: 'A',
    name: 'QA remote signing tutor template A',
    requiresPatient: 0,
    requiresTutor: 1
  },
  bPatient: {
    id: 'QA_REMOTE_SIGNING_TPL_B_PATIENT',
    versionId: 'QA_REMOTE_SIGNING_TPL_B_PAT_V1',
    tenant: 'B',
    name: 'QA remote signing patient template B',
    requiresPatient: 1,
    requiresTutor: 0
  }
};

const DOCUMENTS = {
  aPatient: {
    id: 'QA_REMOTE_SIGNING_DOC_A_PATIENT',
    tenant: 'A',
    personId: PATIENTS.A.id,
    templateKey: 'aPatient',
    title: 'QA Remote Signing Documento Paciente A',
    signatureRole: 'PATIENT',
    guardianName: null,
    guardianRelationship: null
  },
  aTutor: {
    id: 'QA_REMOTE_SIGNING_DOC_A_TUTOR',
    tenant: 'A',
    personId: PATIENTS.A.id,
    templateKey: 'aTutor',
    title: 'QA Remote Signing Documento Tutor A',
    signatureRole: 'TUTOR',
    guardianName: 'QA Tutor Sin Datos Reales',
    guardianRelationship: 'Representante QA'
  },
  bPatient: {
    id: 'QA_REMOTE_SIGNING_DOC_B_PATIENT',
    tenant: 'B',
    personId: PATIENTS.B.id,
    templateKey: 'bPatient',
    title: 'QA Remote Signing Documento Paciente B',
    signatureRole: 'PATIENT',
    guardianName: null,
    guardianRelationship: null
  }
};

const REQUIRED_TABLES = [
  'business',
  'rol',
  'login',
  'person',
  'cat_permission',
  'permission_rol',
  'document_templates',
  'document_template_versions',
  'patient_documents',
  'patient_document_signatures',
  'patient_document_events',
  'document_signature_requests'
];

const REQUIRED_DOCUMENT_SIGNATURE_INDEXES = [
  'PRIMARY',
  'ux_document_signature_requests_token_hash',
  'idx_dsr_document_status',
  'idx_dsr_document_role_status',
  'idx_dsr_patient_created',
  'idx_dsr_status_expiry',
  'idx_dsr_created_by'
];

function printUsage() {
  console.log([
    'Usage: node scripts/qa/remote-signing-fixtures.js [status|up|validate|validate-email|down]',
    '',
    'Write commands require:',
    `  ${ALLOW_FLAG}=true`,
    `  ${PASSWORD_ENV}=<qa password> (only for up)`,
    '',
    'Optional validation env:',
    `  ${EMAIL_TO_ENV}=qa-recipient@example.invalid`,
    `  ${SUPER_ADMIN_ID_ENV}=<id_login> or ${SUPER_ADMIN_PHONE_ENV}=<telephone>`,
    '',
    'The script never prints passwords, JWTs, full public URLs or full public tokens.'
  ].join('\n'));
}

async function currentDatabase() {
  const rows = await sequelize.query('SELECT DATABASE() AS db, @@hostname AS host, @@port AS port', {
    type: QueryTypes.SELECT
  });
  return rows[0] || {};
}

function hasProductionMarker(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((part) => {
      if (!part) {
        return false;
      }
      if (part === 'prod' || part === 'production') {
        return true;
      }
      return part.startsWith('production') || (part.startsWith('prod') && !part.startsWith('product'));
    });
}

function isProductionLike(dbInfo) {
  return [
    process.env.NODE_ENV,
    process.env.APP_ENV,
    process.env.ENV,
    process.env.ENVIRONMENT,
    process.env.STAGE,
    dbInfo.db,
    dbInfo.host
  ].some(hasProductionMarker);
}

async function assertNotProductionLike(command) {
  const dbInfo = await currentDatabase();
  if (isProductionLike(dbInfo)) {
    throw new Error(`${command} refused: production-like environment detected.`);
  }
  return dbInfo;
}

async function assertSafeToWrite(command) {
  const dbInfo = await assertNotProductionLike(command);
  if (String(process.env[ALLOW_FLAG] || '').toLowerCase() !== 'true') {
    throw new Error(`${command} writes QA data. Set ${ALLOW_FLAG}=true only in local/dev/staging.`);
  }
  return dbInfo;
}

function requirePassword() {
  const password = process.env[PASSWORD_ENV];
  if (!password || String(password).length < 8) {
    throw new Error(`${PASSWORD_ENV} is required and must be at least 8 characters. It is never printed.`);
  }
  return password;
}

function maskEmail(value) {
  const email = String(value || '').trim();
  const parts = email.split('@');
  if (parts.length !== 2) {
    return email ? '[email]' : null;
  }
  return `${parts[0].slice(0, 1)}***@${parts[1]}`;
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) {
    return null;
  }
  return `${'*'.repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

function redactText(value) {
  return String(value || '')
    .replace(/\/sign\/d\/[A-Za-z0-9_-]+/g, '/sign/d/[redacted]')
    .replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]');
}

function summarizeResponse(response) {
  return {
    status: response ? response.status : null,
    success: Boolean(response && response.success),
    code: response && response.code ? response.code : null,
    message: redactText(response && response.message ? response.message : ''),
    id_document_signature_request: response && response.data && response.data.id_document_signature_request
      ? response.data.id_document_signature_request
      : null,
    token_fingerprint: response && response.data && response.data.token_fingerprint
      ? response.data.token_fingerprint
      : null,
    expires_at: response && response.data && response.data.expires_at
      ? response.data.expires_at
      : null,
    public_url: response && response.data && response.data.public_url ? '/sign/d/[redacted]' : null
  };
}

function result(name, ok, details = {}) {
  return {
    name,
    ok: Boolean(ok),
    ...details
  };
}

function allFixtureBusinessIds() {
  return Object.values(BUSINESS).map((tenant) => tenant.id);
}

function allFixtureLoginIds() {
  return Object.values(USERS).map((user) => user.id);
}

function allFixturePersonIds() {
  return Object.values(PATIENTS).map((patient) => patient.id);
}

function allFixtureTemplateIds() {
  return Object.values(TEMPLATES).map((template) => template.id);
}

function allFixtureTemplateVersionIds() {
  return Object.values(TEMPLATES).map((template) => template.versionId);
}

function allFixtureDocumentIds() {
  return Object.values(DOCUMENTS).map((document) => document.id);
}

async function tableExists(tableName) {
  const rows = await sequelize.query(
    `SELECT 1
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = :tableName
      LIMIT 1`,
    {
      replacements: { tableName },
      type: QueryTypes.SELECT
    }
  );
  return rows.length > 0;
}

async function ensureRequiredTables() {
  const missing = [];
  for (const tableName of REQUIRED_TABLES) {
    if (!(await tableExists(tableName))) {
      missing.push(tableName);
    }
  }
  if (missing.length) {
    throw new Error(`Missing required tables: ${missing.join(', ')}`);
  }
}

async function permissionId(code, transaction = null) {
  const rows = await sequelize.query(
    `SELECT id_cat_permission
       FROM cat_permission
      WHERE code COLLATE utf8mb4_unicode_ci = :code COLLATE utf8mb4_unicode_ci
        AND active = 1
        AND is_active = 1
      LIMIT 1`,
    {
      replacements: { code },
      type: QueryTypes.SELECT,
      transaction
    }
  );
  return rows[0] ? rows[0].id_cat_permission : null;
}

async function roleById(idRole, transaction = null) {
  const rows = await sequelize.query(
    `SELECT id_rol, code, desc_rol, active
       FROM rol
      WHERE id_rol COLLATE utf8mb4_unicode_ci = :idRole COLLATE utf8mb4_unicode_ci
      LIMIT 1`,
    {
      replacements: { idRole },
      type: QueryTypes.SELECT,
      transaction
    }
  );
  return rows[0] || null;
}

async function hasRolePermission(idRole, permissionCode, transaction = null) {
  const rows = await sequelize.query(
    `SELECT 1
       FROM permission_rol pr
       INNER JOIN cat_permission cp
               ON cp.id_cat_permission COLLATE utf8mb4_unicode_ci = pr.id_cat_permission COLLATE utf8mb4_unicode_ci
      WHERE pr.id_rol COLLATE utf8mb4_unicode_ci = :idRole COLLATE utf8mb4_unicode_ci
        AND cp.code COLLATE utf8mb4_unicode_ci = :permissionCode COLLATE utf8mb4_unicode_ci
        AND pr.active = 1
        AND cp.active = 1
        AND cp.is_active = 1
      LIMIT 1`,
    {
      replacements: { idRole, permissionCode },
      type: QueryTypes.SELECT,
      transaction
    }
  );
  return rows.length > 0;
}

async function ensureBaseRolesAndPermissions() {
  const requiredRoles = [ROLE_IDS.admin, ROLE_IDS.doctor, ROLE_IDS.assistant, ROLE_IDS.reception];
  const missingRoles = [];
  const missingPermissions = [];

  for (const roleId of requiredRoles) {
    if (!(await roleById(roleId))) {
      missingRoles.push(roleId);
    }
    if (!(await hasRolePermission(roleId, 'documents.signature.request'))) {
      missingPermissions.push(roleId);
    }
  }

  const view = await permissionId('documents.view');
  const sign = await permissionId('documents.sign');
  const request = await permissionId('documents.signature.request');
  const missingPermissionCatalog = [];
  if (!view) missingPermissionCatalog.push('documents.view');
  if (!sign) missingPermissionCatalog.push('documents.sign');
  if (!request) missingPermissionCatalog.push('documents.signature.request');

  if (missingRoles.length || missingPermissions.length || missingPermissionCatalog.length) {
    throw new Error(JSON.stringify({
      message: 'Base roles/permissions are incomplete. Run the document signing migrations first.',
      missingRoles,
      missingPermissions,
      missingPermissionCatalog
    }));
  }
}

async function ensureNoRemoteRole(transaction) {
  await sequelize.query(
    `INSERT INTO rol (id_rol, desc_rol, code, active)
     VALUES (:idRole, :description, :code, 1)
     ON DUPLICATE KEY UPDATE desc_rol = VALUES(desc_rol), code = VALUES(code), active = 1`,
    {
      replacements: {
        idRole: ROLE_IDS.noRemote,
        description: 'QA Remote Signing Local Only',
        code: USERS.aNoRemote.roleCode
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  await sequelize.query(
    `DELETE FROM permission_rol
      WHERE id_rol COLLATE utf8mb4_unicode_ci = :idRole COLLATE utf8mb4_unicode_ci`,
    {
      replacements: { idRole: ROLE_IDS.noRemote },
      type: QueryTypes.DELETE,
      transaction
    }
  );

  for (const code of ['documents.view', 'documents.sign']) {
    const idPermission = await permissionId(code, transaction);
    if (!idPermission) {
      throw new Error(`Missing required permission catalog row: ${code}`);
    }
    await sequelize.query(
      `INSERT INTO permission_rol (id_permission_rol, id_cat_permission, id_rol, active)
       VALUES (:id, :idPermission, :idRole, 1)`,
      {
        replacements: {
          id: `QARS-${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`,
          idPermission,
          idRole: ROLE_IDS.noRemote
        },
        type: QueryTypes.INSERT,
        transaction
      }
    );
  }
}

async function ensureBusiness(tenant, transaction) {
  await sequelize.query(
    `INSERT INTO business (
        id_business, name, legal_name, slug, email, phone, address, status, plan, active,
        subscription_status, trial_starts_at, trial_ends_at, current_period_starts_at,
        current_period_ends_at, created_at, created_by
      ) VALUES (
        :idBusiness, :name, :legalName, :slug, :email, :phone, 'QA fixture local/dev/staging',
        'active', :plan, 1, 'active', NULL, NULL, NOW(), NULL, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        legal_name = VALUES(legal_name),
        email = VALUES(email),
        phone = VALUES(phone),
        status = 'active',
        plan = VALUES(plan),
        active = 1,
        subscription_status = 'active',
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idBusiness: tenant.id,
        name: tenant.name,
        legalName: tenant.name,
        slug: tenant.slug,
        email: tenant.email,
        phone: tenant.phone,
        plan: tenant.plan,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureUser(user, passwordHash, transaction) {
  await sequelize.query(
    `INSERT INTO login (
        id_login, id_business, id_rol, name, email, telephone, password, locked, active, created_at, created_by
      ) VALUES (
        :idLogin, :idBusiness, :idRole, :name, :email, :telephone, :password, 0, 1, NOW(), :createdBy
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
        idLogin: user.id,
        idBusiness: BUSINESS[user.tenant].id,
        idRole: user.roleId,
        name: user.name,
        email: user.email,
        telephone: user.phone,
        password: passwordHash,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensurePatient(patient, transaction) {
  await sequelize.query(
    `INSERT INTO person (
        id_person, id_business, code, name, surname, birthday, age, ocupation, rfc,
        local_telephone, telephone, active, created_at, created_by
      ) VALUES (
        :idPerson, :idBusiness, :code, :name, :surname, NULL, :age, 'QA fixture', NULL,
        :phone, :phone, 1, NOW(), :createdBy
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
        idPerson: patient.id,
        idBusiness: patient.businessId,
        code: patient.code,
        name: patient.name,
        surname: patient.surname,
        age: patient.age,
        phone: patient.phone,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureTemplate(template, transaction) {
  const tenant = BUSINESS[template.tenant];
  await sequelize.query(
    `INSERT INTO document_templates (
        id_document_template, id_business, template_type, license_category, template_subtype,
        is_premium, clinical_legal_safe, minimum_plan, block_mode, licensing_review_required,
        licensing_notes, name, description, requires_patient_signature, requires_tutor_signature,
        requires_doctor_signature, requires_witness1_signature, requires_witness2_signature,
        is_active, active, created_at, created_by
      ) VALUES (
        :idTemplate, :idBusiness, 'CUSTOM_DOCUMENT', 'standard_document_template', 'qa_remote_signing',
        0, 1, NULL, NULL, 0, 'QA remote signing fixture. No real clinical data.',
        :name, 'QA fixture for remote document signing.', :requiresPatient, :requiresTutor,
        0, 0, 0, 1, 1, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        name = VALUES(name),
        description = VALUES(description),
        requires_patient_signature = VALUES(requires_patient_signature),
        requires_tutor_signature = VALUES(requires_tutor_signature),
        requires_doctor_signature = VALUES(requires_doctor_signature),
        requires_witness1_signature = 0,
        requires_witness2_signature = 0,
        is_active = 1,
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idTemplate: template.id,
        idBusiness: tenant.id,
        name: template.name,
        requiresPatient: template.requiresPatient,
        requiresTutor: template.requiresTutor,
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
        :idVersion, :idTemplate, 1, :contentHtml, 'ACTIVE', 1, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        content_html = VALUES(content_html),
        status = 'ACTIVE',
        is_current = 1`,
    {
      replacements: {
        idVersion: template.versionId,
        idTemplate: template.id,
        contentHtml: QA_HTML,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureDocument(document, transaction) {
  const template = TEMPLATES[document.templateKey];
  const tenant = BUSINESS[document.tenant];
  const doctorUser = document.tenant === 'A' ? USERS.aDoctor : USERS.bAdmin;
  await sequelize.query(
    `INSERT INTO patient_documents (
        id_patient_document, id_business, id_person, id_document_template,
        id_document_template_version, template_version_number, document_type, origin, status,
        title, content_html_snapshot, signed_content_html_snapshot, responsible_doctor_user_id,
        responsible_doctor_profile_id, doctor_name_snapshot, professional_license_snapshot,
        guardian_name_snapshot, guardian_relationship_snapshot, guardian_reason_snapshot,
        active, created_at, created_by
      ) VALUES (
        :idDocument, :idBusiness, :idPerson, :idTemplate,
        :idVersion, 1, 'CUSTOM_DOCUMENT', 'DOCUMENT_CENTER', 'PENDIENTE_FIRMA',
        :title, :contentHtml, NULL, :doctorUserId,
        NULL, :doctorName, 'QA-NO-REAL-LICENSE',
        :guardianName, :guardianRelationship, NULL,
        1, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_person = VALUES(id_person),
        id_document_template = VALUES(id_document_template),
        id_document_template_version = VALUES(id_document_template_version),
        template_version_number = 1,
        document_type = 'CUSTOM_DOCUMENT',
        origin = 'DOCUMENT_CENTER',
        status = 'PENDIENTE_FIRMA',
        title = VALUES(title),
        content_html_snapshot = VALUES(content_html_snapshot),
        signed_content_html_snapshot = NULL,
        responsible_doctor_user_id = VALUES(responsible_doctor_user_id),
        doctor_name_snapshot = VALUES(doctor_name_snapshot),
        professional_license_snapshot = VALUES(professional_license_snapshot),
        guardian_name_snapshot = VALUES(guardian_name_snapshot),
        guardian_relationship_snapshot = VALUES(guardian_relationship_snapshot),
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        idDocument: document.id,
        idBusiness: tenant.id,
        idPerson: document.personId,
        idTemplate: template.id,
        idVersion: template.versionId,
        title: document.title,
        contentHtml: QA_HTML,
        doctorUserId: doctorUser.id,
        doctorName: doctorUser.name,
        guardianName: document.guardianName,
        guardianRelationship: document.guardianRelationship,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function up() {
  await assertSafeToWrite('up');
  await ensureRequiredTables();
  await ensureBaseRolesAndPermissions();
  const password = requirePassword();
  const passwordHash = await encript(password);
  const transaction = await sequelize.transaction();

  try {
    await ensureNoRemoteRole(transaction);
    for (const tenant of Object.values(BUSINESS)) {
      await ensureBusiness(tenant, transaction);
    }
    for (const user of Object.values(USERS)) {
      await ensureUser(user, passwordHash, transaction);
    }
    for (const patient of Object.values(PATIENTS)) {
      await ensurePatient(patient, transaction);
    }
    for (const template of Object.values(TEMPLATES)) {
      await ensureTemplate(template, transaction);
    }
    for (const document of Object.values(DOCUMENTS)) {
      await ensureDocument(document, transaction);
    }

    await transaction.commit();
    console.log(JSON.stringify({
      message: 'QA remote signing fixtures created/updated.',
      password: '[not printed]',
      next: 'Run: node scripts/qa/remote-signing-fixtures.js validate',
      summary: await fixtureSummary()
    }, null, 2));
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function down() {
  await assertSafeToWrite('down');
  const transaction = await sequelize.transaction();

  try {
    const businessIds = allFixtureBusinessIds();
    const loginIds = allFixtureLoginIds();
    const personIds = allFixturePersonIds();
    const templateIds = allFixtureTemplateIds();
    const templateVersionIds = allFixtureTemplateVersionIds();
    const documentIds = allFixtureDocumentIds();

    await sequelize.query(
      `DELETE FROM document_signature_requests
        WHERE id_business IN (:businessIds)
           OR id_patient_document IN (:documentIds)
           OR created_by IN (:loginIds)`,
      { replacements: { businessIds, documentIds, loginIds }, type: QueryTypes.DELETE, transaction }
    );
    await sequelize.query('DELETE FROM patient_document_events WHERE id_patient_document IN (:documentIds) OR id_business IN (:businessIds)', {
      replacements: { documentIds, businessIds },
      type: QueryTypes.DELETE,
      transaction
    });
    await sequelize.query('DELETE FROM patient_document_signatures WHERE id_patient_document IN (:documentIds) OR id_business IN (:businessIds)', {
      replacements: { documentIds, businessIds },
      type: QueryTypes.DELETE,
      transaction
    });
    await sequelize.query('DELETE FROM patient_documents WHERE id_patient_document IN (:documentIds)', {
      replacements: { documentIds },
      type: QueryTypes.DELETE,
      transaction
    });
    await sequelize.query('DELETE FROM document_template_versions WHERE id_document_template_version IN (:templateVersionIds) OR id_document_template IN (:templateIds)', {
      replacements: { templateVersionIds, templateIds },
      type: QueryTypes.DELETE,
      transaction
    });
    await sequelize.query('DELETE FROM document_templates WHERE id_document_template IN (:templateIds)', {
      replacements: { templateIds },
      type: QueryTypes.DELETE,
      transaction
    });
    await sequelize.query('DELETE FROM person WHERE id_person IN (:personIds)', {
      replacements: { personIds },
      type: QueryTypes.DELETE,
      transaction
    });
    await sequelize.query('DELETE FROM session WHERE id_login IN (:loginIds)', {
      replacements: { loginIds },
      type: QueryTypes.DELETE,
      transaction
    });
    await sequelize.query('DELETE FROM login WHERE id_login IN (:loginIds)', {
      replacements: { loginIds },
      type: QueryTypes.DELETE,
      transaction
    });
    await sequelize.query('DELETE FROM permission_rol WHERE id_rol = :idRole', {
      replacements: { idRole: ROLE_IDS.noRemote },
      type: QueryTypes.DELETE,
      transaction
    });
    await sequelize.query('DELETE FROM rol WHERE id_rol = :idRole', {
      replacements: { idRole: ROLE_IDS.noRemote },
      type: QueryTypes.DELETE,
      transaction
    });
    await sequelize.query('DELETE FROM business WHERE id_business IN (:businessIds)', {
      replacements: { businessIds },
      type: QueryTypes.DELETE,
      transaction
    });

    await transaction.commit();
    console.log(JSON.stringify({
      message: 'QA remote signing fixtures removed.',
      remaining: await fixtureSummary()
    }, null, 2));
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function fixtureSummary() {
  const rows = await sequelize.query(
    `SELECT 'business' AS type, COUNT(*) AS total FROM business WHERE id_business IN (:businessIds)
     UNION ALL SELECT 'login', COUNT(*) FROM login WHERE id_login IN (:loginIds)
     UNION ALL SELECT 'person', COUNT(*) FROM person WHERE id_person IN (:personIds)
     UNION ALL SELECT 'document_templates', COUNT(*) FROM document_templates WHERE id_document_template IN (:templateIds)
     UNION ALL SELECT 'patient_documents', COUNT(*) FROM patient_documents WHERE id_patient_document IN (:documentIds)
     UNION ALL SELECT 'document_signature_requests', COUNT(*) FROM document_signature_requests WHERE id_business IN (:businessIds) OR id_patient_document IN (:documentIds)`,
    {
      replacements: {
        businessIds: allFixtureBusinessIds(),
        loginIds: allFixtureLoginIds(),
        personIds: allFixturePersonIds(),
        templateIds: allFixtureTemplateIds(),
        documentIds: allFixtureDocumentIds()
      },
      type: QueryTypes.SELECT
    }
  );
  return rows.reduce((acc, row) => {
    acc[row.type] = Number(row.total || 0);
    return acc;
  }, {});
}

async function detailedStatus() {
  const db = await assertNotProductionLike('status');
  const summary = await fixtureSummary();
  const users = await sequelize.query(
    `SELECT l.id_login, l.id_business, l.email, l.telephone, r.code AS role_code,
            EXISTS (
              SELECT 1
                FROM permission_rol pr
                INNER JOIN cat_permission cp
                        ON cp.id_cat_permission COLLATE utf8mb4_unicode_ci = pr.id_cat_permission COLLATE utf8mb4_unicode_ci
               WHERE pr.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci
                 AND cp.code = 'documents.signature.request'
                 AND pr.active = 1
                 AND cp.active = 1
                 AND cp.is_active = 1
            ) AS has_remote_request_permission
       FROM login l
       LEFT JOIN rol r ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci
      WHERE l.id_login IN (:loginIds)
      ORDER BY l.id_login`,
    {
      replacements: { loginIds: allFixtureLoginIds() },
      type: QueryTypes.SELECT
    }
  );
  const documents = await sequelize.query(
    `SELECT id_patient_document, id_business, id_person, status, title, guardian_name_snapshot
       FROM patient_documents
      WHERE id_patient_document IN (:documentIds)
      ORDER BY id_patient_document`,
    {
      replacements: { documentIds: allFixtureDocumentIds() },
      type: QueryTypes.SELECT
    }
  );

  return {
    database: db,
    production_like_detected: isProductionLike(db),
    summary,
    users: users.map((user) => ({
      id_login: user.id_login,
      id_business: user.id_business,
      role_code: user.role_code,
      email: maskEmail(user.email),
      telephone: maskPhone(user.telephone),
      has_remote_request_permission: Boolean(user.has_remote_request_permission)
    })),
    documents
  };
}

async function status() {
  console.log(JSON.stringify(await detailedStatus(), null, 2));
}

async function validateDatabaseObjects() {
  const checks = [];
  const missingTables = [];
  for (const tableName of REQUIRED_TABLES) {
    if (!(await tableExists(tableName))) {
      missingTables.push(tableName);
    }
  }
  checks.push(result('DB migrated: required tables exist', missingTables.length === 0, { missingTables }));

  let indexRows = [];
  if (missingTables.indexOf('document_signature_requests') === -1) {
    indexRows = await sequelize.query('SHOW INDEX FROM document_signature_requests', { type: QueryTypes.SELECT });
  }
  const existingIndexes = [...new Set(indexRows.map((row) => row.Key_name))];
  const missingIndexes = REQUIRED_DOCUMENT_SIGNATURE_INDEXES.filter((name) => existingIndexes.indexOf(name) === -1);
  checks.push(result('DB migrated: document_signature_requests indexes exist', missingIndexes.length === 0, {
    existingIndexes,
    missingIndexes
  }));

  return checks;
}

async function validatePermissions() {
  const checks = [];
  const requestPermission = await permissionId('documents.signature.request');
  checks.push(result('Permission exists: documents.signature.request', Boolean(requestPermission)));

  for (const user of [USERS.aAdmin, USERS.aDoctor, USERS.aAssistant, USERS.aReception, USERS.bAdmin]) {
    checks.push(result(`Authorized role has remote permission: ${user.roleCode}`, await hasRolePermission(user.roleId, 'documents.signature.request'), {
      id_login: user.id,
      id_rol: user.roleId
    }));
  }

  checks.push(result('Negative QA role does not have remote permission', !(await hasRolePermission(ROLE_IDS.noRemote, 'documents.signature.request')), {
    id_login: USERS.aNoRemote.id,
    id_rol: ROLE_IDS.noRemote
  }));

  return checks;
}

async function ensureFixturesPresentForValidation() {
  const summary = await fixtureSummary();
  const expected = {
    business: Object.keys(BUSINESS).length,
    login: Object.keys(USERS).length,
    person: Object.keys(PATIENTS).length,
    document_templates: Object.keys(TEMPLATES).length,
    patient_documents: Object.keys(DOCUMENTS).length
  };
  const missing = Object.keys(expected).filter((key) => Number(summary[key] || 0) < expected[key]);
  if (missing.length) {
    throw new Error(`Fixtures are incomplete. Run up first. Missing groups: ${missing.join(', ')}`);
  }
}

function requestBodyFor(user, document, channel = 'qr') {
  return {
    id_login: user.id,
    id_business: BUSINESS[user.tenant].id,
    rol: user.roleCode,
    id_patient_document: document.id,
    signature_role: document.signatureRole,
    channel,
    recipient_phone: channel === 'whatsapp' ? '520000009199' : null,
    recipient_email: null,
    expires_in_minutes: channel === 'qr' ? 30 : null
  };
}

async function createRequestAs(user, document, channel = 'qr') {
  return DocumentSignatureRequestDao.create(requestBodyFor(user, document, channel));
}

function extractTokenFromPublicUrl(publicUrl) {
  const match = String(publicUrl || '').match(/\/sign\/d\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

function isDeniedResponse(response) {
  return Boolean(
    response &&
    !response.success &&
    [400, 403, 404].includes(Number(response.status))
  );
}

async function validateRolesAndRequests() {
  const checks = [];
  const aPatientDocument = DOCUMENTS.aPatient;
  const aTutorDocument = DOCUMENTS.aTutor;
  const bPatientDocument = DOCUMENTS.bPatient;

  const adminCreate = await createRequestAs(USERS.aAdmin, aPatientDocument, 'qr');
  checks.push(result('admin can generate remote request', adminCreate && adminCreate.success, summarizeResponse(adminCreate)));

  const doctorCreate = await createRequestAs(USERS.aDoctor, aPatientDocument, 'qr');
  checks.push(result('doctor can generate remote request', doctorCreate && doctorCreate.success, summarizeResponse(doctorCreate)));

  const assistantCreate = await createRequestAs(USERS.aAssistant, aPatientDocument, 'whatsapp');
  checks.push(result('assistant can generate remote request', assistantCreate && assistantCreate.success, summarizeResponse(assistantCreate)));

  const receptionCreate = await createRequestAs(USERS.aReception, aTutorDocument, 'qr');
  checks.push(result('reception can generate tutor remote request', receptionCreate && receptionCreate.success, summarizeResponse(receptionCreate)));

  const negativeCreate = await createRequestAs(USERS.aNoRemote, aPatientDocument, 'qr');
  checks.push(result('negative user denied remote request', negativeCreate && negativeCreate.success === false && negativeCreate.status === 403, summarizeResponse(negativeCreate)));

  const bCreate = await createRequestAs(USERS.bAdmin, bPatientDocument, 'qr');
  checks.push(result('tenant B authorized user can generate own request', bCreate && bCreate.success, summarizeResponse(bCreate)));

  return {
    checks,
    adminCreate,
    tenantAActiveCreate: assistantCreate,
    bCreate
  };
}

async function validateMultiTenant(referenceCreate) {
  const checks = [];
  const bAgainstADocument = await DocumentSignatureRequestDao.create({
    ...requestBodyFor(USERS.bAdmin, DOCUMENTS.aPatient, 'qr'),
    id_business: BUSINESS.B.id
  });
  checks.push(result('Tenant B cannot create request for tenant A document', isDeniedResponse(bAgainstADocument), summarizeResponse(bAgainstADocument)));

  const bListA = await DocumentSignatureRequestDao.list({
    id_login: USERS.bAdmin.id,
    id_business: BUSINESS.B.id,
    rol: USERS.bAdmin.roleCode,
    id_patient_document: DOCUMENTS.aPatient.id
  });
  checks.push(result('Tenant B cannot list tenant A document requests', isDeniedResponse(bListA), summarizeResponse(bListA)));

  const requestId = referenceCreate && referenceCreate.data ? referenceCreate.data.id_document_signature_request : null;
  const bRevokeA = await DocumentSignatureRequestDao.revoke({
    id_login: USERS.bAdmin.id,
    id_business: BUSINESS.B.id,
    rol: USERS.bAdmin.roleCode,
    id_document_signature_request: requestId,
    reason: 'QA cross-tenant revoke should be denied.'
  });
  checks.push(result('Tenant B cannot revoke tenant A request', isDeniedResponse(bRevokeA), summarizeResponse(bRevokeA)));

  const token = extractTokenFromPublicUrl(referenceCreate && referenceCreate.data ? referenceCreate.data.public_url : null);
  if (!token) {
    checks.push(result('Public token available for redacted public validation', false));
    return checks;
  }

  const publicOpen = await PublicDocumentSignatureDao.openByToken(token, {
    ip: '127.0.0.1',
    userAgent: 'QA_REMOTE_SIGNING validation'
  });
  const leaksInternalIds = Boolean(
    publicOpen &&
    publicOpen.data &&
    JSON.stringify(publicOpen.data).match(/token_hash|public_url|id_business|id_patient_document|id_person/i)
  );
  checks.push(result('Public token resolves from request without exposed IDs/token hash', publicOpen && publicOpen.success && !leaksInternalIds, {
    response: summarizeResponse(publicOpen),
    exposed_internal_fields_detected: leaksInternalIds
  }));

  return checks;
}

async function validateSuperAdminIfProvided(referenceRequestId) {
  const idLoginEnv = String(process.env[SUPER_ADMIN_ID_ENV] || '').trim();
  const phoneEnv = String(process.env[SUPER_ADMIN_PHONE_ENV] || '').trim();
  if (!idLoginEnv && !phoneEnv) {
    return [result('super_admin denied for remote signing operations', false, {
      blocked: true,
      reason: `Set ${SUPER_ADMIN_ID_ENV} or ${SUPER_ADMIN_PHONE_ENV} to run this check. No super_admin is created by this script.`
    })];
  }

  const where = idLoginEnv
    ? 'l.id_login COLLATE utf8mb4_unicode_ci = :value COLLATE utf8mb4_unicode_ci'
    : 'l.telephone COLLATE utf8mb4_unicode_ci = :value COLLATE utf8mb4_unicode_ci';
  const rows = await sequelize.query(
    `SELECT l.id_login, l.id_business, l.email, l.telephone, r.code AS role_code
       FROM login l
       INNER JOIN rol r ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci
      WHERE ${where}
      LIMIT 1`,
    {
      replacements: { value: idLoginEnv || phoneEnv },
      type: QueryTypes.SELECT
    }
  );
  const admin = rows[0];
  if (!admin || admin.role_code !== 'super_admin') {
    return [result('super_admin denied for remote signing operations', false, {
      blocked: true,
      reason: 'Provided super_admin identifier was not found or is not role super_admin.'
    })];
  }

  const base = {
    id_login: admin.id_login,
    id_business: BUSINESS.A.id,
    rol: 'super_admin'
  };
  const create = await DocumentSignatureRequestDao.create({
    ...base,
    id_patient_document: DOCUMENTS.aPatient.id,
    signature_role: 'PATIENT',
    channel: 'qr'
  });
  const list = await DocumentSignatureRequestDao.list({
    ...base,
    id_patient_document: DOCUMENTS.aPatient.id
  });
  const revoke = await DocumentSignatureRequestDao.revoke({
    ...base,
    id_document_signature_request: referenceRequestId,
    reason: 'QA super_admin revoke should be denied.'
  });
  const email = await DocumentSignatureRequestDao.sendEmail({
    ...base,
    id_patient_document: DOCUMENTS.aPatient.id,
    signature_role: 'PATIENT',
    recipient_email: 'qa-remote-signing-super-admin-denied@example.invalid'
  });

  const allDenied = [create, list, revoke, email].every((response) => response && response.success === false && response.status === 403);
  return [result('super_admin denied for create/list/revoke/email', allDenied, {
    create: summarizeResponse(create),
    list: summarizeResponse(list),
    revoke: summarizeResponse(revoke),
    email: summarizeResponse(email),
    super_admin: {
      id_login: admin.id_login,
      email: maskEmail(admin.email),
      telephone: maskPhone(admin.telephone)
    }
  })];
}

async function validateEventsAndLogs() {
  const rows = await sequelize.query(
    `SELECT event_type, notes
       FROM patient_document_events
      WHERE id_patient_document IN (:documentIds)
         OR id_business IN (:businessIds)
      ORDER BY created_at DESC
      LIMIT 100`,
    {
      replacements: {
        documentIds: allFixtureDocumentIds(),
        businessIds: allFixtureBusinessIds()
      },
      type: QueryTypes.SELECT
    }
  );

  const unsafe = rows.filter((row) => {
    const text = String(row.notes || '');
    return /\/sign\/d\/[A-Za-z0-9_-]{20,}/.test(text) ||
      /token_hash/i.test(text) ||
      /data:image\/png;base64/i.test(text) ||
      /SMTP_PASS|SMTP_PASSWORD|SIGNATURE_LINK_TOKEN_SECRET/i.test(text);
  });

  return [result('patient_document_events do not expose tokens/base64/secrets', unsafe.length === 0, {
    events_checked: rows.length,
    unsafe_matches: unsafe.length
  })];
}

async function validateEmail() {
  await assertSafeToWrite('validate-email');
  await ensureFixturesPresentForValidation();
  const emailTo = String(process.env[EMAIL_TO_ENV] || '').trim().toLowerCase();
  if (!emailTo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTo)) {
    throw new Error(`${EMAIL_TO_ENV} must be set to a QA email/sandbox recipient. No email was sent.`);
  }

  const response = await DocumentSignatureRequestDao.sendEmail({
    id_login: USERS.aAdmin.id,
    id_business: BUSINESS.A.id,
    rol: USERS.aAdmin.roleCode,
    id_patient_document: DOCUMENTS.aPatient.id,
    signature_role: 'PATIENT',
    recipient_email: emailTo
  });

  console.log(JSON.stringify({
    email_to: maskEmail(emailTo),
    result: summarizeResponse(response)
  }, null, 2));
}

async function validate() {
  await assertSafeToWrite('validate');
  await ensureFixturesPresentForValidation();
  const checks = [];
  checks.push(...await validateDatabaseObjects());
  checks.push(...await validatePermissions());

  const roleValidation = await validateRolesAndRequests();
  checks.push(...roleValidation.checks);
  checks.push(...await validateMultiTenant(roleValidation.tenantAActiveCreate));
  checks.push(...await validateSuperAdminIfProvided(
    roleValidation.tenantAActiveCreate && roleValidation.tenantAActiveCreate.data
      ? roleValidation.tenantAActiveCreate.data.id_document_signature_request
      : null
  ));
  checks.push(...await validateEventsAndLogs());

  const failed = checks.filter((check) => !check.ok && !check.blocked);
  const blocked = checks.filter((check) => check.blocked);
  console.log(JSON.stringify({
    database: await currentDatabase(),
    passed: checks.filter((check) => check.ok).length,
    failed: failed.length,
    blocked: blocked.length,
    checks
  }, null, 2));

  if (failed.length) {
    process.exitCode = 2;
  }
}

async function main() {
  const command = process.argv[2] || 'status';
  if (command === 'status') {
    await status();
  } else if (command === 'up') {
    await up();
  } else if (command === 'down' || command === 'rollback') {
    await down();
  } else if (command === 'validate') {
    await validate();
  } else if (command === 'validate-email') {
    await validateEmail();
  } else if (command === 'help' || command === '--help' || command === '-h') {
    printUsage();
  } else {
    printUsage();
    throw new Error(`Unknown command: ${command}`);
  }
}

main()
  .catch((error) => {
    console.error(redactText(error.message));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await sequelize.close();
    } catch (error) {
      // Ignore shutdown errors in QA scripts.
    }
  });
