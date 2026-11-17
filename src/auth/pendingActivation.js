'use strict';

// Authenticated pending accounts get a narrow allowlist, even on old routes
// which forgot to include requireTenantOperational. Paths are not prefix grants.
const routes = new Set([
    'GET /api/registration/context', 'POST /api/auth/register',
    'GET /api/auth/csrf', 'GET /api/auth/session', 'POST /api/auth/refreshToken', 'PUT /api/auth/close',
    'GET /api/saas-legal', 'GET /api/saas-legal/notice', 'GET /api/saas-legal/history', 'POST /api/saas-legal/accept',
    'GET /api/account/activation', 'GET /api/account/activation/plans',
    'PATCH /api/account/activation/contact', 'POST /api/account/contact-verifications',
    'POST /api/account/contact-verifications/confirm', 'POST /api/account/activation/checkout',
    'GET /api/config/theme/get', 'GET /api/config/login-image/get'
]);

function enforcePendingActivation(req, res) {
    if (!req.tokenDecode || req.tokenDecode.subscription_status !== 'pending_activation') return false;
    const route = String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
    if (routes.has(`${req.method} ${route}`)) return false;
    res.status(403).send({ status: 403, code: 'TENANT_NOT_OPERATIONAL', reasonCode: 'ACCOUNT_PENDING_ACTIVATION',
        tenantStatus: 'pending_activation', data: null,
        message: 'Completa la verificacion y activacion de tu cuenta para comenzar.' });
    return true;
}

module.exports = { enforcePendingActivation, routes };
