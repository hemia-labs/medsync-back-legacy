const { compensateUpload, queueUploadCleanup } = require('../../services/aws/compensateUpload');

const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');
const { getBuckets, uploadImage, getBucketbyCode, deleteFile } = require('../../services/aws/s3');

const config = require('../../config/config');

const getS3KeyFromUrl = (value) => {
    if (!value || typeof value !== 'string') {
        return value;
    }

    try {
        const parsedUrl = new URL(value);
        return decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
    } catch (error) {
        return value;
    }
};

const FILE_COLLATION = 'utf8mb4_unicode_ci';

/**
 * Clase principal
 */
class FilesDao{

async recoverUploaded(body, bucket, object, profile = false) {
    let rows;
    try {
        const table = profile ? 'profile_px' : 'files';
        rows = await sequelize.query(`SELECT f.* FROM ${table} f
            INNER JOIN person p ON p.id_person = f.id_person
            WHERE f.id_person = :patient AND p.id_business = :business AND f.url = :url`, {
            replacements: { patient: body.id_person, business: body.id_business, url: object.Location }, type: QueryTypes.SELECT
        });
    } catch (_) {
        // The procedure may have committed before the connection failed.
        // Never delete an object while its persistence outcome is unknown.
        await queueUploadCleanup(bucket, object, 'persistence_unknown_verify_before_delete');
        return null;
    }
    if (rows.length) return responseData.success(rows, Messages.DATA_SAVE_SUCCESSFULLY);
    await compensateUpload(bucket, object);
    return null;
}

async ownsPatient(body) {
    if (!body.id_person || !body.id_business) return false;
    const rows = await sequelize.query('SELECT id_person FROM person WHERE id_person = :patient AND id_business = :business AND active = 1 LIMIT 1', {
        replacements: { patient: body.id_person, business: body.id_business }, type: QueryTypes.SELECT
    });
    return rows.length > 0;
}

/**
 * Permite obtener el catalogo de los buckets actuales
 * @returns Lista
 */
async getBuckets() {
    let response;        
    try {
        let buckets = await getBuckets();
        response = response = responseData.success(buckets, Messages.DATA_GET_SUCCESSFULLY);
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
    return response;
}

/**
 * Carga los archivos del px, RadioGrafias
 * @param {any} body PayLoad
 * @returns 
 */
async uploadFile(body) {
    let uploaded = null, uploadBucket = null;
    let response;    
    try {

        if (!await this.ownsPatient(body)) return responseData.notSuccess('Paciente no disponible para este consultorio.');

        let bucket = getBucketbyCode(body.code_cat_files)
        if(!bucket) throw new Error("No se indico un repositorio valido para la imagen")

        uploadBucket = bucket;
        const resultFile = uploaded = await uploadImage(bucket, body.file);

        let result = await sequelize.query(SequelizeSP.SP_FILE_SAVE, {
            replacements: {
                _code_cat_files : body.code_cat_files,
                _id_person : body.id_person,
                _url : resultFile.Location,
                _id_user : body.id_login
            },
            type: QueryTypes.RAW,
            plain: true 
        });

        if(result && (!Array.isArray(result) || result.length)){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{/* regresamos una excepción controlada al no obtener una respuesta */
            response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
    if (uploaded && response.status !== 200) {
        try { response = await this.recoverUploaded(body, uploadBucket, uploaded) || response; }
        catch (_) { console.error('[STORAGE_CLEANUP_JOURNAL_FAILED]'); }
    }
    return response;
}

/**
 * Carga la foto del perfil del px
 * @param {any} body PayLoad
 * @returns 
 */
async uploaProfilePhoto(body) {
    let uploaded = null, uploadBucket = null;
    let response;    
    try {

        if (!await this.ownsPatient(body)) return responseData.notSuccess('Paciente no disponible para este consultorio.');


        uploadBucket = config.BUCKETS.PROFILE;
        const resultFile = uploaded = await uploadImage(uploadBucket, body.file);

        let result = await sequelize.query(SequelizeSP.SP_PROFILE_PX, {
            replacements: {
                _id_profile_px : null,
                _id_person : body.id_person,
                _url : resultFile.Location,
                _key_img : resultFile.Key,
                _id_login : body.id_login
            },
            type: QueryTypes.RAW,
            plain: true 
        });

        if(result && (!Array.isArray(result) || result.length)){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{/* regresamos una excepción controlada al no obtener una respuesta */
            response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
        }

    } catch (error) {
            response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
    if (uploaded && response.status !== 200) {
        try { response = await this.recoverUploaded(body, uploadBucket, uploaded, true) || response; }
        catch (_) { console.error('[STORAGE_CLEANUP_JOURNAL_FAILED]'); }
    }
    return response;
}


/**
 * Obtiene los archivos deacuerdo al px enviando
 * @param {String} id_person id del px
 * @returns 
 */
async getfiles(id_person, id_business, options = {}) {
    let response;
    try {
        if (!Array.isArray(options.codes) || !options.codes.length) return responseData.forbidden('No tienes permiso para estos archivos del paciente.');
        if (!id_person || !id_business) {
            return responseData.notSuccess('Paciente no encontrado para este negocio.');
        }

        const patientRows = await sequelize.query(
            `SELECT id_person
               FROM person
              WHERE id_person COLLATE ${FILE_COLLATION} = :_id_person COLLATE ${FILE_COLLATION}
                AND id_business COLLATE ${FILE_COLLATION} = :_id_business COLLATE ${FILE_COLLATION}
                AND active = 1
              LIMIT 1`,
            {
                replacements: {
                    _id_person: id_person,
                    _id_business: id_business
                },
                type: QueryTypes.SELECT
            }
        );

        if (!patientRows || patientRows.length === 0) {
            return responseData.notSuccess('Paciente no encontrado para este negocio.');
        }

        let result = await sequelize.query(
            `SELECT
                cf.id_cat_files,
                cf.code,
                cf.description,
                COALESCE(
                    JSON_ARRAYAGG(
                        CASE
                            WHEN f.id_files IS NULL THEN NULL
                            ELSE JSON_OBJECT(
                                'id_files', f.id_files,
                                'url', f.url,
                                'sec', f.sec,
                                'last', f.last
                            )
                        END
                    ),
                    JSON_ARRAY()
                ) AS child
               FROM cat_files cf
               LEFT JOIN files f
                 ON f.id_cat_files COLLATE ${FILE_COLLATION} = cf.id_cat_files COLLATE ${FILE_COLLATION}
                AND f.id_person COLLATE ${FILE_COLLATION} = :_id_person COLLATE ${FILE_COLLATION}
                AND f.id_business COLLATE ${FILE_COLLATION} = :_id_business COLLATE ${FILE_COLLATION}
                AND f.active = 1
              WHERE cf.active = 1 AND cf.code IN (:_codes)
              GROUP BY cf.id_cat_files, cf.code, cf.description
              ORDER BY cf.description ASC`,
            {
            replacements: {
                _id_person : id_person,
                _id_business : id_business,
                _codes: options.codes
            },
            type: QueryTypes.SELECT
        });

        if(result){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);

            let newData = result.map((x)=>{ 
                    const children = typeof x.child === 'string' ? JSON.parse(x.child) : x.child;
                    return {
                        ...x,
                        child : (Array.isArray(children) ? children : []).filter(Boolean)
                    }
                });
            
            response =  !SQLValid.hasError ? responseData.success(newData, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        else{/* regresamos una excepción controlada al no obtener una respuesta */
            response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
    return response;
}


/**
 * Elimina un archivo especifico
 * @param {any} body payload
 * @returns 
 */
async deleteFile(body) {
    let response;
    try {
        if (!body.id_person || !body.id_business) {
            return responseData.notSuccess('Paciente no encontrado para este negocio.');
        }

        const patientRows = await sequelize.query(
            `SELECT id_person
               FROM person
              WHERE id_person COLLATE ${FILE_COLLATION} = :_id_person COLLATE ${FILE_COLLATION}
                AND id_business COLLATE ${FILE_COLLATION} = :_id_business COLLATE ${FILE_COLLATION}
                AND active = 1
              LIMIT 1`,
            {
                replacements: {
                    _id_person: body.id_person,
                    _id_business: body.id_business
                },
                type: QueryTypes.SELECT
            }
        );

        if (!patientRows || patientRows.length === 0) {
            return responseData.notSuccess('Paciente no encontrado para este negocio.');
        }


        const fileRows = await sequelize.query(`SELECT f.id_files FROM files f INNER JOIN cat_files c ON c.id_cat_files = f.id_cat_files
            WHERE f.id_person = :patient AND f.id_business = :business AND f.url = :url AND c.code = :code AND f.active = 1 LIMIT 1`, {
            replacements: { patient: body.id_person, business: body.id_business, url: body.key, code: body.code_cat_files }, type: QueryTypes.SELECT
        });
        if (!fileRows.length) return responseData.notSuccess('Archivo no encontrado para este paciente.');
        let bucket = getBucketbyCode(body.code_cat_files)
        if(!bucket) throw new Error("No se indico un repositorio valido para la imagen")

        let result = await sequelize.query(SequelizeSP.SP_FILE_DELETE, {
            replacements: {
                _id_person : body.id_person,
                _url : body.key,
                _code : body.code_cat_files
            },
            type: QueryTypes.RAW,
            plain: true 
        });

        if(result){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);

            if(!SQLValid.hasError){

                let key = getS3KeyFromUrl(body.key);
                let resultFile = await deleteFile(bucket,key);
                if(!resultFile) throw new Error("Excepción al eliminar la imagen");

                response =  responseData.success(resultFile, Messages.DATA_GET_SUCCESSFULLY);
            }
            else{

                response = responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
        }
        else{/* regresamos una excepción controlada al no obtener una respuesta */
            response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
        }
    } catch (error) {
            response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
    return response;
}


}

module.exports = new FilesDao;
