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
            operationalAnalysis: true,
            teamBreakdown: true
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

function getEffectiveDashboardCapabilities(planCode, billingFeatures) {
    const normalizedPlan = normalizePlanCode(planCode);
    const plan = getSaasPlan(normalizedPlan);
    const effectivePlanCode = plan && DASHBOARD_CAPABILITIES_BY_PLAN[plan.code] ? plan.code : 'basic';
    const effectivePlan = getSaasPlan(effectivePlanCode);
    const config = DASHBOARD_CAPABILITIES_BY_PLAN[effectivePlanCode];

    const capabilities = clone(config.widgets);
    if (billingFeatures) {
        const basic = billingFeatures['dashboard.basic'] === true || billingFeatures['dashboard.operational'] === true || billingFeatures['dashboard.admin'] === true;
        const operational = billingFeatures['dashboard.operational'] === true || billingFeatures['dashboard.admin'] === true;
        Object.keys(capabilities).forEach(key => {
            const entitlement = ['trends','operationalAnalysis','teamBreakdown'].includes(key) ? operational
                : ['professionalBreakdown','advancedReports'].includes(key) ? billingFeatures['dashboard.admin'] === true : basic;
            capabilities[key] = capabilities[key] && entitlement;
        });
    }
    return {
        level: config.level,
        planLabel: effectivePlan ? effectivePlan.name : 'Individual',
        sourcePlan: plan ? normalizedPlan : null,
        fallbackApplied: !plan || effectivePlanCode !== plan.code,
        capabilities
    };
}

module.exports = {
    DASHBOARD_ACCESS_PERMISSIONS,
    DASHBOARD_CAPABILITIES_BY_PLAN,
    getEffectiveDashboardCapabilities
};
