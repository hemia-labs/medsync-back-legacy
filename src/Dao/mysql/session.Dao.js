
const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
// const responseData = require('../../util/responsedata');
// const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');

const getFirstRow = (result) => {
    if (!result) {
        return null;
    }

    if (Array.isArray(result)) {
        if (Array.isArray(result[0])) {
            return result[0][0] || null;
        }

        return result[0] || null;
    }

    return result;
};

const getSessionId = (row) => {
    if (!row || row.Code) {
        return null;
    }

    if (row.id_session !== undefined && row.id_session !== null) {
        return row.id_session;
    }

    return Object.values(row).find((value) => value !== undefined && value !== null) || null;
};


/**
 * Clase principal
 */
class SessionDao{

/**
 * Permite obtener el catalogo de opciones de datos patologicos
 * @returns Lista
 */
async checkToken(id_login) {
    let response = null;        
    try {
        let result = await sequelize.query(SequelizeSP.SP_TOKEN_VALIDATE, {
            replacements: {
                _id_login : id_login
            },
            type: QueryTypes.RAW,
            plain: true
        });

        if(result){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);
            if(!SQLValid.hasError){
                response = getSessionId(getFirstRow(result)); //responseData.success(result, Messages.DATA_GET_SUCCESSFULLY);
            }
        }

    } catch (error) {
            response = null;//SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
    return response;
}

async getActiveSession(id_login) {
    if (!id_login) {
        return null;
    }

    try {
        const result = await sequelize.query(
            `SELECT id_session
               FROM \`session\`
              WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                AND active = 1
                AND last = 1
              ORDER BY created_at DESC
              LIMIT 1`,
            {
                replacements: {
                    _id_login: id_login
                },
                type: QueryTypes.SELECT
            }
        );

        return result && result[0] ? result[0].id_session : null;
    } catch (error) {
        return null;
    }
}

async checkActiveSession(id_login, id_session) {
    if (!id_login || !id_session) {
        return null;
    }

    try {
        const result = await sequelize.query(
            `SELECT id_session
               FROM \`session\`
              WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                AND id_session COLLATE utf8mb4_unicode_ci = :_id_session COLLATE utf8mb4_unicode_ci
                AND active = 1
                AND last = 1
              LIMIT 1`,
            {
                replacements: {
                    _id_login: id_login,
                    _id_session: id_session
                },
                type: QueryTypes.SELECT
            }
        );

        return result && result[0] ? result[0].id_session : null;
    } catch (error) {
        return null;
    }
}

}

module.exports = new SessionDao;
