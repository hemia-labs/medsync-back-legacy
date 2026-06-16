'use strict';

const CsrfTokenService = require('../services/security/csrfToken.service');
const SecurityConfig = require('../config/security');
const securityLogger = require('../services/security/securityLogger.service');

function forbidden(reason) {
    return {
        status: 403,
        success: false,
        code: 'CSRF_FORBIDDEN',
        data: null,
        message: 'CSRF validation failed',
        reason
    };
}

function csrfProtection(options = {}) {
    return (req, res, next) => {
        try {
            const result = CsrfTokenService.validateDoubleSubmit(req, options);

            if (result.ok) {
                req.csrf = {
                    checked: !result.skipped,
                    contextType: result.payload ? result.payload.contextType : null,
                    expiresAt: result.payload ? result.payload.expiresAt : null
                };
                next();
                return;
            }

            securityLogger.record('auth.csrf.failed', req, {
                reason: result.reason,
                csrf_enabled: SecurityConfig.isCsrfEnabled(),
                origin_check_enabled: SecurityConfig.isCsrfOriginCheckEnabled()
            });

            const response = forbidden(result.reason);
            res.status(response.status).send(response);
        } catch (error) {
            securityLogger.record('auth.csrf.failed', req, {
                reason: 'exception'
            });
            const response = forbidden('exception');
            res.status(response.status).send(response);
        }
    };
}

module.exports = {
    csrfProtection,
    forbidden
};
