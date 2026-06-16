const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const ConfigDao = require('../../Dao/mysql/config.dao');
const { applyTenantToBody, DEFAULT_BUSINESS_ID, getBusinessIdFromToken } = require('../../util/tenant');

class ConfigController extends httpResponseHelper{
/**
 * 
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
signatureContentSave = async(req, res, next) =>{
        let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await ConfigDao.signature_content_save(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

/**
 * 
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
signatureContentUpdate = async(req, res, next) =>{
        let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await ConfigDao.signature_content_update(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

/**
 * 
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
signatureContentGet = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
            response = await ConfigDao.signature_content_get(getBusinessIdFromToken(req.tokenDecode));
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

loginImageSave = async(req, res, next) =>{
        let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await ConfigDao.login_image_save(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

loginImageGet = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
            response = await ConfigDao.login_image_get(getBusinessIdFromToken(req.tokenDecode) || DEFAULT_BUSINESS_ID);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

themeList = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await ConfigDao.theme_list();
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

themeGet = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
            response = await ConfigDao.theme_get(getBusinessIdFromToken(req.tokenDecode) || DEFAULT_BUSINESS_ID);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

themeSave = async(req, res, next) =>{
        let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await ConfigDao.theme_save(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

clinicalModuleConfigGet = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
            response = await ConfigDao.clinical_module_config_get(getBusinessIdFromToken(req.tokenDecode) || DEFAULT_BUSINESS_ID);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

clinicalModuleConfigSave = async(req, res, next) =>{
        let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await ConfigDao.clinical_module_config_save(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

}

module.exports = new ConfigController;
