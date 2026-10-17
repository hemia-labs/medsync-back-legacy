const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');
const {dateYMD} = require('../../util/date')
const TreatmentPlanDao = require('./treatmentPlan.dao');
const effectivePermissions = require('../../util/effectivePermissions');
const collateEq = (left, right) => `${left} COLLATE utf8mb4_unicode_ci = ${right} COLLATE utf8mb4_unicode_ci`;

/**
 * Clase principal
 */
class TreatmentDao extends TreatmentPlanDao {
    /**
     * Permite Registrar un nuevo seguimiento
     * @param {any} body PayLoad 
     * @returns
     */
    async saveTreatment(body) {
        let response;        
        try {

            let _treatment =  body.treatment ? JSON.stringify((body.treatment)) : null;

            let result = await sequelize.query(SequelizeSP.SP_TREATMENT_SAVE, {
                replacements: {
                    _treatment : _treatment,
                    _id_person : body.id_person,
                    _id_login : body.id_login
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
    async UpdateTreatment(body) {
        let response;        
        try {

            let _treatment =  body.treatment ? JSON.stringify((body.treatment)) : null;

            let result = await sequelize.query(SequelizeSP.SP_TREATMENT_UPDATE, {
                replacements: {
                    _treatment : _treatment,
                    _id_person : body.id_person,
                    _id_login : body.id_login
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
    async DeleteTreatment(body) {
        let response;        
        try {

            let result = await sequelize.query(SequelizeSP.SP_TREATMENT_DELETE, {
                replacements: {
                    _id_treatment : body.id_treatment,
                    _id_person : body.id_person
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
     * Permite listar el seguimiento de un paciente
     * @param {String} id_person id del PX 
     * @returns
     */
    async getTreatment(id_person) {
        let response;        
        try {

            let result = await sequelize.query(SequelizeSP.SP_TREATMENT_GET, {
                replacements: {
                    _id_person : id_person
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
    async catTreatment(body) {
        let response;        
        try {
            if (!body || !body.id_business || !body.id_login || !body.id_person) return responseData.forbidden('No hay contexto autorizado de paciente.');
            const codes = new Set((await effectivePermissions.rows(body.id_login, { enabledCatalog: true })).map(row => row.code));
            if (!codes.has('treatments.view') && !codes.has('px.tab.monitoring')) return responseData.forbidden('No tienes permiso para consultar tratamientos.');
            const owned = await sequelize.query(`SELECT p.id_person FROM person p
                INNER JOIN login l ON ${collateEq('l.id_business', 'p.id_business')} AND ${collateEq('l.id_login', ':actor')} AND l.active=1
                WHERE ${collateEq('p.id_person', ':patient')} AND ${collateEq('p.id_business', ':business')} AND p.active=1 LIMIT 1`,
                { replacements: { actor: body.id_login, patient: body.id_person, business: body.id_business }, type: QueryTypes.SELECT });
            if (!owned[0]) return responseData.forbidden('El paciente no pertenece al consultorio activo.');
            if (body && body.id_business) {
                const result = await sequelize.query(
                    `SELECT pt.id_patient_treatment AS id,
                            pt.name,
                            pt.status,
                            pt.id_treatment_plan,
                            GROUP_CONCAT(ptt.tooth_number ORDER BY CAST(ptt.tooth_number AS UNSIGNED) SEPARATOR ',') AS teeth
                       FROM patient_treatment pt
                      INNER JOIN treatment_plan tp
                         ON tp.id_treatment_plan = pt.id_treatment_plan
                        AND tp.id_business = pt.id_business
                        AND tp.id_person = pt.id_person
                        AND tp.status = 'active'
                        AND tp.active = 1
                       LEFT JOIN patient_treatment_tooth ptt
                         ON ptt.id_patient_treatment = pt.id_patient_treatment
                        AND ptt.id_business = pt.id_business
                      WHERE ${collateEq('pt.id_business', ':_id_business')}
                        AND ${collateEq('pt.id_person', ':_id_person')}
                        AND pt.active = 1
                      GROUP BY pt.id_patient_treatment, pt.name, pt.status, pt.id_treatment_plan
                      ORDER BY pt.name ASC`,
                    {
                        replacements: {
                            _id_business: body.id_business,
                            _id_person: body.id_person
                        },
                        type: QueryTypes.SELECT
                    }
                );

                return responseData.success(result.map((item) => ({
                    ...item,
                    teeth: item.teeth ? item.teeth.split(',') : []
                })), Messages.DATA_GET_SUCCESSFULLY);
            }

            let result = await sequelize.query(SequelizeSP.SP_CAT_TREATMENT_GET, {
                replacements: {
                    _id_person : body
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
    async getDiagnosis(id_person) {
        let response;        
        try {

            let result = await sequelize.query(SequelizeSP.SP_DIAGNOSIS_GET, {
                replacements: {
                    _id_person : id_person
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);

                if( !SQLValid.hasError ){

                    let newresult = result.map((p)=>{
                        return{
                            sec : p.sec,
                            id_diagnosis : p.id_diagnosis,
                            id_odontogram : p.id_odontogram,
                            id_person : p.id_person,
                            symbol : p.symbol,
                            observation : p.observation,
                            json : JSON.parse(p.json.toString()),
                            treatment : p.treatment,
                            amount: Number(p.amount)
                        }
                    });

                    response = responseData.success(newresult, Messages.DATA_GET_SUCCESSFULLY);
                }
                else{
                    response =  responseData.notSuccess(Messages.DATA_GET_ERROR);
                }
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
        async saveDiagnosis(body) {
            let response;        
            try {
    
                let result = await sequelize.query(SequelizeSP.SP_DIAGNOSIS_UPDATE, {
                    replacements: {
                        _id_diagnosis : body.id_diagnosis,
                        _id_odontogram : body.id_odontogram,
                        _id_person : body.id_person,
                        _treatment : body.treatment,
                        _amount : body.amount,
                        _id_login : body.id_login
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

}

module.exports = new TreatmentDao;
