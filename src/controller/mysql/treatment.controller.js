const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const TreatmentDao = require('../../Dao/mysql/treatment.Dao');
const { applyTenantToBody } = require('../../util/tenant');

class TreatmentController extends httpResponseHelper{

/**
 * Función que permite obtener la lista de Tratamiento de un PX
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
GetTreatment = async(req, res, next) =>{
    let _id_person =  req.params.id_person;
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.getTreatment(_id_person);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }


  /**
 * Función que permite obtener la lista de Tratamiento de un PX
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
CatTreatment = async(req, res, next) =>{
    let _body = applyTenantToBody(req, { id_person: req.params.id_person });
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.catTreatment(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

/**
 * Función que registrar la lista de Tratamiento de un PX
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
SaveTreatment = async(req, res, next) =>{

    let _body = req.body;
    _body.id_login = req.tokenDecode.id_login;

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.saveTreatment(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

/**
 * Función que actualizar la lista de Tratamiento de un PX
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
UpdateTreatment = async(req, res, next) =>{

    let _body = req.body;
    _body.id_login = req.tokenDecode.id_login;

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.UpdateTreatment(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

/**
 * Función que permite eliminar un registro del Tratamiento de un PX
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
DeleteTreatment = async(req, res, next) =>{

    let _body = req.body;

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.DeleteTreatment(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

 /**
 * Función que permite obtener la lista de Tratamiento de un PX
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
 GetDiagnosis = async(req, res, next) =>{
    let _id_person =  req.params.id_person;
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.getDiagnosis(_id_person);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }


 /**
 * Función que permite obtener la lista de Tratamiento de un PX
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
 SaveDiagnosis = async(req, res, next) =>{

    let _body = req.body;
    _body.id_login = req.tokenDecode.id_login;

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.saveDiagnosis(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  GetTreatmentPlan = async(req, res, next) =>{
    let _body = applyTenantToBody(req, { id_person: req.params.id_person });
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.getPlan(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  CreateTreatmentPlan = async(req, res, next) =>{
    let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.createPlan(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  CloseTreatmentPlan = async(req, res, next) =>{
    let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.closePlan(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  SavePlanTreatment = async(req, res, next) =>{
    let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.savePlanTreatment(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  UpdatePlanTreatmentStatus = async(req, res, next) =>{
    let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.updatePlanTreatmentStatus(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  DeletePlanTreatment = async(req, res, next) =>{
    let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.deletePlanTreatment(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  SavePlanConsent = async(req, res, next) =>{
    let _body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TreatmentDao.savePlanConsent(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

}

module.exports = new TreatmentController;
