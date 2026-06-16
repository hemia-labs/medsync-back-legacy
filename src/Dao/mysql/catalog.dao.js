
const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');

const safeJsonParse = (value, fallback = []) => {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value.toString());
    } catch (error) {
        return fallback;
    }
};

/**
 * Clase principal
 */
class CatalogDao{

    /**
     * Permite obtener el catalogo de opciones de datos patologicos
     * @returns Lista
     */
    async getCatalogPathological() {
        let response;        
        try {
            let result = await sequelize.query(SequelizeSP.SP_CAT_PATHOLOGICAL_PERSONAL, {
                replacements: {},
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                if(!SQLValid.hasError){

                    let newresult = result.map((p)=>{
                        return{
                            id_type_pathological_personal : p.id_type_pathological_personal,
                            id_cat_pathological_personal : p.id_cat_pathological_personal,
                            type_code : p.code,
                            description : p.description,
                            active : p.active,
                            orden: p.orden,
                            child : safeJsonParse(p.child, [])
                        }
                    });

                    response = responseData.success(newresult, Messages.DATA_GET_SUCCESSFULLY);
                }
                else{
                    response =  responseData.notSuccess(Messages.DATA_GET_ERROR);    
                }
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_SAVE_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
        return response;
    }



    /**
     * Permite obtener el catalogo de secciones de datos patologicos
     * @returns Lista
     */
    async getCatalogSectionsPathological() {
        let response;        
        try {
            let result = await sequelize.query(SequelizeSP.SP_CAT_SECTIONS_PATHOLOGICAL_PERSONAL, {
                replacements: {},
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                if(!SQLValid.hasError){
                    response = responseData.success(result, Messages.DATA_GET_SUCCESSFULLY);
                }
                else{
                    response =  responseData.notSuccess(Messages.DATA_GET_ERROR);    
                }
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_SAVE_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
        return response;
    }

    /**
     * Permite obtener el catalogo de tipos de archivos
     * @returns Lista
     */
    async getCatalogFiles() {
        let response;        
        try {
            let result = await sequelize.query(SequelizeSP.SP_CAT_GET_FILES, {
                replacements: {},
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                if(!SQLValid.hasError){
                    response = responseData.success(result, Messages.DATA_GET_SUCCESSFULLY);
                }
                else{
                    response =  responseData.notSuccess(Messages.DATA_GET_ERROR);    
                }
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_SAVE_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
        return response;
    }

    /**
     * Permite obtener el catalogo de tipos de tratamientos
     * @returns Lista
     */
    async getTreatment() {
        let response;        
        try {
            let result = await sequelize.query(SequelizeSP.SP_TREATMENT_GET, {
                replacements: {},
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                if(!SQLValid.hasError){
                    response = responseData.success(result, Messages.DATA_GET_SUCCESSFULLY);
                }
                else{
                    response =  responseData.notSuccess(Messages.DATA_GET_ERROR);    
                }
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_SAVE_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
        return response;
    }

    /**
     * Permite obtener el catalogo de tipos de afecciones
     * @returns 
     */
    async getConditions() {
        let response;        
        try {
            let result = await sequelize.query(SequelizeSP.SP_CAT_CONDITION, {
                replacements: {},
                type: QueryTypes.RAW,
                plain: true
            });

            response = responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) 

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                if(!SQLValid.hasError){
                    response = responseData.success(result, Messages.DATA_GET_SUCCESSFULLY);
                }
                else{
                    response =  responseData.notSuccess(Messages.DATA_GET_ERROR);    
                }
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_SAVE_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
        return response;
    }

    /**
     * Permite obtener el catalogo de tipos de unidades
     * @returns Lista
     */
    async getCatUnit() {
        let response;        
        try {
            let result = await sequelize.query(SequelizeSP.SP_CAT_UNIT_GET, {
                replacements: {},
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                if(!SQLValid.hasError){
                    response = responseData.success(result, Messages.DATA_GET_SUCCESSFULLY);
                }
                else{
                    response =  responseData.notSuccess(Messages.DATA_GET_ERROR);    
                }
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_SAVE_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
        return response;
    }

}

module.exports = new CatalogDao;
