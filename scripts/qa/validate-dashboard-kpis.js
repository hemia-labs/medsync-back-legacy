'use strict';

const { QueryTypes } = require('sequelize');
const {
  QA_BUSINESSES,
  assertNotProductionLike,
  closeConnection,
  isoDate,
  monthRange,
  parseReferenceDate,
  safeDbTarget,
  sequelize
} = require('./qa-demo-db-utils');
const BusinessDashboardDao = require('../../src/Dao/mysql/businessDashboard.dao');
const { getBusinessPlanFeatures } = require('../../src/util/planFeatures');

const OK = 200;

function statusCount(items, status) {
  const match = (items || []).find((item) => String(item.status || '') === status);
  return match ? Number(match.count || 0) : 0;
}

function blockedOrFailed(response) {
  return {
    status: response ? response.status : null,
    message: response ? response.message : 'Sin respuesta',
    data: response ? response.data : null
  };
}

function requireOk(label, response) {
  if (!response || response.status !== OK) {
    throw new Error(`${label} fallo: ${JSON.stringify(blockedOrFailed(response))}`);
  }
  return response.data;
}

function summarizeOperational(data) {
  const appointmentHealth = data.decisionMetrics && data.decisionMetrics.appointmentHealth
    ? data.decisionMetrics.appointmentHealth
    : {};
  const followUps = data.decisionMetrics && data.decisionMetrics.followUps
    ? data.decisionMetrics.followUps
    : {};
  const clinicalHistories = data.clinicalHistories || {};
  const prescriptions = data.prescriptions || {};
  const treatmentEconomics = data.decisionMetrics && data.decisionMetrics.treatmentEconomics
    ? data.decisionMetrics.treatmentEconomics
    : {};

  const followUpsWithoutAppointment = Math.max(Number(followUps.due || 0) - Number(followUps.scheduled || 0), 0);
  const overdueFollowUpsWithoutAppointment = followUps.overdueWithoutAppointment;
  const priorityScore =
    Number(appointmentHealth.pendingConfirmation || 0) * 4
    + Number(overdueFollowUpsWithoutAppointment || 0) * 4
    + Number(clinicalHistories.pending || 0) * 3
    + Number(appointmentHealth.noShow || 0) * 3
    + Number(prescriptions.drafts || 0) * 2
    + Number(appointmentHealth.cancelled || 0) * 2;

  return {
    appointmentsScheduled: data.appointments ? data.appointments.scheduled : 0,
    appointmentsByStatus: {
      confirmed: statusCount(data.appointments && data.appointments.byStatus, 'confirmed'),
      cancelled: statusCount(data.appointments && data.appointments.byStatus, 'cancelled'),
      pending_confirmation: statusCount(data.appointments && data.appointments.byStatus, 'pending_confirmation'),
      completed: statusCount(data.appointments && data.appointments.byStatus, 'completed'),
      rescheduled: statusCount(data.appointments && data.appointments.byStatus, 'rescheduled'),
      no_show: statusCount(data.appointments && data.appointments.byStatus, 'no_show')
    },
    prescriptions: {
      issued: prescriptions.issued || 0,
      drafts: prescriptions.drafts || 0,
      cancelled: prescriptions.cancelled || 0
    },
    clinicalHistories: {
      finalized: clinicalHistories.finalized || 0,
      drafts: clinicalHistories.drafts || 0,
      pending: clinicalHistories.pending || 0
    },
    retention: data.decisionMetrics ? data.decisionMetrics.retention : null,
    followUps: {
      due: followUps.due || 0,
      scheduled: followUps.scheduled || 0,
      withoutAppointment: followUpsWithoutAppointment,
      overdueWithoutAppointment: overdueFollowUpsWithoutAppointment,
      upcomingWithoutAppointment: followUps.upcomingWithoutAppointment,
      asOfDate: followUps.asOfDate,
      timeZone: followUps.timeZone,
      coverageRate: followUps.coverageRate === undefined ? null : followUps.coverageRate
    },
    treatmentEconomics,
    priorityScore,
    priorityInput: {
      pendingConfirmation: appointmentHealth.pendingConfirmation || 0,
      overdueFollowUpsWithoutAppointment,
      clinicalPending: clinicalHistories.pending || 0,
      noShow: appointmentHealth.noShow || 0,
      prescriptionDrafts: prescriptions.drafts || 0,
      cancelled: appointmentHealth.cancelled || 0
    }
  };
}

async function findDemoBusiness(demo) {
  const rows = await sequelize.query(
    `SELECT id_business, name, slug, plan, active
       FROM business
      WHERE id_business = :id
         OR slug = :slug
      LIMIT 1`,
    {
      replacements: {
        id: demo.id,
        slug: demo.slug
      },
      type: QueryTypes.SELECT
    }
  );

  return rows[0] || null;
}

async function validateDemo(demo, range) {
  const business = await findDemoBusiness(demo);

  if (!business) {
    return {
      key: demo.key,
      found: false,
      message: 'Tenant QA no encontrado. Ejecuta seed-demo-consultorios.js en una base QA/local.'
    };
  }

  const planFeatures = await getBusinessPlanFeatures(business.id_business);
  const capabilities = planFeatures && planFeatures.capabilities ? planFeatures.capabilities : {};
  const auditContext = {
    actorLoginId: demo.mainUser.id,
    endpoint: 'scripts/qa/validate-dashboard-kpis.js',
    method: 'SCRIPT',
    action: 'validate_dashboard_kpis'
  };

  const summary = requireOk(
    `${demo.key}.summary`,
    await BusinessDashboardDao.summary(business.id_business, range)
  );
  const trends = capabilities.trends
    ? requireOk(
      `${demo.key}.trends`,
      await BusinessDashboardDao.trends(business.id_business, { ...range, granularity: 'month' }, auditContext)
    )
    : null;
  const operational = capabilities.operationalAnalysis
    ? requireOk(
      `${demo.key}.operationalSummary`,
      await BusinessDashboardDao.operationalSummary(business.id_business, range, auditContext)
    )
    : null;
  const professional = capabilities.professionalBreakdown
    ? requireOk(
      `${demo.key}.professionalBreakdown`,
      await BusinessDashboardDao.professionalBreakdown(business.id_business, range, auditContext)
    )
    : null;
  const team = capabilities.teamBreakdown
    ? requireOk(
      `${demo.key}.teamBreakdown`,
      await BusinessDashboardDao.teamBreakdown(business.id_business, range, auditContext)
    )
    : null;

  return {
    key: demo.key,
    found: true,
    business,
    plan: planFeatures && planFeatures.plan ? planFeatures.plan.code : business.plan,
    capabilities,
    range,
    activity: summary.activity,
    trendSeriesLength: trends ? trends.series.length : 0,
    operational: operational ? summarizeOperational(operational) : null,
    professionalBreakdown: professional
      ? {
        displayMode: professional.displayMode,
        items: professional.items
      }
      : 'No incluido en esta licencia',
    teamBreakdown: team
      ? {
        users: team.users,
        roles: team.roles,
        limits: team.limits
      }
      : 'No incluido en esta licencia'
  };
}

async function run() {
  assertNotProductionLike();

  const referenceDate = parseReferenceDate();
  const range = process.env.QA_KPI_FROM && process.env.QA_KPI_TO
    ? { from: process.env.QA_KPI_FROM, to: process.env.QA_KPI_TO }
    : monthRange(referenceDate, 0);

  console.log('Dashboard KPI validation target:', safeDbTarget());
  console.log('Reference date:', isoDate(referenceDate));
  console.log('Range:', `${range.from} -> ${range.to}`);

  const results = [];
  for (const demo of Object.values(QA_BUSINESSES)) {
    results.push(await validateDemo(demo, range));
  }

  console.log(JSON.stringify(results, null, 2));

  if (results.some((item) => !item.found)) {
    process.exitCode = 1;
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
