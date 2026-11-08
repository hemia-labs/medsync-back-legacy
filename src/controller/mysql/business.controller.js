const privateImages = require('../../services/aws/privateImages');
const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const BusinessDao = require('../../Dao/mysql/business.dao');
const PreparationDao = require('../../Dao/mysql/preparation.dao');
const { getBusinessIdFromToken } = require('../../util/tenant');
const { isTenantAdministrator } = require('../../util/effectivePermissions');
const { getBusinessEffectiveLicense } = require('../../util/licenseLimits');
const responseData = require('../../util/responsedata');
const { isValidSaasPlan } = require('../../config/saasPlans');

async function presentLogo(response, business) {
    if (response?.status === 200 && response.data) {
        response.data.logoKey = privateImages.isPrivateKey(response.data.logoUrl) ? response.data.logoUrl : null;
        response.data.logoUrl = await privateImages.signedImage(response.data.logoUrl, business);
    }
    return response;
}
class BusinessController extends httpResponseHelper {
    updateLogo = async(req, res) => {
        const business = getBusinessIdFromToken(req.tokenDecode);
        let response;
        try {
            if (!await isTenantAdministrator(req.tokenDecode.id_login, business, 'admin.config')) response = responseData.forbidden('No tienes permiso para modificar el logo.');
            else response = await presentLogo(await BusinessDao.updateLogo(business, { image: req.body?.image, id_login: req.tokenDecode.id_login }, req.method === 'DELETE'), business);
        } catch (_) { response = responseData.error('No se pudo confirmar el logo. Vuelve a consultar antes de reintentar.'); }
        res.set('Cache-Control', 'no-store');
        res.status(response.status).send(response);
    }

    licenseUsage = async(req, res) => {
        let response;
        try {
            const license = await getBusinessEffectiveLicense(getBusinessIdFromToken(req.tokenDecode));
            response = license && !isValidSaasPlan(license.business.plan) ? responseData.error('El plan del consultorio necesita revisión. Solicita ayuda al administrador.') : license ? responseData.success({business:{planName:license.plan.name},license:{professionals:license.limits.professionals,staffUsers:license.limits.staffUsers}}, 'Uso de licencia consultado.')
                : responseData.notSuccess('No se encontró la licencia del consultorio.');
        } catch (_) { response = responseData.error('No se pudo consultar el uso de licencia. Intenta de nuevo.'); }
        res.set('Cache-Control','no-store');
        res.status(response.status).send(response);
    }

    preparation = async(req, res) => {
        const query = req.query || {};
        const response = await PreparationDao.current(getBusinessIdFromToken(req.tokenDecode), req.tokenDecode && req.tokenDecode.id_login, {
            agenda:query.agenda === '1', clinicalHistory:query.clinical_history === '1', doctorProfileId:query.doctor_profile_id
        });
        res.set('Cache-Control', 'no-store');
        res.status(response.status).send(response);
    }

    current = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await presentLogo(await BusinessDao.get(getBusinessIdFromToken(req.tokenDecode)), getBusinessIdFromToken(req.tokenDecode));
            res.set('Cache-Control', 'no-store');
            if (response && response.data && req.tenantOperational) {
                response.data.tenantOperational = req.tenantOperational;
                response.data.tenantOperationalMessage = req.tenantOperationalMessage || null;
            }
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    updateCurrent = async(req, res) => {
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            const canConfig = await isTenantAdministrator(req.tokenDecode ? req.tokenDecode.id_login : null, getBusinessIdFromToken(req.tokenDecode), 'admin.config');
            if (!canConfig) {
                response = this.HttpError(HttpStatus.UNAUTHORIZED, 'No tienes permiso para modificar informacion del consultorio.');
                res.status(response.status).send(response);
                return;
            }

            const body = req.body || {};
            body.id_login = req.tokenDecode ? req.tokenDecode.id_login : null;
            response = await presentLogo(await BusinessDao.update(getBusinessIdFromToken(req.tokenDecode), body), getBusinessIdFromToken(req.tokenDecode));
            res.set('Cache-Control', 'no-store');
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }
}

module.exports = new BusinessController();
