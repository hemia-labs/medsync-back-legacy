
const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');


/**
 * Clase principal
 */
class ToothDao{

/**
 * Permite obtener la lista de dientes
 * @param {String} id_person id de la persona
 * @param {String} code codigo del tipo de odontograma
 * @returns 
 */
 async getTeeth(id_person, code) {
    let response;        
    try {
        let result = await sequelize.query(SequelizeSP.SP_GET_TEETH, {
            replacements: {
                _id_person : id_person,
                _code : code ? code : null
            },
            type: QueryTypes.RAW,
            // plain: true,
            // mapToModel: true,
            // model: Rol
        });

        //var result = { "tooths" : require('../../jsonFiles/Dientes.json') };

        //response = responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) 

        if(result){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);

            let dataResult = JSON.parse(result.map((e) => {return e.info}).toString());

            let code = result[0].code_cat_type_tooth;

            for (let x = 0; x < dataResult.length; x++) {
                const elementx = dataResult[x];
               
                for (let y = 0; y < elementx.length; y++) {
                    dataResult[x][y].parts = JSON.parse(dataResult[x][y].parts.toString());
                }
            }

            let newObject = {
                code_cat_type_tooth : code,
                teeth : dataResult
            };

            response =  !SQLValid.hasError ? responseData.success(newObject, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
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

module.exports = new ToothDao;
