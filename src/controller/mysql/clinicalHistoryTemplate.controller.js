const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const ClinicalHistoryTemplateDao = require('../../Dao/mysql/clinicalHistoryTemplate.dao');
const { applyTenantToBody } = require('../../util/tenant');
const { assertPlanFeature } = require('../../util/planFeatures');

const CUSTOM_TEMPLATES_FEATURE = 'custom_templates';

class ClinicalHistoryTemplateController extends httpResponseHelper {
    current = async (req, res, next) => {
        const body = applyTenantToBody(req, {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await ClinicalHistoryTemplateDao.current(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    createBusinessTemplate = async (req, res, next) => {
        const body = applyTenantToBody(req, req.body || {});
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            const featureValidation = await assertPlanFeature(body.id_business, CUSTOM_TEMPLATES_FEATURE, {
                actorLoginId: body.id_login,
                endpoint: '/api/clinical-history-template/business',
                method: 'POST',
                action: 'create_business_clinical_template'
            });

            if (featureValidation.error) {
                response = featureValidation.error;
            } else {
                response = await ClinicalHistoryTemplateDao.createBusinessTemplate(body);
            }
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    createVersion = async (req, res, next) => {
        const body = applyTenantToBody(req, {
            ...(req.body || {}),
            template_id: req.params.templateId
        });
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            const featureValidation = await assertPlanFeature(body.id_business, CUSTOM_TEMPLATES_FEATURE, {
                actorLoginId: body.id_login,
                endpoint: '/api/clinical-history-template/:templateId/version',
                method: 'POST',
                action: 'create_business_clinical_template_version',
                templateId: req.params.templateId
            });

            if (featureValidation.error) {
                response = featureValidation.error;
            } else {
                response = await ClinicalHistoryTemplateDao.createVersion(body);
            }
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }
}

module.exports = new ClinicalHistoryTemplateController();
