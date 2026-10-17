const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const BusinessDashboardDao = require('../../Dao/mysql/businessDashboard.dao');

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

        const idBusiness = req.tokenDecode && req.tokenDecode.id_business ? req.tokenDecode.id_business : null;

        if (!idBusiness) {
            res.status(HttpStatus.UNAUTHORIZED).send({
                status: HttpStatus.UNAUTHORIZED,
                data: null,
                message: 'No hay negocio asociado a la sesion.'
            });
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
