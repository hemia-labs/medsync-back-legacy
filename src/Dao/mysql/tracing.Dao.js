const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');
const {dateYMD} = require('../../util/date')


/**
 * Clase principal
 */
class TracingDao{

    /**
     * Permite Registrar un nuevo seguimiento
     * @param {any} body PayLoad 
     * @returns
     */
    async saveTracing(body) {
        let response;        
        try {

            let _tracing =  body.tracing ? JSON.stringify((body.tracing)) : null;

            let result = await sequelize.query(SequelizeSP.SP_TRACING_SAVE, {
                replacements: {
                    _tracing : _tracing,
                    _id_person : body.id_person,
                    _id_login : body.id_login,
                    _id_business : body.id_business
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Permite actualizar un nuevo seguimiento
     * @param {any} body PayLoad 
     * @returns
     */
    async UpdateTracing(body) {
        let response;        
        try {

            let _tracing =  body.tracing ? JSON.stringify((body.tracing)) : null;

            let result = await sequelize.query(SequelizeSP.SP_TRACING_UPDATE, {
                replacements: {
                    _tracing : _tracing,
                    _id_person : body.id_person,
                    _id_login : body.id_login,
                    _id_business : body.id_business
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.error(Messages.DATA_SAVE_ERROR);
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Permite eliminar un registro seguimiento
     * @param {any} body PayLoad 
     * @returns
     */
    async DeleteTracing(body) {
        let response;        
        try {

            let result = await sequelize.query(SequelizeSP.SP_TRACING_DELETE, {
                replacements: {
                    _id_tracing : body.id_tracing,
                    _id_person : body.id_person,
                    _id_business : body.id_business
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response =  !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Permite obtener las proximas citas de los paciente
     * @param {Date} date fecha de inicio
     * @returns 
     */
    async nextQuote(date = null, id_business = null) {
        let response;        
        try {

            let _date = date ? date : dateYMD();


            let result = await sequelize.query(SequelizeSP.SP_TRACING_NEXTQOUE, {
                replacements: {
                    _date : _date,
                    _id_business : id_business
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Permite listar el seguimiento de un paciente
     * @param {String} id_person id del PX 
     * @returns
     */
    async GetTracing(id_person, id_business) {
        let response;        
        try {

            let result = await sequelize.query(SequelizeSP.SP_TRACING_GET, {
                replacements: {
                    _id_person : id_person,
                    _id_business : id_business
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

}

module.exports = new TracingDao;
