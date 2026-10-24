'use strict';

const { QueryTypes } = require('sequelize');
const {
  APPOINTMENT_STATUSES,
  AUTH_RUNTIME_TABLES,
  AUDIT_TABLES,
  CATALOG_TABLES,
  CLINICAL_HISTORY_STATUSES,
  DOCUMENT_STATUSES,
  PRESCRIPTION_STATUSES,
  QA_BUSINESSES,
  STRUCTURAL_KEEP_TABLES,
  TENANT_OPERATIONAL_TABLES,
  closeConnection,
  countRows,
  existingTables,
  safeDbTarget,
  selectValues,
  sequelize,
  superAdminRows,
  tableExists
} = require('./qa-demo-db-utils');

async function groupByStatus(table, statusColumn, where = '', replacements = {}) {
  if (!(await tableExists(table))) {
    return [];
  }

  return selectValues(
    `SELECT COALESCE(${statusColumn}, 'unknown') AS status, COUNT(*) AS total
       FROM \`${table}\`
       ${where ? `WHERE ${where}` : ''}
      GROUP BY COALESCE(${statusColumn}, 'unknown')
      ORDER BY status`,
    replacements
  );
}

async function countByBusiness(table, businessColumn = 'id_business') {
  if (!(await tableExists(table))) {
    return [];
  }

  return selectValues(
    `SELECT COALESCE(${businessColumn}, '[global/null]') AS id_business, COUNT(*) AS total
       FROM \`${table}\`
      GROUP BY COALESCE(${businessColumn}, '[global/null]')
      ORDER BY total DESC, id_business`
  );
}

async function userCountsByRole() {
  if (!(await tableExists('login')) || !(await tableExists('rol'))) {
    return [];
  }

  return selectValues(
    `SELECT COALESCE(r.code, 'unknown') AS role,
            COALESCE(l.id_business, '[global/null]') AS id_business,
            SUM(CASE WHEN l.active = 1 THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN COALESCE(l.active, 0) = 0 THEN 1 ELSE 0 END) AS inactive,
            COUNT(*) AS total
       FROM login l
       LEFT JOIN rol r
              ON r.id_rol COLLATE utf8mb4_unicode_ci = l.id_rol COLLATE utf8mb4_unicode_ci
      GROUP BY COALESCE(r.code, 'unknown'), COALESCE(l.id_business, '[global/null]')
      ORDER BY role, id_business`
  );
}

async function dashboardRelevantCounts() {
  const counts = {
    businesses: await countRows('business'),
    users: await countRows('login'),
    patients: await countRows('person'),
    appointments: await countRows('appointment'),
    prescriptions: await countRows('prescription'),
    patientDocuments: await countRows('patient_documents'),
    clinicalHistories: await countRows('clinical_histories'),
    followUps: await countRows('tracing'),
    treatmentPlans: await countRows('treatment_plan'),
    patientTreatments: await countRows('patient_treatment'),
    sessions: await countRows('session'),
    refreshTokens: await countRows('refresh_token'),
    passwordChangeTokens: await countRows('auth_password_change_tokens'),
    passwordResetTokens: await countRows('auth_password_reset_tokens')
  };

  return counts;
}

async function tableCounts(tables) {
  const rows = [];
  for (const table of tables) {
    rows.push({
      table,
      exists: await tableExists(table),
      total: await countRows(table)
    });
  }
  return rows;
}

async function qaExistingScope() {
  const definitions = Object.values(QA_BUSINESSES);
  if (!(await tableExists('business'))) {
    return [];
  }

  return selectValues(
    `SELECT b.id_business, b.name, b.slug, b.plan, b.status, b.subscription_status,
            COUNT(DISTINCT l.id_login) AS users,
            COUNT(DISTINCT p.id_person) AS patients
       FROM business b
       LEFT JOIN login l
              ON l.id_business COLLATE utf8mb4_unicode_ci = b.id_business COLLATE utf8mb4_unicode_ci
       LEFT JOIN person p
              ON p.id_business COLLATE utf8mb4_unicode_ci = b.id_business COLLATE utf8mb4_unicode_ci
      WHERE b.id_business IN (:ids)
         OR b.slug IN (:slugs)
         OR b.name IN (:names)
         OR b.created_by = 'QA_DEMO_SEED'
      GROUP BY b.id_business, b.name, b.slug, b.plan, b.status, b.subscription_status
      ORDER BY b.name`,
    {
      ids: definitions.map((item) => item.id),
      slugs: definitions.map((item) => item.slug),
      names: definitions.map((item) => item.name)
    }
  );
}

async function liveForeignKeys() {
  const rows = await sequelize.query(
    `SELECT TABLE_NAME AS tableName,
            COLUMN_NAME AS columnName,
            REFERENCED_TABLE_NAME AS referencedTable,
            REFERENCED_COLUMN_NAME AS referencedColumn
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, COLUMN_NAME`,
    { type: QueryTypes.SELECT }
  );
  return rows;
}

function maskEmail(value) {
  const email = String(value || '').trim();
  const at = email.indexOf('@');
  if (at <= 1) {
    return email ? '[redacted-email]' : null;
  }
  return `${email.slice(0, 2)}***${email.slice(at)}`;
}

function maskPhone(value) {
  const phone = String(value || '').trim();
  if (!phone) {
    return null;
  }
  return phone.length <= 4 ? '****' : `${'*'.repeat(Math.max(phone.length - 4, 4))}${phone.slice(-4)}`;
}

async function buildInventory() {
  const [
    existingCatalogTables,
    existingStructuralTables,
    existingOperationalTables,
    existingAuthTables,
    existingAuditTables,
    superAdmins,
    totals,
    roles,
    qaScope,
    foreignKeys
  ] = await Promise.all([
    existingTables(CATALOG_TABLES),
    existingTables(STRUCTURAL_KEEP_TABLES),
    existingTables(TENANT_OPERATIONAL_TABLES),
    existingTables(AUTH_RUNTIME_TABLES),
    existingTables(AUDIT_TABLES),
    superAdminRows(),
    dashboardRelevantCounts(),
    userCountsByRole(),
    qaExistingScope(),
    liveForeignKeys()
  ]);

  return {
    generatedAt: new Date().toISOString(),
    dbTarget: safeDbTarget(),
    totals,
    superAdmins: superAdmins.map((row) => ({
      id_login: row.id_login,
      email: maskEmail(row.email),
      telephone: maskPhone(row.telephone),
      active: Number(row.active || 0)
    })),
    usersByRole: roles,
    statusCounts: {
      appointments: {
        knownStatuses: APPOINTMENT_STATUSES,
        rows: await groupByStatus('appointment', 'status')
      },
      prescriptions: {
        knownStatuses: PRESCRIPTION_STATUSES,
        rows: await groupByStatus('prescription', 'status')
      },
      documents: {
        knownStatuses: DOCUMENT_STATUSES,
        rows: await groupByStatus('patient_documents', 'status')
      },
      clinicalHistories: {
        knownStatuses: CLINICAL_HISTORY_STATUSES,
        rows: await groupByStatus('clinical_histories', 'status')
      }
    },
    byBusiness: {
      patients: await countByBusiness('person'),
      appointments: await countByBusiness('appointment'),
      prescriptions: await countByBusiness('prescription'),
      documents: await countByBusiness('patient_documents'),
      clinicalHistories: await countByBusiness('clinical_histories', 'business_id'),
      followUps: await countByBusiness('tracing'),
      treatmentPlans: await countByBusiness('treatment_plan'),
      patientTreatments: await countByBusiness('patient_treatment')
    },
    qaScope,
    tableClassification: {
      catalogOrStructuralKeep: existingStructuralTables,
      operationalTenantData: existingOperationalTables,
      authRuntimeData: existingAuthTables,
      auditData: existingAuditTables
    },
    tableCounts: {
      keep: await tableCounts(existingStructuralTables),
      clean: await tableCounts([...existingOperationalTables, ...existingAuthTables, ...existingAuditTables])
    },
    foreignKeys
  };
}

function printHumanSummary(inventory) {
  console.log('QA DB reset scope inventory');
  console.log('DB target:', inventory.dbTarget);
  console.log('Totals:', inventory.totals);
  console.log('Super admins to review:', inventory.superAdmins);
  console.log('Existing QA scope:', inventory.qaScope);
  console.log('Appointment statuses:', inventory.statusCounts.appointments.rows);
  console.log('Prescription statuses:', inventory.statusCounts.prescriptions.rows);
  console.log('Document statuses:', inventory.statusCounts.documents.rows);
  console.log('Clinical history statuses:', inventory.statusCounts.clinicalHistories.rows);
  console.log('Tables kept structurally:', inventory.tableClassification.catalogOrStructuralKeep.length);
  console.log('Tables considered operational:', inventory.tableClassification.operationalTenantData.length);
  console.log('Foreign keys found:', inventory.foreignKeys.length);
}

async function main() {
  const inventory = await buildInventory();
  printHumanSummary(inventory);
  console.log('\nJSON inventory');
  console.log(JSON.stringify(inventory, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnection();
  });
