'use strict';

require('../../src/config/env');

const { QueryTypes } = require('sequelize');
const sequelize = require('../../src/db/Sequelize.connection');
const SecurityConfig = require('../../src/config/security');
const config = require('../../src/config/config');
const { encript } = require('../../src/util/bcrypt');

const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const CREATED_BY = 'QA_DEMO_SEED';
const PASSWORD = 'PruebaDummyQA123';

const QA_BUSINESSES = Object.freeze({
  professional: {
    key: 'professional',
    id: 'QA_BUSINESS_PROFESSIONAL',
    name: 'QA Consultorio Profesional',
    legalName: 'QA Consultorio Profesional',
    slug: 'qa-consultorio-profesional',
    email: 'qa+consultorio-profesional@medsync.local',
    phone: '5510000100',
    address: 'Direccion dummy QA Profesional',
    plan: 'pro',
    mainUser: {
      id: 'QA_LOGIN_PROFESSIONAL',
      name: 'QA_Profesional',
      email: 'qa_profesional@medsync.local',
      phone: '5510000101',
      roleCode: 'admin'
    }
  },
  clinical: {
    key: 'clinical',
    id: 'QA_BUSINESS_CLINICAL',
    name: 'QA Clinica Demo',
    legalName: 'QA Clinica Demo',
    slug: 'qa-clinica-demo',
    email: 'qa+clinica-demo@medsync.local',
    phone: '5510000200',
    address: 'Direccion dummy QA Clinica',
    plan: 'enterprise',
    mainUser: {
      id: 'QA_LOGIN_CLINICAL',
      name: 'QA_Clinical',
      email: 'qa_clinical@medsync.local',
      phone: '5510000201',
      roleCode: 'admin'
    }
  }
});

const ROLE_CODES = Object.freeze({
  adminCandidates: ['admin', 'business_admin'],
  doctor: 'doctor',
  assistantCandidates: ['assistant', 'reception', 'receptionist']
});

const APPOINTMENT_STATUSES = Object.freeze([
  'confirmed',
  'cancelled',
  'pending_confirmation',
  'completed',
  'rescheduled',
  'no_show'
]);

const PRESCRIPTION_STATUSES = Object.freeze(['draft', 'issued', 'cancelled']);
const CLINICAL_HISTORY_STATUSES = Object.freeze(['DRAFT', 'FINALIZED']);
const DOCUMENT_STATUSES = Object.freeze(['BORRADOR', 'PENDIENTE_FIRMA', 'FIRMADO', 'NO_FIRMADO_POR_NEGATIVA']);
const TREATMENT_PLAN_STATUSES = Object.freeze(['active', 'closed', 'cancelled']);
const PATIENT_TREATMENT_STATUSES = Object.freeze(['pending', 'in_progress', 'completed', 'cancelled', 'paused']);
const SIGNATURE_REQUEST_STATUSES = Object.freeze(['pending', 'opened', 'signed', 'expired', 'revoked', 'failed']);

const CATALOG_TABLES = Object.freeze([
  'cat_condition',
  'cat_files',
  'cat_module',
  'cat_order_tooth',
  'cat_pathological_personal',
  'cat_permission',
  'cat_tooth',
  'cat_tooth_parts',
  'cat_treatment',
  'cat_type_tooth',
  'cat_ui_theme',
  'cat_x_position_tooth',
  'cat_y_position_tooth',
  'family_path',
  'module_permission',
  'permission_rol',
  'rol',
  'rol_module',
  'type_pathological_personal'
]);

const STRUCTURAL_KEEP_TABLES = Object.freeze([
  ...CATALOG_TABLES,
  'clinical_history_templates',
  'clinical_history_template_versions',
  'clinical_history_template_events',
  'login',
  'login_image_configuration',
  'ui_theme_configuration'
]);

const TENANT_OPERATIONAL_TABLES = Object.freeze([
  'address',
  'allergy',
  'appointment',
  'appointment_blocked_date',
  'appointment_blocked_hour',
  'appointment_config',
  'appointment_time_range',
  'appointment_working_day',
  'business',
  'business_license_overrides',
  'clinical_histories',
  'clinical_history_events',
  'clinical_module_config',
  'diagnosis',
  'diagnosisV1',
  'doctor_professional_profile',
  'document_signature_requests',
  'document_template_versions',
  'document_templates',
  'family_brothers',
  'family_grandparents',
  'family_parents',
  'files',
  'odontogram',
  'odontogramDetailv1',
  'odontogramv1',
  'pathological_personal',
  'patient_document_events',
  'patient_document_signatures',
  'patient_documents',
  'patient_emergency_contacts',
  'patient_extra_info',
  'patient_treatment',
  'patient_treatment_tooth',
  'person',
  'prescription',
  'prescription_audit_log',
  'prescription_config',
  'prescription_folio_counter',
  'prescription_item',
  'profile_px',
  'query',
  'signature_consent',
  'tracing',
  'treatment',
  'treatment_plan',
  'treatment_plan_consent'
]);

const AUTH_RUNTIME_TABLES = Object.freeze([
  'auth_password_reset_tokens',
  'otp',
  'refresh_token',
  'session'
]);

const AUDIT_TABLES = Object.freeze(['admin_audit_log']);

const FULL_RESET_DELETE_ORDER = Object.freeze([
  'admin_audit_log',
  'auth_password_reset_tokens',
  'refresh_token',
  'session',
  'otp',
  'document_signature_requests',
  'patient_document_signatures',
  'patient_document_events',
  'treatment_plan_consent',
  'patient_documents',
  'clinical_history_events',
  'clinical_histories',
  'prescription_item',
  'prescription_audit_log',
  'prescription',
  'prescription_folio_counter',
  'prescription_config',
  'appointment',
  'tracing',
  'patient_treatment_tooth',
  'patient_treatment',
  'treatment_plan',
  'treatment',
  'diagnosis',
  'diagnosisV1',
  'odontogramDetailv1',
  'odontogramv1',
  'odontogram',
  'files',
  'profile_px',
  'address',
  'allergy',
  'query',
  'pathological_personal',
  'family_grandparents',
  'family_parents',
  'family_brothers',
  'patient_emergency_contacts',
  'patient_extra_info',
  'appointment_blocked_hour',
  'appointment_blocked_date',
  'appointment_time_range',
  'appointment_working_day',
  'appointment_config',
  'clinical_module_config',
  'document_template_versions',
  'document_templates',
  'business_license_overrides',
  'doctor_professional_profile',
  'signature_consent',
  'ui_theme_configuration',
  'login_image_configuration',
  'person',
  'login',
  'business'
]);

const tableExistsCache = new Map();

function dbTarget() {
  return {
    host: config.HOSTMYSQL || '',
    port: config.PORTMYSQL || 3306,
    database: config.DATABASEMYSQL || '',
    userConfigured: Boolean(config.USERMYSQL)
  };
}

function isLocalHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  return ['', 'localhost', '127.0.0.1', '::1'].includes(normalized);
}

function containsRiskToken(value) {
  return /(prod|production|live)/i.test(String(value || ''));
}

function assertNotProductionLike() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production' || SecurityConfig.isProductionLike()) {
    throw new Error('Abortado: ambiente production-like detectado.');
  }
}

function assertExplicitFlag(name, expected) {
  if (process.env[name] !== expected) {
    throw new Error(`Abortado: requiere ${name}=${expected}.`);
  }
}

function assertWritableDbAllowed() {
  assertNotProductionLike();

  const target = dbTarget();
  const remoteHost = !isLocalHost(target.host);
  const riskyName = containsRiskToken(target.database);
  const riskyHost = containsRiskToken(target.host);
  const hostedKnownName = String(target.database || '').toLowerCase() === 'u575589445_orrico';

  if ((remoteHost || riskyName || riskyHost || hostedKnownName) && process.env.QA_ALLOW_REMOTE_DB_WRITE !== 'YES') {
    throw new Error(
      'Abortado: DB host/name parece remoto o sensible. Requiere QA_ALLOW_REMOTE_DB_WRITE=YES despues de confirmar que NO es produccion.'
    );
  }
}

function safeDbTarget() {
  const target = dbTarget();
  return {
    host: target.host ? (isLocalHost(target.host) ? target.host : '[remote/redacted]') : '',
    port: target.port,
    database: target.database || '',
    userConfigured: target.userConfigured,
    productionLike: SecurityConfig.isProductionLike()
  };
}

function affectedRows(result) {
  if (typeof result === 'number') {
    return result;
  }

  if (Array.isArray(result)) {
    const metadata = result[1];
    if (metadata && typeof metadata === 'object' && metadata.affectedRows !== undefined) {
      return Number(metadata.affectedRows || 0);
    }
    if (typeof result[1] === 'number') {
      return result[1];
    }
    if (typeof result[0] === 'number') {
      return result[0];
    }
  }

  if (result && typeof result === 'object' && result.affectedRows !== undefined) {
    return Number(result.affectedRows || 0);
  }

  return 0;
}

async function tableExists(tableName) {
  if (tableExistsCache.has(tableName)) {
    return tableExistsCache.get(tableName);
  }

  const rows = await sequelize.query(
    `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = :tableName`,
    {
      replacements: { tableName },
      type: QueryTypes.SELECT
    }
  );
  const exists = Number(rows[0] ? rows[0].total : 0) > 0;
  tableExistsCache.set(tableName, exists);
  return exists;
}

async function existingTables(tables) {
  const result = [];
  for (const table of tables) {
    if (await tableExists(table)) {
      result.push(table);
    }
  }
  return result;
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean).map((value) => String(value))));
}

async function selectValues(sql, replacements = {}, transaction = null) {
  const rows = await sequelize.query(sql, {
    replacements,
    type: QueryTypes.SELECT,
    transaction
  });
  return rows || [];
}

async function countRows(table, where = '', replacements = {}, transaction = null) {
  if (!(await tableExists(table))) {
    return null;
  }

  const rows = await selectValues(
    `SELECT COUNT(*) AS total FROM \`${table}\`${where ? ` WHERE ${where}` : ''}`,
    replacements,
    transaction
  );
  return Number(rows[0] ? rows[0].total : 0);
}

async function deleteRows(table, where = '', replacements = {}, transaction = null) {
  if (!(await tableExists(table))) {
    return { table, skipped: true, deleted: 0 };
  }

  const before = await countRows(table, where, replacements, transaction);
  const sql = `DELETE FROM \`${table}\`${where ? ` WHERE ${where}` : ''}`;
  const result = await sequelize.query(sql, {
    replacements,
    type: QueryTypes.DELETE,
    transaction
  });
  const after = await countRows(table, where, replacements, transaction);
  const countedDeleted = before !== null && after !== null ? Math.max(Number(before || 0) - Number(after || 0), 0) : 0;
  return { table, skipped: false, deleted: Math.max(affectedRows(result), countedDeleted) };
}

function inCondition(column, key, values, replacements) {
  const list = unique(values);
  if (!list.length) {
    return null;
  }
  replacements[key] = list;
  return `${column} IN (:${key})`;
}

async function deleteScoped(table, conditions, replacements = {}, transaction = null) {
  const cleanConditions = (conditions || []).filter(Boolean);
  if (!cleanConditions.length) {
    return { table, skipped: true, deleted: 0, reason: 'empty-scope' };
  }
  return deleteRows(table, cleanConditions.join(' OR '), replacements, transaction);
}

async function getRowsByColumn(table, column, values, selectColumn, transaction = null) {
  const list = unique(values);
  if (!list.length || !(await tableExists(table))) {
    return [];
  }

  const rows = await selectValues(
    `SELECT ${selectColumn} AS value
       FROM \`${table}\`
      WHERE ${column} IN (:values)`,
    { values: list },
    transaction
  );
  return unique(rows.map((row) => row.value));
}

async function getQaBusinessIds(transaction = null) {
  if (!(await tableExists('business'))) {
    return [];
  }

  const definitions = Object.values(QA_BUSINESSES);
  const ids = definitions.map((item) => item.id);
  const slugs = definitions.map((item) => item.slug);
  const names = definitions.map((item) => item.name);
  const phones = definitions.map((item) => item.mainUser.phone);
  const emails = definitions.map((item) => item.mainUser.email);
  const loginIds = definitions.map((item) => item.mainUser.id);

  const rows = await selectValues(
    `SELECT DISTINCT b.id_business
       FROM business b
      WHERE b.id_business IN (:ids)
         OR b.slug IN (:slugs)
         OR b.name IN (:names)
         OR b.created_by = :createdBy
      UNION
     SELECT DISTINCT l.id_business
       FROM login l
      WHERE l.id_business IS NOT NULL
        AND (
             l.id_login IN (:loginIds)
          OR l.telephone IN (:phones)
          OR l.email IN (:emails)
          OR l.name IN (:loginNames)
          OR l.created_by = :createdBy
        )`,
    {
      ids,
      slugs,
      names,
      loginIds,
      phones,
      emails,
      loginNames: definitions.map((item) => item.mainUser.name),
      createdBy: CREATED_BY
    },
    transaction
  );

  return unique(rows.map((row) => row.id_business));
}

async function getLoginIdsForBusinesses(businessIds, transaction = null) {
  return getRowsByColumn('login', 'id_business', businessIds, 'id_login', transaction);
}

async function getPersonIdsForBusinesses(businessIds, transaction = null) {
  return getRowsByColumn('person', 'id_business', businessIds, 'id_person', transaction);
}

async function getPatientDocumentIds(businessIds, personIds, transaction = null) {
  if (!(await tableExists('patient_documents'))) {
    return [];
  }

  const replacements = {};
  const conditions = [
    inCondition('id_business', 'businessIds', businessIds, replacements),
    inCondition('id_person', 'personIds', personIds, replacements)
  ].filter(Boolean);

  if (!conditions.length) {
    return [];
  }

  const rows = await selectValues(
    `SELECT id_patient_document AS value
       FROM patient_documents
      WHERE ${conditions.join(' OR ')}`,
    replacements,
    transaction
  );
  return unique(rows.map((row) => row.value));
}

async function getClinicalTemplateIds(businessIds, transaction = null) {
  if (!(await tableExists('clinical_history_templates'))) {
    return [];
  }

  const rows = await selectValues(
    `SELECT id_clinical_history_template AS value
       FROM clinical_history_templates
      WHERE business_id IN (:businessIds)`,
    { businessIds: unique(businessIds) },
    transaction
  );
  return unique(rows.map((row) => row.value));
}

async function getDocumentTemplateIds(businessIds, transaction = null) {
  return getRowsByColumn('document_templates', 'id_business', businessIds, 'id_document_template', transaction);
}

async function deleteClinicalTemplatesForIds(templateIds, transaction = null) {
  const replacements = {};
  const condition = inCondition('clinical_history_template_id', 'templateIds', templateIds, replacements);
  const summary = [];

  summary.push(await deleteScoped('clinical_history_template_events', [condition], replacements, transaction));
  summary.push(await deleteScoped('clinical_history_template_versions', [condition], replacements, transaction));

  const templateReplacements = {};
  const templateCondition = inCondition('id_clinical_history_template', 'templateIds', templateIds, templateReplacements);
  summary.push(await deleteScoped('clinical_history_templates', [templateCondition], templateReplacements, transaction));
  return summary;
}

async function deleteDocumentTemplatesForIds(templateIds, transaction = null) {
  const replacements = {};
  const condition = inCondition('id_document_template', 'templateIds', templateIds, replacements);
  const summary = [];
  summary.push(await deleteScoped('document_template_versions', [condition], replacements, transaction));
  summary.push(await deleteScoped('document_templates', [condition], replacements, transaction));
  return summary;
}

async function deleteDataForBusinessIds(businessIds, transaction = null) {
  const scopedBusinessIds = unique(businessIds);
  if (!scopedBusinessIds.length) {
    return [];
  }

  const loginIds = await getLoginIdsForBusinesses(scopedBusinessIds, transaction);
  const personIds = await getPersonIdsForBusinesses(scopedBusinessIds, transaction);
  const patientDocumentIds = await getPatientDocumentIds(scopedBusinessIds, personIds, transaction);
  const clinicalTemplateIds = await getClinicalTemplateIds(scopedBusinessIds, transaction);
  const documentTemplateIds = await getDocumentTemplateIds(scopedBusinessIds, transaction);
  const summary = [];

  const byBusiness = (column = 'id_business') => {
    const replacements = {};
    return [inCondition(column, 'businessIds', scopedBusinessIds, replacements), replacements];
  };
  const byPerson = (column = 'id_person') => {
    const replacements = {};
    return [inCondition(column, 'personIds', personIds, replacements), replacements];
  };

  const deleteByBusiness = async (table, column = 'id_business') => {
    const [condition, replacements] = byBusiness(column);
    summary.push(await deleteScoped(table, [condition], replacements, transaction));
  };

  const deleteByBusinessOrPerson = async (table, businessColumn = 'id_business', personColumn = 'id_person') => {
    const replacements = {};
    const conditions = [
      inCondition(businessColumn, 'businessIds', scopedBusinessIds, replacements),
      inCondition(personColumn, 'personIds', personIds, replacements)
    ];
    summary.push(await deleteScoped(table, conditions, replacements, transaction));
  };

  const deleteByPatientDocuments = async (table) => {
    const replacements = {};
    const condition = inCondition('id_patient_document', 'patientDocumentIds', patientDocumentIds, replacements);
    summary.push(await deleteScoped(table, [condition], replacements, transaction));
  };

  const auditReplacements = {};
  summary.push(await deleteScoped(
    'admin_audit_log',
    [
      inCondition('target_business_id', 'businessIds', scopedBusinessIds, auditReplacements),
      inCondition('actor_login_id', 'loginIds', loginIds, auditReplacements),
      inCondition('target_login_id', 'targetLoginIds', loginIds, auditReplacements)
    ],
    auditReplacements,
    transaction
  ));

  summary.push(...await deleteClinicalTemplatesForIds(clinicalTemplateIds, transaction));
  summary.push(...await deleteDocumentTemplatesForIds(documentTemplateIds, transaction));

  await deleteByBusinessOrPerson('document_signature_requests');
  await deleteByPatientDocuments('patient_document_signatures');
  await deleteByPatientDocuments('patient_document_events');
  await deleteByBusinessOrPerson('treatment_plan_consent');
  await deleteByBusinessOrPerson('patient_documents');
  await deleteByBusiness('clinical_history_events', 'business_id');
  await deleteByBusinessOrPerson('clinical_histories', 'business_id', 'patient_id');
  await deleteByBusiness('prescription_item');
  await deleteByBusiness('prescription_audit_log');
  await deleteByBusiness('prescription');
  await deleteByBusiness('prescription_folio_counter');
  await deleteByBusiness('prescription_config');
  await deleteByBusinessOrPerson('appointment');
  await deleteByBusinessOrPerson('tracing');
  await deleteByBusiness('patient_treatment_tooth');
  await deleteByBusinessOrPerson('patient_treatment');
  await deleteByBusinessOrPerson('treatment_plan');
  await deleteByBusinessOrPerson('treatment');
  await deleteByBusinessOrPerson('diagnosis');
  await deleteByBusinessOrPerson('diagnosisV1');
  await deleteByBusinessOrPerson('odontogramDetailv1');
  await deleteByBusinessOrPerson('odontogramv1');
  await deleteByBusinessOrPerson('odontogram');
  await deleteByBusinessOrPerson('files');
  await deleteByBusinessOrPerson('profile_px');
  await deleteByBusinessOrPerson('address');
  await deleteByBusinessOrPerson('allergy', 'id_business', 'id_patient');
  await deleteByBusinessOrPerson('query');
  await deleteByBusinessOrPerson('pathological_personal');
  await deleteByBusinessOrPerson('family_grandparents');
  await deleteByBusinessOrPerson('family_parents');
  await deleteByBusinessOrPerson('family_brothers');
  await deleteByBusinessOrPerson('patient_emergency_contacts');
  await deleteByBusinessOrPerson('patient_extra_info');
  await deleteByBusiness('appointment_blocked_hour');
  await deleteByBusiness('appointment_blocked_date');
  await deleteByBusiness('appointment_time_range');
  await deleteByBusiness('appointment_working_day');
  await deleteByBusiness('appointment_config');
  await deleteByBusiness('clinical_module_config');
  await deleteByBusiness('business_license_overrides');
  await deleteByBusiness('doctor_professional_profile');
  await deleteByBusiness('signature_consent');
  await deleteByBusiness('ui_theme_configuration');
  await deleteByBusiness('login_image_configuration');

  const loginReplacements = {};
  const loginCondition = inCondition('id_login', 'loginIds', loginIds, loginReplacements);
  summary.push(await deleteScoped('auth_password_reset_tokens', [loginCondition], loginReplacements, transaction));
  summary.push(await deleteScoped('refresh_token', [loginCondition], loginReplacements, transaction));
  summary.push(await deleteScoped('session', [loginCondition], loginReplacements, transaction));
  summary.push(await deleteScoped('login', [loginCondition], loginReplacements, transaction));

  const personReplacements = {};
  const personCondition = inCondition('id_person', 'personIds', personIds, personReplacements);
  summary.push(await deleteScoped('person', [personCondition], personReplacements, transaction));

  const businessReplacements = {};
  const businessCondition = inCondition('id_business', 'businessIds', scopedBusinessIds, businessReplacements);
  summary.push(await deleteScoped('business', [businessCondition], businessReplacements, transaction));

  return summary;
}

async function superAdminRows(transaction = null) {
  if (!(await tableExists('login')) || !(await tableExists('rol'))) {
    return [];
  }

  return selectValues(
    `SELECT l.id_login, l.email, l.telephone, l.name, l.active, r.code AS role
       FROM login l
       INNER JOIN rol r
               ON r.id_rol COLLATE ${TENANT_COLLATION} = l.id_rol COLLATE ${TENANT_COLLATION}
      WHERE r.code COLLATE ${TENANT_COLLATION} = 'super_admin' COLLATE ${TENANT_COLLATION}
      ORDER BY l.created_at, l.id_login`,
    {},
    transaction
  );
}

async function resolveSuperAdminsToKeep(transaction = null) {
  const rows = await superAdminRows(transaction);
  if (!rows.length) {
    throw new Error('Abortado: no se encontro ningun usuario super_admin para conservar.');
  }

  const keepEmail = String(process.env.QA_KEEP_SUPERADMIN_EMAIL || '').trim().toLowerCase();
  const keepPhone = String(process.env.QA_KEEP_SUPERADMIN_PHONE || '').trim();

  if (keepEmail && keepPhone) {
    throw new Error('Abortado: usa solo QA_KEEP_SUPERADMIN_EMAIL o QA_KEEP_SUPERADMIN_PHONE, no ambos.');
  }

  if (!keepEmail && !keepPhone) {
    return {
      rule: 'keep_all_super_admins',
      rows,
      keepIds: rows.map((row) => row.id_login)
    };
  }

  if (keepEmail) {
    const matching = rows.filter((row) => String(row.email || '').trim().toLowerCase() === keepEmail);
    if (matching.length !== 1) {
      throw new Error(`Abortado: QA_KEEP_SUPERADMIN_EMAIL=${keepEmail} no coincide exactamente con un super_admin.`);
    }

    return {
      rule: 'keep_single_super_admin_by_email',
      rows,
      keepIds: matching.map((row) => row.id_login)
    };
  }

  const matchingByPhone = rows.filter((row) => String(row.telephone || '').trim() === keepPhone);
  if (matchingByPhone.length !== 1) {
    throw new Error(`Abortado: QA_KEEP_SUPERADMIN_PHONE=${keepPhone} no coincide exactamente con un super_admin.`);
  }

  return {
    rule: 'keep_single_super_admin_by_phone',
    rows,
    keepIds: matchingByPhone.map((row) => row.id_login)
  };
}

async function deleteAllOperationalData(keepLoginIds, transaction = null) {
  const keepIds = unique(keepLoginIds);
  if (!keepIds.length) {
    throw new Error('Abortado: deleteAllOperationalData requiere al menos un super_admin a conservar.');
  }

  const summary = [];

  for (const table of FULL_RESET_DELETE_ORDER) {
    if (table === 'clinical_history_template_events' || table === 'clinical_history_template_versions' || table === 'clinical_history_templates') {
      continue;
    }

    if (table === 'login') {
      summary.push(await deleteRows('login', 'id_login NOT IN (:keepIds)', { keepIds }, transaction));
      continue;
    }

    if (table === 'login_image_configuration' || table === 'ui_theme_configuration') {
      summary.push(await deleteRows(table, 'id_business IS NOT NULL', {}, transaction));
      continue;
    }

    if (table === 'person') {
      summary.push(await deleteRows('person', '', {}, transaction));
      continue;
    }

    if (table === 'business') {
      summary.push(await deleteRows('business', '', {}, transaction));
      continue;
    }

    summary.push(await deleteRows(table, '', {}, transaction));
  }

  if (await tableExists('clinical_history_templates')) {
    const tenantTemplates = await selectValues(
      `SELECT id_clinical_history_template AS value
         FROM clinical_history_templates
        WHERE business_id IS NOT NULL`,
      {},
      transaction
    );
    summary.push(...await deleteClinicalTemplatesForIds(tenantTemplates.map((row) => row.value), transaction));
  }

  return summary;
}

async function roleByCode(code, transaction = null) {
  const rows = await selectValues(
    `SELECT id_rol, code, desc_rol
       FROM rol
      WHERE code COLLATE ${TENANT_COLLATION} = :code COLLATE ${TENANT_COLLATION}
        AND active = 1
      LIMIT 1`,
    { code },
    transaction
  );
  return rows[0] || null;
}

async function firstAvailableRole(codes, transaction = null) {
  for (const code of codes) {
    const role = await roleByCode(code, transaction);
    if (role) {
      return role;
    }
  }
  return null;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateTime(date, time = '09:00:00') {
  return `${isoDate(date)} ${time}`;
}

function parseReferenceDate() {
  const raw = process.env.QA_SEED_REFERENCE_DATE;
  const date = raw ? new Date(`${raw}T12:00:00`) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error('QA_SEED_REFERENCE_DATE debe usar formato YYYY-MM-DD.');
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
}

function monthDay(referenceDate, day, monthOffset = 0) {
  const first = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + monthOffset, 1, 12, 0, 0, 0);
  const last = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + monthOffset + 1, 0, 12, 0, 0, 0);
  const normalizedDay = Math.max(1, Math.min(day, last.getDate()));
  return new Date(first.getFullYear(), first.getMonth(), normalizedDay, 12, 0, 0, 0);
}

function monthRange(referenceDate, monthOffset = 0) {
  return {
    from: isoDate(monthDay(referenceDate, 1, monthOffset)),
    to: isoDate(monthDay(referenceDate, 31, monthOffset))
  };
}

function stableId(prefix, index) {
  return `${prefix}_${String(index).padStart(2, '0')}`;
}

function safeJson(value) {
  return JSON.stringify(value);
}

async function resetQaDemoData(transaction = null) {
  const ids = await getQaBusinessIds(transaction);
  if (!ids.length) {
    return [];
  }
  return deleteDataForBusinessIds(ids, transaction);
}

async function closeConnection() {
  await sequelize.close();
}

module.exports = {
  APPOINTMENT_STATUSES,
  AUTH_RUNTIME_TABLES,
  AUDIT_TABLES,
  CATALOG_TABLES,
  CLINICAL_HISTORY_STATUSES,
  CREATED_BY,
  DOCUMENT_STATUSES,
  PATIENT_TREATMENT_STATUSES,
  PASSWORD,
  PRESCRIPTION_STATUSES,
  QA_BUSINESSES,
  ROLE_CODES,
  SIGNATURE_REQUEST_STATUSES,
  STRUCTURAL_KEEP_TABLES,
  TENANT_OPERATIONAL_TABLES,
  TREATMENT_PLAN_STATUSES,
  addDays,
  addMonths,
  assertExplicitFlag,
  assertNotProductionLike,
  assertWritableDbAllowed,
  closeConnection,
  countRows,
  dateTime,
  dbTarget,
  deleteAllOperationalData,
  deleteDataForBusinessIds,
  deleteRows,
  existingTables,
  firstAvailableRole,
  getQaBusinessIds,
  isoDate,
  monthDay,
  monthRange,
  parseReferenceDate,
  resetQaDemoData,
  roleByCode,
  safeDbTarget,
  safeJson,
  selectValues,
  sequelize,
  stableId,
  superAdminRows,
  tableExists,
  encript,
  resolveSuperAdminsToKeep
};
