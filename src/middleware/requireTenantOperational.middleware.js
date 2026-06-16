const TenantOperationalDao = require('../Dao/mysql/tenantOperational.dao');
const {
    buildTenantOperationalData,
    buildTenantOperationalResponse,
    isBusinessOperational,
    isSuperAdminRole
} = require('../util/businessOperational');
const securityLogger = require('../services/security/securityLogger.service');

const MINIMAL_READ_ROUTES = [
    { method: 'GET', baseUrl: '/api/business', pattern: /^\/current\/?$/ },
    { method: 'GET', baseUrl: '/api/config', pattern: /^\/clinical-modules\/get\/?$/ },
    { method: 'POST', baseUrl: '/api/px', pattern: /^\/search\/?$/ },
    { method: 'GET', baseUrl: '/api/px', pattern: /^\/get\/[^/]+\/?$/ },
    { method: 'GET', baseUrl: '/api/clinical-history-template', pattern: /^\/current\/?$/ },
    { method: 'GET', baseUrl: '/api/clinical-history', pattern: /^\/patient\/[^/]+\/?$/ },
    { method: 'GET', baseUrl: '/api/clinical-history', pattern: /^\/patient\/[^/]+\/versions\/?$/ },
    { method: 'GET', baseUrl: '/api/clinical-history', pattern: /^\/[^/]+\/?$/ },
    { method: 'GET', baseUrl: '/api/prescription', pattern: /^\/doctors\/?$/ },
    { method: 'GET', baseUrl: '/api/prescription', pattern: /^\/patient\/[^/]+\/?$/ },
    { method: 'GET', baseUrl: '/api/prescription', pattern: /^\/(?!config\/?$|list\/?$)[^/]+\/?$/ },
    { method: 'GET', baseUrl: '/api/document', pattern: /^\/templates\/?$/ },
    { method: 'GET', baseUrl: '/api/document', pattern: /^\/patient\/[^/]+\/?$/ }
];

const normalizePath = (value) => String(value || '').split('?')[0].replace(/\/+$/, '') || '/';

const isMinimalReadAllowed = (req) => {
    const method = String(req.method || '').toUpperCase();
    const baseUrl = normalizePath(req.baseUrl);
    const path = normalizePath(req.path || req.url);

    return MINIMAL_READ_ROUTES.some((route) => (
        route.method === method
        && normalizePath(route.baseUrl) === baseUrl
        && route.pattern.test(path)
    ));
};

const forbidden = (res, result) => {
    const payload = buildTenantOperationalResponse(result);
    return res.status(403).send({
        status: 403,
        code: payload.code,
        reasonCode: payload.reasonCode,
        tenantStatus: payload.tenantStatus,
        data: payload.data,
        message: payload.message
    });
};

const superAdminForbidden = (req, res) => {
    securityLogger.record('authz.super_admin_phi_denied', req, {
        id_login: req && req.tokenDecode ? req.tokenDecode.id_login : null,
        id_business: req && req.tokenDecode ? req.tokenDecode.id_business : null,
        role: req && req.tokenDecode ? req.tokenDecode.rol : null,
        baseUrl: req ? req.baseUrl : null,
        path: req ? req.path || req.url : null
    });

    return res.status(403).send({
        status: 403,
        code: 'SUPER_ADMIN_PHI_FORBIDDEN',
        reasonCode: 'SUPER_ADMIN_PHI_FORBIDDEN',
        data: null,
        message: 'super_admin no puede acceder a datos clinicos o tenant desde esta ruta.'
    });
};

module.exports = async function requireTenantOperational(req, res, next) {
    try {
        const tokenDecode = req.tokenDecode || {};

        if (isSuperAdminRole(tokenDecode.rol)) {
            superAdminForbidden(req, res);
            return;
        }

        if (!tokenDecode.id_business) {
            forbidden(res, {
                code: 'TENANT_REQUIRED',
                message: 'No hay negocio asociado a la sesion.'
            });
            return;
        }

        const business = await TenantOperationalDao.getBusiness(tokenDecode.id_business);
        const result = isBusinessOperational(business);

        if (!result.allowed) {
            req.tenantOperational = buildTenantOperationalData(result);
            req.tenantOperationalMessage = result.message;

            if (isMinimalReadAllowed(req)) {
                next();
                return;
            }

            forbidden(res, result);
            return;
        }

        req.tenantOperational = buildTenantOperationalData(result);
        next();
    } catch (error) {
        next(error);
    }
};

module.exports.isMinimalReadAllowed = isMinimalReadAllowed;
module.exports.MINIMAL_READ_ROUTES = MINIMAL_READ_ROUTES;
