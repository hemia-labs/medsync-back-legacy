const response = require('../util/responsedata');
const { isTenantAdministrator } = require('../util/effectivePermissions');
const securityLogger = require('../services/security/securityLogger.service');

module.exports = (permission) => async (req, res, next) => {
    try {
        const actor=req.tokenDecode || {};
        if (await isTenantAdministrator(actor.id_login, actor.id_business, permission)) return next();
        securityLogger.record('authz.access_denied',req,{reason:'tenant_administrator_required',required_permissions:[permission],resource:'tenant.administration'});
        const denied=response.forbidden('Solo el administrador autorizado del consultorio puede realizar esta accion.',{code:'AUTHZ_FORBIDDEN'});
        res.status(denied.status).send(denied);
    } catch(error) { next(error); }
};
