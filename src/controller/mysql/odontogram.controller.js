const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const OdontogramDao = require('../../Dao/mysql/odontogram.Dao');

class OdontogramController extends httpResponseHelper {

  /**
   * Función que permite obtener la lista de roles del sistema
   * @param {any} req request
   * @param {any} res response
   * @param {any} next next
   * @author Cristian Eduardo Méndez Iglesias
   * @author Marco Antonio Saraos Hernandez
   * @author Humberto Trinidad Domínguez
   */
  getByidTooht = async (req, res, next) => {

    let id_person = req.params.id_person;
    let id_tooth = req.params.id_tooth;

    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
      response = await OdontogramDao.getbytooth(id_person, id_tooth);
    } catch (error) {
      response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  /**
   * Función que permite obtener la lista de roles del sistema
   * @param {any} req request
   * @param {any} res response
   * @param {any} next next
   * @author Cristian Eduardo Méndez Iglesias
   * @author Marco Antonio Saraos Hernandez
   * @author Humberto Trinidad Domínguez
   */
  SaveTooth = async (req, res, next) => {
    let _body = req.body;
    _body.id_login = req.tokenDecode.id_login;
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
      response = await OdontogramDao.savetooth(_body);
    } catch (error) {
      response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  /**
   * Función que permite obtener la lista de roles del sistema
   * @param {any} req request
   * @param {any} res response
   * @param {any} next next
   * @author Cristian Eduardo Méndez Iglesias
   * @author Marco Antonio Saraos Hernandez
   * @author Humberto Trinidad Domínguez
   */
  UpdateTooth = async (req, res, next) => {
    let _body = req.body;
    _body.id_login = req.tokenDecode.id_login;
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
      response = await OdontogramDao.updatetooth(_body);
    } catch (error) {
      response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }


  /**
   * Función que permite obtener la configuración de los tipos de odontograma
   * @param {any} req request
   * @param {any} res response
   * @param {any} next next
   * @author Cristian Eduardo Méndez Iglesias
   * @author Marco Antonio Saraos Hernandez
   * @author Humberto Trinidad Domínguez
   */
  GetCatTypeTooth = async (req, res, next) => {
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
      response = await OdontogramDao.getCatTypeTooth();
    } catch (error) {
      response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }





  /**
  * Función que permite validar si cuenta con un odontograma
  * @param {any} req request
  * @param {any} res response
  * @param {any} next next
  * @author Cristian Eduardo Méndez Iglesias
  * @author Marco Antonio Saraos Hernandez
  * @author Humberto Trinidad Domínguez
  */
  getValidator = async (req, res, next) => {
    let id_person = req.params.id_person;
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
      response = await OdontogramDao.validateOdontogramv1(id_person);
    } catch (error) {
      response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  /**
  * Función que permite realizar el registro de un odontograma
  * @param {any} req request
  * @param {any} res response
  * @param {any} next next
  * @author Cristian Eduardo Méndez Iglesias
  * @author Marco Antonio Saraos Hernandez
  * @author Humberto Trinidad Domínguez
  */
  saveOdontogramv1 = async (req, res, next) => {
    let _body = req.body;
    _body.id_login = req.tokenDecode.id_login;
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
      response = await OdontogramDao.saveOdontogramv1(_body);
    } catch (error) {
      response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  /**
  * Función que permite retornar la configuración del odontograma
  * @param {any} req request
  * @param {any} res response
  * @param {any} next next
  * @author Cristian Eduardo Méndez Iglesias
  * @author Marco Antonio Saraos Hernandez
  * @author Humberto Trinidad Domínguez
  */
  getOdontogram = async (req, res, next) => {
    let id_person = req.params.id_person;
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
      response = await OdontogramDao.getOdontogramv1(id_person);
    } catch (error) {
      response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  /**
  * Función que permite realizar el registro de un odontograma
  * @param {any} req request
  * @param {any} res response
  * @param {any} next next
  * @author Cristian Eduardo Méndez Iglesias
  * @author Marco Antonio Saraos Hernandez
  * @author Humberto Trinidad Domínguez
  */
  saveOdontogramvDetailV1 = async (req, res, next) => {
    let _body = req.body;
    _body.id_login = req.tokenDecode.id_login;
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
      response = await OdontogramDao.saveOdontogramvDetailv1(_body);
    } catch (error) {
      response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }


  /**
  * Función que permite retornar el historial de los odontogramas
  * @param {any} req request
  * @param {any} res response
  * @param {any} next next
  * @author Cristian Eduardo Méndez Iglesias
  * @author Marco Antonio Saraos Hernandez
  * @author Humberto Trinidad Domínguez
  */
    getHistoryv1 = async (req, res, next) => {
      let id_person = req.params.id_person;
      let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
      try {
        response = await OdontogramDao.getHistoryv1(id_person);
      } catch (error) {
        response = this.HttpError(error.status, error.message);
      }
      res.status(response.status).send(response);
    }
  
    /**
    * Función que permite actualizar el status de un odontograma
    * @param {any} req request
    * @param {any} res response
    * @param {any} next next
    * @author Cristian Eduardo Méndez Iglesias
    * @author Marco Antonio Saraos Hernandez
    * @author Humberto Trinidad Domínguez
    */
    updateStatusOdontogramV1 = async (req, res, next) => {
      let _body = req.body;
      _body.id_login = req.tokenDecode.id_login;
      let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
      try {
        response = await OdontogramDao.updateStatusOdontogramV1(_body);
      } catch (error) {
        response = this.HttpError(error.status, error.message);
      }
      res.status(response.status).send(response);
    }

    /**
    * Función que permite eliminar de manera logica un odontograma
    * @param {any} req request
    * @param {any} res response
    * @param {any} next next
    * @author Cristian Eduardo Méndez Iglesias
    * @author Marco Antonio Saraos Hernandez
    * @author Humberto Trinidad Domínguez
    */
    deleteOdontogramV1 = async (req, res, next) => {
      let _body = req.body;
      _body.id_login = req.tokenDecode.id_login;
      let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
      try {
        response = await OdontogramDao.deleteOdontogramV1(_body);
      } catch (error) {
        response = this.HttpError(error.status, error.message);
      }
      res.status(response.status).send(response);
    }

}

module.exports = new OdontogramController;
