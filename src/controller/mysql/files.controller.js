const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const FilesDao = require('../../Dao/mysql/file.Dao');
const { getBusinessIdFromToken } = require('../../util/tenant');
const fs = require('fs');

class FilesController extends httpResponseHelper{
/**
 * Función que permite obtener los repositorios del aws
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
listBuckets = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await FilesDao.getBuckets();
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 

 /**
 * Función que permite registrar un archivo
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  uploadFile = async(req, res, next) =>{
    req.body.id_login = req.tokenDecode.id_login;
    req.body.id_business = getBusinessIdFromToken(req.tokenDecode);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await FilesDao.uploadFile(req.body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 


 /**
 * Función que permite registrar un archivo
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  uploaProfilePhoto = async(req, res, next) =>{
    req.body.id_login = req.tokenDecode.id_login;
    req.body.id_business = getBusinessIdFromToken(req.tokenDecode);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await FilesDao.uploaProfilePhoto(req.body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 

 /**
 * Funcion que obtiene los archivos deacuerdo al px enviando
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
 getfilesPhoto = async(req, res, next) =>{
    let id_person = req.params.px;
    let id_business = getBusinessIdFromToken(req.tokenDecode);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await FilesDao.getfiles(id_person, id_business, { codes: req.patientFileCodes });
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  /**
 * Funcion que elimina un archivo de un bucket especifico
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  deletefile = async(req, res, next) =>{
    let _body = req.body;
    _body.id_business = getBusinessIdFromToken(req.tokenDecode);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await FilesDao.deleteFile(_body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }


}

module.exports = new FilesController;
