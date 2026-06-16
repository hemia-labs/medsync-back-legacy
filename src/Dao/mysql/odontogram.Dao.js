const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException, SQLException } = require('../../util/sequelizeException');


/**
 * Clase principal
 */
class OdontogramDao {

    /**
     * Permite obtener la configuración de un diente
     * @param {String} id_person id del px
     * @param {String} id_tooth id del diente
     * @returns 
     */
    async getbytooth(id_person, id_tooth) {
        let response;
        try {
            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAM_GET, {
                replacements: {
                    _id_person: id_person,
                    _id_tooth: id_tooth
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);

                let newData = result.map((x) => {
                    return {
                        ...x,
                        config: JSON.parse(x.config)
                    }
                });

                response = !SQLValid.hasError ? responseData.success(newData[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Permite guardar la configuración de un diente
     * @param {Object} body Payload
     * @returns 
     */
    async savetooth(body) {
        let response;
        try {


            if (!Array.isArray(body.config)) throw new Error("Parameter config is not a Array!");

            const _json = JSON.stringify(body.config);
            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAM_SAVE, {
                replacements: {
                    _id_person: body.id_person,
                    _id_tooth: body.id_tooth,
                    _symbol: body.symbol,
                    _observation: body.observation,
                    _json: _json,
                    _id_user: body.id_login
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Permite actualizar la configuración de un diente
     * @param {Object} body Payload
     * @returns 
     */
    async updatetooth(body) {
        let response;
        try {

            if (!Array.isArray(body.config)) throw new Error("Parameter config is not a Array!");

            const _json = JSON.stringify(body.config);
            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAM_UPDATE, {
                replacements: {
                    _id_odontogram: body.id_odontogram,
                    _id_person: body.id_person,
                    _id_tooth: body.id_tooth,
                    _symbol: body.symbol,
                    _observation: body.observation,
                    _json: _json,
                    _id_user: body.id_login
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }


    /**
     * Obtiene la configuración de los tipos de odontograma
     * @returns 
     */
    async getCatTypeTooth() {
        let response;
        try {
            let result = await sequelize.query(SequelizeSP.SP_CAT_TYPE_TOOTH_GET, {
                replacements: {},
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Evalua si contiene un odontograma
     * @param { String } id_person id_person
     * @returns 
     */
    async validateOdontogramv1(id_person) {
        let response;
        try {
            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAM_VALIDATE_V1, {
                replacements: {
                    _id_person: id_person
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Realiza el registro de un odontograma
     * @param { Object } body payLoad
     * @returns 
     */
    async saveOdontogramv1(body) {
        let response;
        try {

            body.expand = body.expand || null;

            if(body.expand){
                if(!['INDICARTOR_DISABLED'].includes(body.expand)) {
                    return responseData.notSuccess('Missing key expand')
                }
            } 

            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAM_SAVE_V1, {
                replacements: {
                    _id_person: body.id_person,
                    _type: body.type,
                    _expand : body.expand,
                    _id_login: body.id_login
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Retorna la configuración del odontograma
     * @param { String } id_person id_person
     * @returns 
     */
    async getOdontogramv1(id_person) {
        let response;
        try {
            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAM_GET_V1, {
                replacements: {
                    _id_person: id_person
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Realiza el registro de un odontograma detalle
     * @param { Object } body payLoad
     * @returns 
     */
    async saveOdontogramvDetailv1(body) {
        let response;
        try {
            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAMDETAIL_SAVE_V1, {
                replacements: {
                    _id_odontogram_detailv1: body.id_odontogram_detailv1,
                    _id_person: body.id_person,
                    _id_tooth: body.id_tooth,
                    _treatment: body.treatment,
                    _id_login: body.id_login
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Retorna la el historial de odontogramas del px
     * @param { String } id_person id_person
     * @returns 
     */
    async getHistoryv1(id_person) {
        let response;
        try {
            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAM_HISTORY_V1, {
                replacements: {
                    _id_person: id_person
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Actualiza el status de un odontograma
     * @param { Object } body PayLoad
     * @returns 
     */
    async updateStatusOdontogramV1(body) {
        let response;
        try {
            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAM_CHANGE_STATUS_V1, {
                replacements: {
                    _id_odontogramv1: body.id_odontogramv1,
                    _active: body.active,
                    _id_user: body.id_login
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Elimina de manera logica un odontograma
     * @param { Object } body PayLoad
     * @returns 
     */
    async deleteOdontogramV1(body) {
        let response;
        try {
            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAM_DELETE_V1, {
                replacements: {
                    _id_odontogramv1: body.id_odontogramv1,
                    _id_user: body.id_login
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_UPDATE_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

}

module.exports = new OdontogramDao;
