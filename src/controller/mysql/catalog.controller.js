const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const CatalogDao = require('../../Dao/mysql/catalog.dao');

class CatalogController extends httpResponseHelper{
/**
 * Función que permite obtener la lista de roles del sistema
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
getCatalogPathological = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await CatalogDao.getCatalogPathological();
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 

  /**
 * Permite obtener el catalogo de secciones de datos patologicos
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
  getCatalogSectionsPathological = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await CatalogDao.getCatalogSectionsPathological();
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  } 


/**
 * Permite obtener el catalogo de tipos de archivos
 * @param {any} req request
 * @param {any} res response
 * @param {any} next next
 * @author Cristian Eduardo Méndez Iglesias
 * @author Marco Antonio Saraos Hernandez
 * @author Humberto Trinidad Domínguez
 */
    getCatalogFiles = async(req, res, next) =>{
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await CatalogDao.getCatalogFiles();
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
      } 

/**
     * Permite obtener el catalogo de tipos de tratamientos
     * @param {any} req request
     * @param {any} res response
     * @param {any} next next
     * @author Cristian Eduardo Méndez Iglesias
     * @author Marco Antonio Saraos Hernandez
     * @author Humberto Trinidad Domínguez
     */
    getTreatment = async(req, res, next) =>{
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await CatalogDao.getTreatment();
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    /**
         * Permite obtener el catalogo de tipos de afecciones
         * @param {any} req request
         * @param {any} res response
         * @param {any} next next
         * @author Cristian Eduardo Méndez Iglesias
         * @author Marco Antonio Saraos Hernandez
         * @author Humberto Trinidad Domínguez
         */
    getConditions = async(req, res, next) =>{
        let id_person = req.params.person
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await CatalogDao.getConditions(id_person);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

    /**
         * Permite obtener el catalogo de tipos de unidades
         * @param {any} req request
         * @param {any} res response
         * @param {any} next next
         * @author Cristian Eduardo Méndez Iglesias
         * @author Marco Antonio Saraos Hernandez
         * @author Humberto Trinidad Domínguez
         */
    getCatUnit = async(req, res, next) =>{
        let id_person = req.params.person
        let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
        try {
            response = await CatalogDao.getCatUnit(id_person);
        } catch (error) {
            response = this.HttpError(error.status, error.message);
        }
        res.status(response.status).send(response);
    }

}

module.exports = new CatalogController;
