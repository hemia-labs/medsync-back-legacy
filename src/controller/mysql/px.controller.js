const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const PxDao = require('../../Dao/mysql/px.dao');
const { applyTenantToBody, getBusinessIdFromToken } = require('../../util/tenant');

class PxController extends httpResponseHelper{

/**
 * Permite registrar un px
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
PxSave = async(req, res, next) =>{

    let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await PxDao.pxSave(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

PxCreateMinimal = async(req, res, next) =>{

    let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await PxDao.pxCreateMinimal(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

/**
 * Permite actualizar un px
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
PxUpdate = async(req, res, next) =>{

    let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await PxDao.pxUpdate(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 


  /**
 * Permite eliminar de manera fisica un px
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  pxForceDelete = async(req, res, next) =>{

    let id = req.body.id_person;
    let id_business = getBusinessIdFromToken(req.tokenDecode);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await PxDao.pxForceDelete(id, id_business);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 

 /**
 * Permite eliminar de logica un px
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
 pxDelete = async(req, res, next) =>{

    let id = req.body.id_person;
    let id_login = req.tokenDecode.id_login;
    let id_business = getBusinessIdFromToken(req.tokenDecode);

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await PxDao.pxDelete(id, id_login, id_business);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 

/**
 * Permite obtener un listado de los px
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
getPxSearch = async(req, res, next) =>{

    let _param = req.body.param;
    let id_business = getBusinessIdFromToken(req.tokenDecode);

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await PxDao.getPxSearch(_param, id_business);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 

/**
 * Permite obtener un listado de los px que cumplean años en eñ mes actual
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
getPxFastSearch = async(req, res, next) =>{

    let _query = req.body.query || req.body.param || '';
    let _limit = req.body.limit;
    let id_business = getBusinessIdFromToken(req.tokenDecode);

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await PxDao.getPxFastSearch(_query, id_business, { limit: _limit });
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

getPxBithDay = async(req, res, next) =>{

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await PxDao.getPxBirtDay(getBusinessIdFromToken(req.tokenDecode));
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 



/**
 * Permite obtener un listado los tipos de parentesco del paciente
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
getFamilyPath = async(req, res, next) =>{

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await PxDao.getFamilyPath();
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 


  /**
 * Permite obtener un listado los tipos de parentesco del paciente
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  getPxById = async(req, res, next) =>{
    let id = req.params.id;
    let id_business = getBusinessIdFromToken(req.tokenDecode);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await PxDao.getPxById(id, id_business);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 

}


module.exports = new PxController;
