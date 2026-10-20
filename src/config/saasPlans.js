const SAAS_PLANS = {
    basic: {
        code: 'basic',
        name: 'Individual',
        description: 'Para profesional independiente con apoyo administrativo.',
        monthlyPriceMxn: 499,
        founderMonthlyPriceMxn: 399,
        founderPriceMonths: 12,
        currency: 'MXN',
        maxProfessionals: 1,
        maxAuxiliaryUsers: 1,
        maxStaffUsers: 1,
        // Placeholder tecnico interno: no promocionar como multi-sucursal.
        maxBranches: 1,
        patientsLimit: null,
        fairUsePatients: true,
        recommended: false,
        publicLabel: '$499 MXN + IVA / mes',
        founderLabel: '$399 MXN + IVA / mes durante 12 meses',
        limitsSummary: '1 profesional + 1 usuario interno',
        features: [
            '1 profesional',
            '1 usuario interno / recepcion',
            '1 negocio / consultorio',
            'Pacientes ilimitados con uso razonable',
            'Agenda basica',
            'Expediente clinico',
            'Historia clinica',
            'Recetas',
            'Documentos basicos',
            'Consentimientos basicos si existen',
            'Configuracion basica del consultorio',
            'Dashboard basico',
            'Soporte estandar'
        ]
    },
    pro: {
        code: 'pro',
        name: 'Profesional',
        description: 'Para consultorios con mas operacion y equipo interno.',
        monthlyPriceMxn: 799,
        founderMonthlyPriceMxn: 649,
        founderPriceMonths: 12,
        currency: 'MXN',
        maxProfessionals: 1,
        maxAuxiliaryUsers: 3,
        maxStaffUsers: 3,
        // Placeholder tecnico interno: no promocionar como multi-sucursal.
        maxBranches: 1,
        patientsLimit: null,
        fairUsePatients: true,
        recommended: true,
        publicLabel: '$799 MXN + IVA / mes',
        founderLabel: '$649 MXN + IVA / mes durante 12 meses',
        limitsSummary: '1 profesional + 3 usuarios internos',
        features: [
            '1 profesional principal',
            'Hasta 3 usuarios internos',
            '1 negocio / consultorio',
            'Pacientes ilimitados con uso razonable',
            'Agenda avanzada',
            'Expediente clinico',
            'Historia clinica',
            'Recetas',
            'Documentos',
            'Consentimientos',
            'Plantillas clinicas personalizables',
            'Gestion mas completa de citas',
            'Dashboard operativo',
            'Vista administrativa del equipo',
            'Reportes basicos',
            'Soporte prioritario',
            'Onboarding asistido'
        ]
    },
    enterprise: {
        code: 'enterprise',
        name: 'Clinica',
        description: 'Para clinicas pequenas o equipos con varios profesionales.',
        monthlyPriceMxn: 1499,
        founderMonthlyPriceMxn: 1199,
        founderPriceMonths: 12,
        currency: 'MXN',
        maxProfessionals: 3,
        maxAuxiliaryUsers: 8,
        maxStaffUsers: 8,
        // Placeholder tecnico interno: no promocionar como multi-sucursal.
        maxBranches: 1,
        patientsLimit: null,
        fairUsePatients: true,
        recommended: false,
        publicLabel: '$1,499 MXN + IVA / mes',
        founderLabel: '$1,199 MXN + IVA / mes durante 12 meses',
        limitsSummary: '3 profesionales + 8 usuarios internos',
        features: [
            'Hasta 3 profesionales',
            'Hasta 8 usuarios internos',
            'Pacientes ilimitados con uso razonable',
            'Agenda multi-profesional',
            'Expediente clinico',
            'Recetas',
            'Documentos',
            'Consentimientos',
            'Plantillas por profesional o especialidad',
            'Roles/permisos mas completos',
            'Dashboard administrativo',
            'Reportes avanzados basicos',
            'Auditoria administrativa del negocio',
            'Soporte prioritario',
            'Onboarding asistido'
        ]
    }
};

const SAAS_PLAN_CODES = Object.freeze(Object.keys(SAAS_PLANS));

function normalizePlanCode(planCode) {
    return String(planCode || '').trim().toLowerCase();
}

function clonePlan(plan) {
    return plan ? JSON.parse(JSON.stringify(plan)) : null;
}

function getSaasPlan(planCode) {
    const code = normalizePlanCode(planCode);
    return clonePlan(SAAS_PLANS[code] || null);
}

function getSaasPlans() {
    return SAAS_PLAN_CODES.map((code) => getSaasPlan(code));
}

function isValidSaasPlan(planCode) {
    return Boolean(SAAS_PLANS[normalizePlanCode(planCode)]);
}

function getPlanCapabilities(planCode) {
    const plan = getSaasPlan(planCode);

    if (!plan) {
        return null;
    }

    return {
        code: plan.code,
        maxProfessionals: plan.maxProfessionals,
        maxAuxiliaryUsers: plan.maxAuxiliaryUsers,
        maxStaffUsers: plan.maxStaffUsers,
        maxBranches: plan.maxBranches,
        patientsLimit: plan.patientsLimit,
        fairUsePatients: plan.fairUsePatients,
        features: plan.features
    };
}

function getUnknownSaasPlan(planCode) {
    const code = normalizePlanCode(planCode) || 'unknown';
    return {
        code,
        name: 'Plan desconocido',
        description: 'Plan no reconocido por el catalogo SaaS actual.',
        monthlyPriceMxn: null,
        founderMonthlyPriceMxn: null,
        founderPriceMonths: null,
        currency: 'MXN',
        maxProfessionals: null,
        maxAuxiliaryUsers: null,
        maxStaffUsers: null,
        maxBranches: null,
        patientsLimit: null,
        fairUsePatients: true,
        recommended: false,
        publicLabel: 'Sin precio configurado',
        founderLabel: 'Sin precio fundador configurado',
        limitsSummary: 'Limites no configurados',
        features: []
    };
}

function getPlanLabel(planCode) {
    const plan = getSaasPlan(planCode);
    return plan ? plan.name : getUnknownSaasPlan(planCode).name;
}

function getPlanLimitsSummary(planCode) {
    const plan = getSaasPlan(planCode);
    return plan ? plan.limitsSummary : getUnknownSaasPlan(planCode).limitsSummary;
}

module.exports = {
    SAAS_PLAN_CODES,
    getSaasPlan,
    getSaasPlans,
    isValidSaasPlan,
    getPlanCapabilities,
    getPlanLabel,
    getPlanLimitsSummary,
    getUnknownSaasPlan
};
