'use strict';

const {
  assertExplicitFlag,
  assertWritableDbAllowed,
  closeConnection,
  countRows,
  deleteAllOperationalData,
  resolveSuperAdminsToKeep,
  safeDbTarget,
  sequelize,
  superAdminRows
} = require('./qa-demo-db-utils');

async function totals() {
  const tables = [
    'business',
    'login',
    'person',
    'appointment',
    'prescription',
    'patient_documents',
    'clinical_histories',
    'tracing',
    'treatment_plan',
    'patient_treatment',
    'session',
    'refresh_token',
    'auth_password_reset_tokens',
    'admin_audit_log'
  ];

  const result = {};
  for (const table of tables) {
    result[table] = await countRows(table);
  }
  return result;
}

function printDeletionSummary(label, rows) {
  console.log(label);
  rows
    .filter((row) => !row.skipped && Number(row.deleted || 0) > 0)
    .forEach((row) => {
      console.log(`- ${row.table}: ${row.deleted}`);
    });

  const deletedTotal = rows.reduce((acc, row) => acc + Number(row.deleted || 0), 0);
  console.log(`Total rows deleted: ${deletedTotal}`);
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

function safeSuperAdminRows(rows) {
  return (rows || []).map((row) => ({
    id_login: row.id_login,
    email: maskEmail(row.email),
    telephone: maskPhone(row.telephone),
    active: Number(row.active || 0)
  }));
}

async function run() {
  assertExplicitFlag('ALLOW_QA_DB_RESET', 'YES');
  assertWritableDbAllowed();

  console.log('QA DB reset target:', safeDbTarget());
  console.log('Before totals:', await totals());

  const transaction = await sequelize.transaction();
  try {
    const keep = await resolveSuperAdminsToKeep(transaction);
    console.log('Super admin keep rule:', keep.rule);
    console.log('Super admins found:', safeSuperAdminRows(keep.rows));
    console.log('Super admin ids kept:', keep.keepIds);

    const deletionSummary = await deleteAllOperationalData(keep.keepIds, transaction);
    await transaction.commit();

    printDeletionSummary('Deletion summary', deletionSummary);
    console.log('After totals:', await totals());
    console.log('Remaining super admins:', safeSuperAdminRows(await superAdminRows()));
    console.log('Reset completed. Catalogs, roles, permissions and selected super_admin login rows were preserved.');
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnection();
  });
