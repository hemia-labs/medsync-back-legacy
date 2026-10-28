const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const PxDao = require('../../Dao/mysql/px.dao');
const PatientAllergyDao = require('../../Dao/mysql/patientAllergy.dao');
const { hasPermission } = require('../../util/effectivePermissions');
const { canReadClinicalHistory } = require('../../domain/clinicalHistory/access');
const { applyTenantToBody, getBusinessIdFromToken } = require('../../util/tenant');

class PxController extends httpResponseHelper{
minimalResult = async(req, res) => {
    res.set('Cache-Control', 'no-store');
    const response = await require('../../domain/appointments/minimalPatientRequest').result(applyTenantToBody(req, { request_id: req.params.requestId }));
    res.status(response.status).send(response);
}

updateAdministrative = async(req, res) => {
    const response = await PxDao.updateAdministrative(applyTenantToBody(req, { ...req.body }));
    res.status(response.status).send(response);
}

pxRestore = async(req, res) => {
    const response = await PxDao.setArchived(req.body.id_person, req.tokenDecode.id_login, getBusinessIdFromToken(req.tokenDecode), false);
    res.status(response.status).send(response);
}

updateAllergies = async(req, res) => {
    const response = await PatientAllergyDao.update(applyTenantToBody(req, { ...req.body }));
    res.status(response.status).send(response);
}

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
getPxSearchPage = async(req, res) => {
    const includeArchived = req.body.include_archived === true && await hasPermission(req.tokenDecode.id_login, 'px.new');
    const response = await PxDao.getPxSearchPage(req.body.param, getBusinessIdFromToken(req.tokenDecode), {
        includeArchived, page: req.body.page, pageSize: req.body.page_size
    });
    res.status(response.status).send(response);
}

getPxSearch = async(req, res, next) =>{

    let _param = req.body.param;
    let id_business = getBusinessIdFromToken(req.tokenDecode);

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        const includeArchived = req.body.include_archived === true && await hasPermission(req.tokenDecode.id_login, 'px.new');
        response = await PxDao.getPxSearch(_param, id_business, { includeArchived });
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
        const clinical = await canReadClinicalHistory(permission =>
            hasPermission(req.tokenDecode.id_login, permission, { enabledCatalog: true }));
        response = await PxDao.getPxById(id, id_business, { clinical });
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 

}


module.exports = new PxController;
