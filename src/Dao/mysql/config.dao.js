const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');
const hellpersFile = require('../../util/file/file')
const config = require('../../config/config');
const { uploadFile, deleteFile } = require('../../services/aws/s3');
const {v4: uuidv4 } = require('uuid');

/**
 * Clase principal
 */
class ConfigDao{

/**
 * 
 * @returns Lista de paises
 */
 async signature_content_save(body) {
    let response;

    try {

        let resultFile = null;
        if(body.files && body.files.file) {
            let pathfile = hellpersFile.base64Toimg(body.files.file)
            if(!pathfile){
                throw new Error("Excepción al crear el archivo")
            }

            resultFile = await uploadFile(config.BUCKETS.CONFIGFIRMS,pathfile.path,pathfile.id);
            /*Response AWS 
            {
                ETag: '"6885b87f3c730e94424029f6c5485b77"',
                ServerSideEncryption: 'AES256',
                Location: 'https://s3-bucket-files-photos.s3.us-west-1.amazonaws.com/ce531932-3c5b-4b76-8091-d007d580eadd.png',
                key: 'ce531932-3c5b-4b76-8091-d007d580eadd.png',
                Key: 'ce531932-3c5b-4b76-8091-d007d580eadd.png',
                Bucket: 's3-bucket-files-photos'
            }*/

            hellpersFile.deleteFile(pathfile.path);
        }


        let result = await sequelize.query(SequelizeSP.SP_SIGNATURE_CONSENT_SAVE, {
            replacements: {
                _key_signature : resultFile && resultFile.key ? resultFile.key : '',
                _url_signature : resultFile && resultFile.Location ? resultFile.Location : '',
                _consent : body.consent || '',
                _state : body.state || '',
                _name : body.name || '',
                _id_login : body.id_login,
                _id_business : body.id_business
            },
            type: QueryTypes.RAW
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
 * 
 * @param {*} body 
 * @returns 
 */
async signature_content_update(body) {
    let response;

    try {
        let resultFile = null;
        if( !body.url_signature && body.files && body.files.file) {

            await deleteFile(config.BUCKETS.CONFIGFIRMS,body.key_signature);


            let pathfile = hellpersFile.base64Toimg(body.files.file)
            if(!pathfile){
                throw new Error("Excepción al crear el archivo")
            }

            resultFile = await uploadFile(config.BUCKETS.CONFIGFIRMS,pathfile.path,pathfile.id);

            body.key_signature = resultFile && resultFile.key ? resultFile.key : '';
            body.url_signature = resultFile && resultFile.Location ? resultFile.Location : '';
            hellpersFile.deleteFile(pathfile.path);
        }

        let result = await sequelize.query(SequelizeSP.SP_SIGNATURE_CONSENT_UPDATE, {
            replacements: {
                _id_signature_consent : body.id_signature_consent,
                _key_signature : body.key_signature,
                _url_signature : body.url_signature,
                _consent : body.consent || '',
                _state : body.state || '',
                _name : body.name || '',
                _id_login : body.id_login,
                _id_business : body.id_business
            },
            type: QueryTypes.RAW
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
 * 
 * @returns Lista de paises
 */
async signature_content_get(id_business) {
    let response;

    try {

        let result = await sequelize.query(SequelizeSP.SP_SIGNATURE_CONSENT_GET, {
            replacements: { _id_business: id_business },
            type: QueryTypes.RAW
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

async login_image_save(body) {
    let response;

    try {
        const imageData = body.image_data;
        const mimeMatch = imageData.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/);

        let result = await sequelize.query(SequelizeSP.SP_LOGIN_IMAGE_CONFIGURATION_SAVE, {
            replacements: {
                _image_data : imageData,
                _mime_type : mimeMatch ? mimeMatch[1] : null,
                _original_name : body.original_name || null,
                _id_login : body.id_login,
                _id_business : body.id_business
            },
            type: QueryTypes.RAW
        });

        if(result){
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{
            response = responseData.notSuccess(Messages.DATA_GET_ERROR)
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
    }
    return response;
}

async login_image_get(id_business) {
    let response;

    try {
        let result = await sequelize.query(SequelizeSP.SP_LOGIN_IMAGE_CONFIGURATION_GET, {
            replacements: { _id_business: id_business },
            type: QueryTypes.RAW
        });

        if(result){
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{
            response = responseData.notSuccess(Messages.DATA_GET_ERROR)
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
    }
    return response;
}

async theme_list() {
    let response;

    try {
        let result = await sequelize.query(SequelizeSP.SP_UI_THEME_LIST, {
            replacements: {},
            type: QueryTypes.RAW
        });

        if(result){
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{
            response = responseData.notSuccess(Messages.DATA_GET_ERROR)
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
    }
    return response;
}

async theme_get(id_business) {
    let response;

    try {
        let result = await sequelize.query(SequelizeSP.SP_UI_THEME_GET, {
            replacements: { _id_business: id_business },
            type: QueryTypes.RAW
        });

        if (!result || result.length === 0) {
            result = await sequelize.query(
                `SELECT id_cat_ui_theme, code, name, description,
                        primary_100, primary_200, primary_300, primary_500,
                        primary_700, primary_900, primary_1000,
                        secondary_500, secondary_700, terciary_500,
                        forty_500, grey, gray98, red
                   FROM cat_ui_theme
                  WHERE code = 'medical-blue' AND active = 1
                  LIMIT 1`,
                { type: QueryTypes.SELECT }
            );
        }

        if(result){
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{
            response = responseData.notSuccess(Messages.DATA_GET_ERROR)
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
    }
    return response;
}

async theme_save(body) {
    let response;

    try {
        const idLogin = body.id_login || null;
        const themes = await sequelize.query(
            'SELECT id_cat_ui_theme FROM cat_ui_theme WHERE code = :_code AND active = 1 LIMIT 1',
            {
                replacements: { _code: body.code },
                type: QueryTypes.SELECT
            }
        );

        if (!themes || themes.length === 0) {
            return responseData.bad_request('El tema seleccionado no existe');
        }

        const activeConfig = await sequelize.query(
            'SELECT id_ui_theme_configuration FROM ui_theme_configuration WHERE active = 1 AND id_business = :_id_business LIMIT 1',
            {
                replacements: { _id_business: body.id_business },
                type: QueryTypes.SELECT
            }
        );

        if (activeConfig && activeConfig.length > 0) {
            await sequelize.query(
                'UPDATE ui_theme_configuration SET id_cat_ui_theme = :_id_cat_ui_theme, updated_by = :_id_login, updated_at = NOW() WHERE id_ui_theme_configuration = :_id_ui_theme_configuration AND id_business = :_id_business',
                {
                    replacements: {
                        _id_cat_ui_theme: themes[0].id_cat_ui_theme,
                        _id_login: idLogin,
                        _id_ui_theme_configuration: activeConfig[0].id_ui_theme_configuration,
                        _id_business: body.id_business
                    },
                    type: QueryTypes.UPDATE
                }
            );
        }
        else {
            await sequelize.query(
                'INSERT INTO ui_theme_configuration (id_ui_theme_configuration, id_business, id_cat_ui_theme, active, created_by, created_at) VALUES (:_id_ui_theme_configuration, :_id_business, :_id_cat_ui_theme, 1, :_id_login, NOW())',
                {
                    replacements: {
                        _id_ui_theme_configuration: uuidv4(),
                        _id_business: body.id_business,
                        _id_cat_ui_theme: themes[0].id_cat_ui_theme,
                        _id_login: idLogin
                    },
                    type: QueryTypes.INSERT
                }
            );
        }

        let result = await sequelize.query(SequelizeSP.SP_UI_THEME_GET, {
            replacements: {
                _id_business: body.id_business
            },
            type: QueryTypes.RAW
        });

        if(result){
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{
            response = responseData.notSuccess(Messages.DATA_GET_ERROR)
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
    }
    return response;
}

async clinical_module_config_get(id_business) {
    let response;

    try {
        let result = await sequelize.query(SequelizeSP.SP_CLINICAL_MODULE_CONFIG_GET, {
            replacements: { _id_business: id_business },
            type: QueryTypes.RAW
        });

        if(result){
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result[0] || { odontogramEnabled: false }, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{
            response = responseData.notSuccess(Messages.DATA_GET_ERROR)
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
    }
    return response;
}

async clinical_module_config_save(body) {
    let response;

    try {
        let result = await sequelize.query(SequelizeSP.SP_CLINICAL_MODULE_CONFIG_SAVE, {
            replacements: {
                _config : JSON.stringify(body.config || body || {}),
                _id_login : body.id_login,
                _id_business : body.id_business
            },
            type: QueryTypes.RAW
        });

        if(result){
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result[0] || { odontogramEnabled: false }, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{
            response = responseData.notSuccess(Messages.DATA_GET_ERROR)
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
    }
    return response;
}

}

module.exports = new ConfigDao;
