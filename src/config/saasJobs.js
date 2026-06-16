'use strict';

const MODES = ['alert_only', 'mark_past_due'];
const DEFAULT_EXPIRING_SOON_DAYS = 7;

function parseBoolean(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function parseExpiringSoonDays(value) {
  const parsed = Number(value || DEFAULT_EXPIRING_SOON_DAYS);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
    return DEFAULT_EXPIRING_SOON_DAYS;
  }

  return parsed;
}

function getTrialExpirationMode() {
  const mode = String(process.env.SAAS_TRIAL_EXPIRATION_JOB_MODE || 'alert_only').toLowerCase();
  return MODES.includes(mode) ? mode : 'alert_only';
}

function getSaasJobsConfig() {
  return {
    jobsEnabled: parseBoolean(process.env.SAAS_JOBS_ENABLED),
    trialExpirationJobEnabled: parseBoolean(process.env.SAAS_TRIAL_EXPIRATION_JOB_ENABLED),
    mode: getTrialExpirationMode(),
    expiringSoonDays: parseExpiringSoonDays(process.env.SAAS_TRIAL_EXPIRING_SOON_DAYS)
  };
}

function canMutateTrials(config = getSaasJobsConfig()) {
  return config.jobsEnabled === true
    && config.trialExpirationJobEnabled === true
    && config.mode === 'mark_past_due';
}

module.exports = {
  DEFAULT_EXPIRING_SOON_DAYS,
  MODES,
  canMutateTrials,
  getSaasJobsConfig
};
