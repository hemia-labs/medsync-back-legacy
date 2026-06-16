'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../db/Sequelize.connection');
const { canMutateTrials, getSaasJobsConfig } = require('../config/saasJobs');

const JOB_NAME = 'saas_trial_lifecycle';
const AUDIT_ACTION_TRIAL_EXPIRED_TO_PAST_DUE = 'SUPER_ADMIN_TRIAL_EXPIRED_TO_PAST_DUE';
const DAY_MS = 24 * 60 * 60 * 1000;

function compactBusiness(row) {
  return {
    id_business: row.id_business,
    name: row.name,
    subscription_status: row.subscription_status,
    plan: row.plan,
    trial_ends_at: row.trial_ends_at || null
  };
}

async function getTrialLifecycleSnapshot(config = getSaasJobsConfig()) {
  const [expiredTrials, trialsExpiringSoon] = await Promise.all([
    sequelize.query(
      `SELECT id_business, name, subscription_status, plan, trial_ends_at
         FROM business
        WHERE subscription_status = 'trial'
          AND active = 1
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < NOW()
        ORDER BY trial_ends_at ASC`,
      { type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT id_business, name, subscription_status, plan, trial_ends_at
         FROM business
        WHERE subscription_status = 'trial'
          AND active = 1
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at >= NOW()
          AND trial_ends_at <= DATE_ADD(NOW(), INTERVAL :days DAY)
        ORDER BY trial_ends_at ASC`,
      {
        replacements: { days: config.expiringSoonDays },
        type: QueryTypes.SELECT
      }
    )
  ]);

  return {
    expiredTrials,
    trialsExpiringSoon
  };
}

async function recordJobAudit(transaction, business, config) {
  await sequelize.query(
    `INSERT INTO admin_audit_log (
        id_admin_audit_log,
        actor_login_id,
        actor_role,
        action,
        target_type,
        target_id,
        target_business_id,
        metadata_json,
        created_at
    ) VALUES (
        UUID(),
        'system',
        'saas_job',
        :action,
        'business',
        :business_id,
        :business_id,
        :metadata,
        NOW()
    )`,
    {
      replacements: {
        action: AUDIT_ACTION_TRIAL_EXPIRED_TO_PAST_DUE,
        business_id: business.id_business,
        metadata: JSON.stringify({
          business_id: business.id_business,
          previous_subscription_status: 'trial',
          new_subscription_status: 'past_due',
          trial_ends_at: business.trial_ends_at || null,
          job: JOB_NAME,
          mode: config.mode
        })
      },
      transaction,
      type: QueryTypes.INSERT
    }
  );
}

async function markExpiredTrialsPastDue(expiredTrials, config) {
  const updated = [];

  for (const business of expiredTrials) {
    await sequelize.transaction(async (transaction) => {
      const result = await sequelize.query(
        `UPDATE business
            SET subscription_status = 'past_due',
                status_reason = 'Trial vencido automáticamente',
                updated_at = NOW(),
                updated_by = 'saas_job'
          WHERE id_business = :business_id
            AND subscription_status = 'trial'
            AND trial_ends_at IS NOT NULL
            AND trial_ends_at < NOW()`,
        {
          replacements: { business_id: business.id_business },
          transaction,
          type: QueryTypes.UPDATE
        }
      );

      const metadata = Array.isArray(result) ? result[1] : result;
      const affected = typeof metadata === 'number'
        ? metadata
        : Number(metadata && (metadata.affectedRows || metadata.rowCount || 0));

      if (affected > 0) {
        await recordJobAudit(transaction, business, config);
        updated.push(compactBusiness({
          ...business,
          subscription_status: 'past_due'
        }));
      }
    });
  }

  return updated;
}

async function runTrialLifecycleJob(options = {}) {
  const config = getSaasJobsConfig();
  const dryRun = options.dryRun !== false;
  const snapshot = await getTrialLifecycleSnapshot(config);
  const canUpdate = dryRun === false && canMutateTrials(config);
  const updatedBusinesses = canUpdate
    ? await markExpiredTrialsPastDue(snapshot.expiredTrials, config)
    : [];

  return {
    job: JOB_NAME,
    dryRun,
    jobsEnabled: config.jobsEnabled,
    trialExpirationJobEnabled: config.trialExpirationJobEnabled,
    mode: config.mode,
    expiringSoonDays: config.expiringSoonDays,
    expiredTrials: snapshot.expiredTrials.length,
    trialsExpiringSoon: snapshot.trialsExpiringSoon.length,
    updatedBusinesses: updatedBusinesses.length,
    canMutate: canMutateTrials(config),
    blockedReason: canUpdate || dryRun
      ? null
      : 'SAAS_JOBS_ENABLED, SAAS_TRIAL_EXPIRATION_JOB_ENABLED y modo mark_past_due son requeridos para modificar negocios.',
    expiredTrialBusinesses: snapshot.expiredTrials.slice(0, 20).map(compactBusiness),
    trialsExpiringSoonBusinesses: snapshot.trialsExpiringSoon.slice(0, 20).map(compactBusiness),
    updatedBusinessIds: updatedBusinesses.map((business) => business.id_business)
  };
}

async function getTrialLifecycleStatus() {
  return runTrialLifecycleJob({ dryRun: true });
}

function startSaasTrialLifecycleJob(logger = console) {
  const config = getSaasJobsConfig();

  if (!config.jobsEnabled || !config.trialExpirationJobEnabled) {
    logger.info('[SAAS JOBS] Trial lifecycle job disabled.');
    return null;
  }

  logger.info(`[SAAS JOBS] Trial lifecycle job enabled in mode=${config.mode}.`);

  const execute = async () => {
    try {
      const result = await runTrialLifecycleJob({ dryRun: false });
      logger.info(`[SAAS JOBS] Trial lifecycle run completed. expired=${result.expiredTrials} expiringSoon=${result.trialsExpiringSoon} updated=${result.updatedBusinesses}`);
    } catch (error) {
      logger.error('[SAAS JOBS] Trial lifecycle run failed.');
    }
  };

  execute();
  return setInterval(execute, DAY_MS);
}

module.exports = {
  AUDIT_ACTION_TRIAL_EXPIRED_TO_PAST_DUE,
  JOB_NAME,
  getTrialLifecycleStatus,
  runTrialLifecycleJob,
  startSaasTrialLifecycleJob
};
