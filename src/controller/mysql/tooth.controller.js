const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const ToothDao = require('../../Dao/mysql/tooth.Dao');

class ToothController extends httpResponseHelper{
/**
 * Función que permite obtener la lista de dientes
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
getTeeth = async(req, res, next) =>{
    let id_person = req.params.person;
    let code = req.params.code ? req.params.code : null;
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await ToothDao.getTeeth(id_person, code);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 

}

module.exports = new ToothController;
