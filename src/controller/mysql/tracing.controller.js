const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const TracingDao = require('../../Dao/mysql/tracing.Dao');
const { applyTenantToBody, getBusinessIdFromToken } = require('../../util/tenant');

class TracingController extends httpResponseHelper{

/**
 * Función que permite obtener la lista de Seguimiento de un PX
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  getTracing = async(req, res, next) =>{
    let _id_person =  req.params.id_person;
    let _id_business = getBusinessIdFromToken(req.tokenDecode);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TracingDao.GetTracing(_id_person, _id_business);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

/**
 * Función permite obtener las proximas citas
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
nextQuote = async(req, res, next) =>{
    let _date =  req.params.date;
    let _id_business = getBusinessIdFromToken(req.tokenDecode);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TracingDao.nextQuote(_date, _id_business);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

/**
 * Función que registrar la lista de Seguimiento de un PX
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
SaveTracing = async(req, res, next) =>{

    let _body = applyTenantToBody(req, req.body);

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TracingDao.saveTracing(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

/**
 * Función que actualizar la lista de Seguimiento de un PX
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
UpdateTracing = async(req, res, next) =>{

    let _body = applyTenantToBody(req, req.body);

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TracingDao.UpdateTracing(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

/**
 * Función que permite eliminar un registro del Seguimiento de un PX
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
DeleteTracing = async(req, res, next) =>{

    let _body = applyTenantToBody(req, req.body);

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await TracingDao.DeleteTracing(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

}

module.exports = new TracingController;
