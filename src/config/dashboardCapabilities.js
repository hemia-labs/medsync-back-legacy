const { getSaasPlan } = require('./saasPlans');

const BASIC_DASHBOARD_CAPABILITIES = Object.freeze({
    planStatus: true,
    licenseUsage: true,
    basicActivity: true,
    administrativeAlerts: true,
    trends: false,
    operationalAnalysis: false,
    teamBreakdown: false,
    branchBreakdown: false,
    professionalBreakdown: false,
    advancedReports: false
});

const DASHBOARD_CAPABILITIES_BY_PLAN = Object.freeze({
    basic: {
        level: 'simple',
        widgets: BASIC_DASHBOARD_CAPABILITIES
    },
    pro: {
        level: 'operational',
        widgets: {
            ...BASIC_DASHBOARD_CAPABILITIES,
            trends: true,
            operationalAnalysis: true
        }
    },
    enterprise: {
        level: 'administrative',
        widgets: {
            ...BASIC_DASHBOARD_CAPABILITIES,
            trends: true,
            operationalAnalysis: true,
            teamBreakdown: true,
            branchBreakdown: false,
            professionalBreakdown: true,
            advancedReports: true
        }
    }
});

const DASHBOARD_ACCESS_PERMISSIONS = Object.freeze([
    'dashboard.tenant',
    'reports.dashboard',
    'dashboard'
]);

function normalizePlanCode(planCode) {
    return String(planCode || '').trim().toLowerCase();
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function getEffectiveDashboardCapabilities(planCode) {
    const normalizedPlan = normalizePlanCode(planCode);
    const plan = getSaasPlan(normalizedPlan);
    const effectivePlanCode = DASHBOARD_CAPABILITIES_BY_PLAN[normalizedPlan] ? normalizedPlan : 'basic';
    const effectivePlan = getSaasPlan(effectivePlanCode);
    const config = DASHBOARD_CAPABILITIES_BY_PLAN[effectivePlanCode];

    return {
        level: config.level,
        planLabel: effectivePlan ? effectivePlan.name : 'Individual',
        sourcePlan: plan ? normalizedPlan : null,
        fallbackApplied: !plan || effectivePlanCode !== normalizedPlan,
        capabilities: clone(config.widgets)
    };
}

module.exports = {
    DASHBOARD_ACCESS_PERMISSIONS,
    DASHBOARD_CAPABILITIES_BY_PLAN,
    getEffectiveDashboardCapabilities
};
