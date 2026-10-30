const responseData = require('../util/responsedata');
const UserDao = require('../Dao/mysql/user.dao');
const securityLogger = require('../services/security/securityLogger.service');

const DEFAULT_MESSAGE = 'No tienes permiso para acceder a este recurso.';

function normalizePermissions(permissions) {
    return (Array.isArray(permissions) ? permissions : [permissions])
        .map((permission) => String(permission || '').trim())
        .filter(Boolean);
}

function denied(res, req, permissions, options, reason) {
    const response = responseData.forbidden(options.message || DEFAULT_MESSAGE, {
        code: options.code || 'AUTHZ_FORBIDDEN',
        reason
    });

    securityLogger.record('authz.access_denied', req, {
        reason,
        required_permissions: permissions,
        resource: options.resource || null,
        id_login: req && req.tokenDecode ? req.tokenDecode.id_login : null,
        id_business: req && req.tokenDecode ? req.tokenDecode.id_business : null,
        role: req && req.tokenDecode ? req.tokenDecode.rol : null
    });

    res.status(response.status).send(response);
}

function isSelfRequest(req, options) {
    if (!options.allowSelf || !req || !req.tokenDecode || !req.tokenDecode.id_login) {
        return false;
    }

    const fieldNames = options.selfFields || ['id', 'id_login', 'target_id_login', 'id_user'];
    const candidates = [];

    fieldNames.forEach((field) => {
        if (req.params && req.params[field]) {
            candidates.push(req.params[field]);
        }
        if (req.body && req.body[field]) {
            candidates.push(req.body[field]);
        }
        if (req.query && req.query[field]) {
            candidates.push(req.query[field]);
        }
    });

    return candidates.some((candidate) => String(candidate) === String(req.tokenDecode.id_login));
}

function requireAnyPermission(permissions, options = {}) {
    const required = normalizePermissions(permissions);

    return async function requirePermissionMiddleware(req, res, next) {
        try {
            if (!req.tokenDecode || !req.tokenDecode.id_login) {
                const response = responseData.unauthorized('Token invalido o no enviado.');
                res.status(response.status).send(response);
                return;
            }

            if (isSelfRequest(req, options)) {
                next();
                return;
            }

            for (const permission of required) {
                const allowed = options.enabledCatalog
                    ? await require('../util/effectivePermissions').hasPermission(req.tokenDecode.id_login, permission, { enabledCatalog: true })
                    : await UserDao.hasPermission(req.tokenDecode.id_login, permission);
                if (allowed) {
                    next();
                    return;
                }
            }

            denied(res, req, required, options, 'missing_permission');
        } catch (error) {
            next(error);
        }
    };
}

function requirePermission(permission, options = {}) {
    return requireAnyPermission(permission, options);
}

function requireSelfOrPermission(permission, options = {}) {
    return requireAnyPermission(permission, {
        ...options,
        allowSelf: true
    });
}

module.exports = {
    requireAnyPermission,
    requirePermission,
    requireSelfOrPermission
};
