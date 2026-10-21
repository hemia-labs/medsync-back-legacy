const MESSAGES = require('../../util/common.messages.util');
const httpResponseHelper = require('../../util/httpResponse');
const HttpStatus = require('../../util/httpStatusCode');
const AppointmentDao = require('../../Dao/mysql/appointment.Dao');
const { applyTenantToBody, getBusinessIdFromToken } = require('../../util/tenant');

class AppointmentController extends httpResponseHelper{

  doctors = async(req, res) => {
    const result = await AppointmentDao.doctors({ id_business: getBusinessIdFromToken(req.tokenDecode) });
    res.status(result.status).send(result);
  }

  getConfig = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await AppointmentDao.getConfig({ id_business: getBusinessIdFromToken(req.tokenDecode), id_login: req.tokenDecode.id_login, doctor_profile_id: req.query.doctor_profile_id });
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  saveConfig = async(req, res, next) =>{
    let body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await AppointmentDao.saveConfig(body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  saveTimezone = async(req, res) => {
    const response = await AppointmentDao.saveTimezone(applyTenantToBody(req, req.body));
    res.status(response.status).send(response);
  }

  list = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await AppointmentDao.list({
            ...(req.query || {}),
            id_business: getBusinessIdFromToken(req.tokenDecode)
        });
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  patientHistory = async(req, res, next) =>{
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await AppointmentDao.patientHistory({
            ...(req.query || {}),
            patient_id: req.params.patientId,
            id_business: getBusinessIdFromToken(req.tokenDecode)
        });
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  save = async(req, res, next) =>{
    let body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await AppointmentDao.save(body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }

  reschedule = async(req, res) => {
    const response = await AppointmentDao.reschedule(applyTenantToBody(req, req.body));
    res.status(response.status).send(response);
  }
  configImpact = async(req, res) => {
    const response = await AppointmentDao.configImpact(applyTenantToBody(req, req.body));
    res.status(response.status).send(response);
  }
  get = async(req, res) => {
    const response = await AppointmentDao.get({ id_business: getBusinessIdFromToken(req.tokenDecode), id_appointment: req.params.appointmentId });
    res.status(response.status).send(response);
  }
  audit = async(req, res) => {
    const response = await AppointmentDao.audit({ id_business: getBusinessIdFromToken(req.tokenDecode), id_appointment: req.params.appointmentId, before: req.query.before });
    res.status(response.status).send(response);
  }

  delete = async(req, res, next) =>{
    let body = applyTenantToBody(req, req.body);
    let response = this.HttpNotSucces(HttpStatus.NOT_CONTENT, MESSAGES.NOT_CONTENT);
    try {
        response = await AppointmentDao.delete(body);
    } catch (error) {
        response = this.HttpError(error.status, error.message);
    }
    res.status(response.status).send(response);
  }
}

module.exports = new AppointmentController;
