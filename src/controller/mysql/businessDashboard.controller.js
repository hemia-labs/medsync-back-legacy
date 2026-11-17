const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const BusinessDashboardDao = require('../../Dao/mysql/businessDashboard.dao');
const responseData = require('../../util/responsedata');

function hasTenantOverride(req) {
    const sources = [req.query, req.params, req.body];

    return sources.some((source) => source && (
        Object.prototype.hasOwnProperty.call(source, 'businessId') ||
        Object.prototype.hasOwnProperty.call(source, 'id_business')
    ));
}

function hasOnlyAllowedQueryParams(query = {}, allowedParams = []) {
    const allowed = new Set(allowedParams);
    return Object.keys(query || {}).every((key) => allowed.has(key));
}

function buildAuditContext(req) {
    const rawEndpoint = req.originalUrl || req.url || '';

    return {
        actorLoginId: req.tokenDecode && req.tokenDecode.id_login ? req.tokenDecode.id_login : null,
        endpoint: rawEndpoint.split('?')[0],
        method: req.method || 'GET'
    };
}

class BusinessDashboardController extends httpResponseHelper {
    resolveTenantDashboardContext = async(req, res, allowedQueryParams) => {
        if (hasTenantOverride(req)) {
            res.status(HttpStatus.BAD_REQUEST).send({
                status: HttpStatus.BAD_REQUEST,
                data: null,
                message: 'No se permite consultar otro negocio desde este endpoint.'
            });
            return null;
        }

        if (allowedQueryParams && !hasOnlyAllowedQueryParams(req.query || {}, allowedQueryParams)) {
            res.status(HttpStatus.BAD_REQUEST).send({
                status: HttpStatus.BAD_REQUEST,
                data: null,
                message: 'Parametro de consulta no permitido.'
            });
            return null;
        }

        // NC1-AUTH-S1/S2: authentication first (401 AUTH_ACCESS_INVALID); a valid session without business is 403 context.
        if (!req.tokenDecode || !req.tokenDecode.id_login) {
            const response = responseData.unauthorized('Token invalido o no enviado.', { code: 'AUTH_ACCESS_INVALID' });
            res.status(response.status).send(response);
            return null;
        }

        const idBusiness = req.tokenDecode.id_business ? req.tokenDecode.id_business : null;

        if (!idBusiness) {
            const response = responseData.forbidden('No hay negocio asociado a la sesion.', { code: 'BUSINESS_CONTEXT_REQUIRED' });
            res.status(response.status).send(response);
            return null;
        }

        const canAccessDashboard = await BusinessDashboardDao.canAccessTenantDashboard(
            req.tokenDecode && req.tokenDecode.id_login ? req.tokenDecode.id_login : null
        );

        if (!canAccessDashboard) {
            res.status(403).send({
                status: 403,
                data: null,
                message: 'No tienes permiso para consultar el dashboard.'
            });
            return null;
        }

        return {
            idBusiness
        };
    }

    overview = async(req, res) => {
        const context = await this.resolveTenantDashboardContext(req, res, ['from', 'to', 'scope', 'granularity']);
        if (!context) return;
        const response = await BusinessDashboardDao.overview(context.idBusiness, req.query || {}, buildAuditContext(req));
        res.status(response.status).send(response);
    }

    summary = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);

        try {
            const context = await this.resolveTenantDashboardContext(req, res, ['from', 'to', 'scope']);
            if (!context) {
                return;
            }

            response = await BusinessDashboardDao.summary(context.idBusiness, req.query || {}, buildAuditContext(req));
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }

        res.status(response.status).send(response);
    }

    trends = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);

        try {
            const context = await this.resolveTenantDashboardContext(req, res, ['from', 'to', 'granularity', 'scope']);
            if (!context) {
                return;
            }

            response = await BusinessDashboardDao.trends(context.idBusiness, req.query || {}, buildAuditContext(req));
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }

        res.status(response.status).send(response);
    }

    operationalSummary = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);

        try {
            const context = await this.resolveTenantDashboardContext(req, res, ['from', 'to', 'scope']);
            if (!context) {
                return;
            }

            response = await BusinessDashboardDao.operationalSummary(context.idBusiness, req.query || {}, buildAuditContext(req));
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }

        res.status(response.status).send(response);
    }

    professionalBreakdown = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);

        try {
            const context = await this.resolveTenantDashboardContext(req, res, ['from', 'to', 'scope']);
            if (!context) {
                return;
            }

            response = await BusinessDashboardDao.professionalBreakdown(context.idBusiness, req.query || {}, buildAuditContext(req));
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }

        res.status(response.status).send(response);
    }

    teamBreakdown = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);

        try {
            const context = await this.resolveTenantDashboardContext(req, res, ['from', 'to', 'scope']);
            if (!context) {
                return;
            }

            response = await BusinessDashboardDao.teamBreakdown(context.idBusiness, req.query || {}, buildAuditContext(req));
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }

        res.status(response.status).send(response);
    }
}

module.exports = new BusinessDashboardController();
