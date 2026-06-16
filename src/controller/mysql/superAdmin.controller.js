const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const SuperAdminDao = require('../../Dao/mysql/superAdmin.dao');
const securityLogger = require('../../services/security/securityLogger.service');

function isSuccess(response) {
    return response && Number(response.status) >= 200 && Number(response.status) < 300;
}

class SuperAdminController extends httpResponseHelper {
    audit = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.audit(req.query || {});
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    createBusiness = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.createBusiness(req.body || {}, {
                actorLoginId: req.tokenDecode ? req.tokenDecode.id_login : null,
                actorRole: req.tokenDecode ? req.tokenDecode.rol : null,
                ip: req.ip,
                userAgent: req.get ? req.get('user-agent') : null
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    dashboardSummary = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.dashboardSummary(req.query || {});
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    saasJobsStatus = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.saasJobsStatus();
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    plans = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.plans();
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    businessLicenseSummary = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.businessLicenseSummary(req.params.id);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    businessLicenseOverrides = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.businessLicenseOverrides(req.params.id);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    updateBusinessLicenseOverrides = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.updateBusinessLicenseOverrides(req.params.id, req.body || {}, {
                actorLoginId: req.tokenDecode ? req.tokenDecode.id_login : null,
                actorRole: req.tokenDecode ? req.tokenDecode.rol : null,
                ip: req.ip,
                userAgent: req.get ? req.get('user-agent') : null
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    runSaasTrialLifecycleJob = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.runSaasTrialLifecycleJob(req.body || {});
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    businesses = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.businesses(req.query || {});
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    updateBusiness = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.updateBusiness(req.params.id, req.body || {}, {
                actorLoginId: req.tokenDecode ? req.tokenDecode.id_login : null,
                actorRole: req.tokenDecode ? req.tokenDecode.rol : null,
                ip: req.ip,
                userAgent: req.get ? req.get('user-agent') : null
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    updateBusinessSubscriptionStatus = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.updateBusinessSubscriptionStatus(req.params.id, req.body || {}, {
                actorLoginId: req.tokenDecode ? req.tokenDecode.id_login : null,
                actorRole: req.tokenDecode ? req.tokenDecode.rol : null,
                ip: req.ip,
                userAgent: req.get ? req.get('user-agent') : null
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    extendBusinessTrial = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.extendBusinessTrial(req.params.id, req.body || {}, {
                actorLoginId: req.tokenDecode ? req.tokenDecode.id_login : null,
                actorRole: req.tokenDecode ? req.tokenDecode.rol : null,
                ip: req.ip,
                userAgent: req.get ? req.get('user-agent') : null
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    updateBusinessPlan = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.updateBusinessPlan(req.params.id, req.body || {}, {
                actorLoginId: req.tokenDecode ? req.tokenDecode.id_login : null,
                actorRole: req.tokenDecode ? req.tokenDecode.rol : null,
                ip: req.ip,
                userAgent: req.get ? req.get('user-agent') : null
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    users = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.users(req.query || {});
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    sessions = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await SuperAdminDao.sessions(req.query || {});
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    closeSession = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        const actor = {
            actorLoginId: req.tokenDecode ? req.tokenDecode.id_login : null,
            actorRole: req.tokenDecode ? req.tokenDecode.rol : null,
            actorSessionId: req.tokenDecode ? req.tokenDecode.id_session : null,
            ip: req.ip,
            userAgent: req.get ? req.get('user-agent') : null
        };
        try {
            response = await SuperAdminDao.closeSession(req.params.id, actor, req.body || {});
            securityLogger.record(isSuccess(response) ? 'auth.session.closed' : 'auth.session.close_failed', req, {
                actor_login_id: actor.actorLoginId,
                target_session_id: req.params.id,
                status: response.status,
                reason_present: Boolean(req.body && req.body.reason),
                confirmation_present: Boolean(req.body && req.body.confirmation)
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
            securityLogger.record('auth.session.close_failed', req, {
                actor_login_id: actor.actorLoginId,
                target_session_id: req.params.id,
                reason: 'exception'
            });
        }
        res.status(response.status).send(response);
    }

    closeUserSessions = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        const actor = {
            actorLoginId: req.tokenDecode ? req.tokenDecode.id_login : null,
            actorRole: req.tokenDecode ? req.tokenDecode.rol : null,
            ip: req.ip,
            userAgent: req.get ? req.get('user-agent') : null
        };
        try {
            response = await SuperAdminDao.closeUserSessions(req.params.id, actor, req.body || {});
            securityLogger.record(isSuccess(response) ? 'auth.sessions.user_closed' : 'auth.sessions.user_close_failed', req, {
                actor_login_id: actor.actorLoginId,
                target_login_id: req.params.id,
                status: response.status,
                reason_present: Boolean(req.body && req.body.reason),
                confirmation_present: Boolean(req.body && req.body.confirmation)
            });
        } catch (error) {
            response = this.HttpError(error.status, error.message);
            securityLogger.record('auth.sessions.user_close_failed', req, {
                actor_login_id: actor.actorLoginId,
                target_login_id: req.params.id,
                reason: 'exception'
            });
        }
        res.status(response.status).send(response);
    }
}

module.exports = new SuperAdminController();
