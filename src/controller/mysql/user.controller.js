const privateImages = require('../../services/aws/privateImages');
const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const UserDao = require('../../Dao/mysql/user.dao');
const { applyTenantToBody, getBusinessIdFromToken } = require('../../util/tenant');

class UserController extends httpResponseHelper{
/**
 * Función que permite registrar un nuevo usuario al sistema
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  SaveUser = async(req, res, next) =>{
    let body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await UserDao.saveUser(body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }
  

 /**
 * Función que permite actualizar usuario especifico
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  UpdateUser = async(req, res, next) =>{
    let body = req.body;
    let id_login = req.params.id;
    body.id_business = getBusinessIdFromToken(req.tokenDecode);
    body.id_login = req.tokenDecode ? req.tokenDecode.id_login : body.id_login;
    body.is_super_admin = req.tokenDecode && req.tokenDecode.rol === 'super_admin';
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await UserDao.updateUser(body,id_login);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 

/**
 * Función que permite obtener los usuarios del sistema
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
    getUsers = async(req, res, next) =>{
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await UserDao.list(getBusinessIdFromToken(req.tokenDecode), req.tokenDecode && req.tokenDecode.rol === 'super_admin');
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }
    
    /**
     * Función que permite obtener los usuarios del sistema por id
     * @param {any} req request
     * @param {any} res response
     * @param {any} next next
     * @author Cristian Eduardo Méndez Iglesias
     * @author Marco Antonio Saraos Hernandez
     * @author Humberto Trinidad Domínguez
     */
    getUsersbyId = async(req, res, next) =>{
        let id = req.params.id;
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await UserDao.getbyId(id, getBusinessIdFromToken(req.tokenDecode), req.tokenDecode && req.tokenDecode.rol === 'super_admin');
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    getProfessionalProfile = async(req, res, next) =>{
        let id = req.params.id || (req.tokenDecode ? req.tokenDecode.id_login : null);
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await UserDao.getProfessionalProfile(
                id,
                getBusinessIdFromToken(req.tokenDecode),
                req.tokenDecode ? req.tokenDecode.id_login : null
            );
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        if (response?.status === 200 && response.data) {
            try {
                response.data.signature_url = await privateImages.signedImage(response.data.signature_image, getBusinessIdFromToken(req.tokenDecode));
                response.data.signature_digest = privateImages.digest(response.data.signature_image);
            } catch (_) { response = { status: 500, success: false, message: 'No se pudo consultar la imagen privada.' }; }
        }
        res.set('Cache-Control', 'no-store');
        res.status(response.status).send(response);
    }

    saveProfessionalProfile = async(req, res, next) =>{
        let body = applyTenantToBody(req, req.body);
        body.target_id_login = req.params.id || body.target_id_login || body.id_user;
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await UserDao.saveProfessionalProfile(body);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        if (response?.status === 200 && response.data) {
            try {
                response.data.signature_url = await privateImages.signedImage(response.data.signature_image, getBusinessIdFromToken(req.tokenDecode));
                response.data.signature_digest = privateImages.digest(response.data.signature_image);
            } catch (_) { response = { status: 500, success: false, message: 'No se pudo consultar la imagen privada.' }; }
        }
        res.set('Cache-Control', 'no-store');
        res.status(response.status).send(response);
    }

}

module.exports = new UserController;
