const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const RolDao = require('../../Dao/mysql/rol.dao');

class RolController extends httpResponseHelper{
/**
 * Función que permite obtener la lista de roles del sistema
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  getRoles = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await RolDao.getRoles(req.tokenDecode && req.tokenDecode.rol === 'super_admin');
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 

  getPermissions = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await RolDao.getPermissions(req.params.id, {
            idBusiness: req.tokenDecode ? req.tokenDecode.id_business : null,
            actorLoginId: req.tokenDecode ? req.tokenDecode.id_login : null,
            actorRole: req.tokenDecode ? req.tokenDecode.rol : null
        });
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  savePermissions = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await RolDao.savePermissions(req.params.id, req.body.permissions, {
            idBusiness: req.tokenDecode ? req.tokenDecode.id_business : null,
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

}

module.exports = new RolController;
