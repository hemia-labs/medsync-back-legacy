// const Rol = require('../../models/mysql/rol.model');
const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');

const config = require('../../config/config');
const { uploadImage } = require('../../services/aws/s3');
const { nextPatientCode } = require('../../util/patientCode');
const minimalRequest = require('../../domain/appointments/minimalPatientRequest');
const Identity = require('./identity.dao');
const { normalizePatient } = require('../../domain/identity/legacyDate');
const identityError = e => e.status ? {status:e.status,message:e.message,data:{code:e.code,field:e.field}} : SequelizeException(e, Messages.DATA_SAVE_ERROR);
const PatientAllergyDao = require('./patientAllergy.dao');
const { hydrateAllergy, validateReview } = require('../../domain/clinicalHistory/allergyStatus');

const PATIENT_COLLATION = 'utf8mb4_unicode_ci';
const PATIENT_FAST_SEARCH_MIN_LENGTH = 2;
const PATIENT_FAST_SEARCH_DEFAULT_LIMIT = 12;
const PATIENT_FAST_SEARCH_MAX_LIMIT = 20;
const cleanPhone = (value) => value ? String(value).replace(/[()\-\s]/g, '') : value;
const nullableValue = (value) => (value === undefined || value === '' ? null : value);
const normalizeSearchTerm = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const escapeLikeValue = (value) => normalizeSearchTerm(value).replace(/[\\%_]/g, (match) => `\\${match}`);
const normalizeSearchLimit = (value) => {
    const parsed = Number(value);
    if(!Number.isInteger(parsed) || parsed <= 0) {
        return PATIENT_FAST_SEARCH_DEFAULT_LIMIT;
    }

    return Math.min(parsed, PATIENT_FAST_SEARCH_MAX_LIMIT);
};
const parseJsonField = (value, fallback = {}) => {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (typeof value === 'object') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
};

/**
 * Clase principal
 */
class PXDao{

// Administrative editing deliberately never calls the legacy clinical procedure.
// Child identifiers and extra clinical fields from the browser are not trusted.
async updateAdministrative(body) {
    const transaction = await sequelize.transaction();
    try {
        body = normalizePatient(body);
        const person = body.person;
        const address = body.address;
        const replacements = { patient: person.id_person, business: body.id_business, user: body.id_login };
        const rows = await sequelize.query(`SELECT id_person FROM person WHERE id_person = :patient AND id_business = :business FOR UPDATE`, { replacements, type: QueryTypes.SELECT, transaction });
        if (!rows.length) { await transaction.rollback(); return responseData.notSuccess('Paciente no encontrado.'); }
        await Identity.patientWrite(body, person.id_person, transaction);
        await sequelize.query(`UPDATE person SET name = :name, surname = :surname, birthday = :birthday, age = :age,
            ocupation = :occupation, rfc = :rfc, telephone = :phone, local_telephone = :localPhone,
            updated_at = NOW(), updated_by = :user WHERE id_person = :patient AND id_business = :business`, {
            replacements: { ...replacements, name: person.name, surname: person.surname, birthday: person.birthday,
                age: person.age, occupation: nullableValue(person.ocupation), rfc: nullableValue(person.rfc),
                phone: cleanPhone(person.telephone), localPhone: nullableValue(cleanPhone(person.local_telephone)) }, transaction
        });
        const addresses = await sequelize.query(`SELECT id_address FROM address WHERE id_person = :patient AND id_business = :business AND last = 1 LIMIT 1`, { replacements, type: QueryTypes.SELECT, transaction });
        const values = { ...replacements, address: addresses[0] ? addresses[0].id_address : uuidv4(),
            birthplace: nullableValue(address.place_birth), residence: nullableValue(address.residence), direction: nullableValue(address.direction), cp: nullableValue(address.cp) };
        if (addresses.length) {
            await sequelize.query(`UPDATE address SET place_birth = :birthplace, residence = :residence, direction = :direction, cp = :cp,
                updated_at = NOW(), updated_by = :user WHERE id_address = :address AND id_person = :patient AND id_business = :business`, { replacements: values, transaction });
        } else {
            await sequelize.query(`INSERT INTO address (id_address, id_person, id_business, place_birth, residence, direction, cp, last, created_at, created_by)
                VALUES (:address, :patient, :business, :birthplace, :residence, :direction, :cp, 1, NOW(), :user)`, { replacements: values, transaction });
        }
        await transaction.commit();
        return responseData.success({ id_person: person.id_person }, 'Datos administrativos actualizados.');
    } catch (error) { await transaction.rollback(); return identityError(error); }
}

async setArchived(id_person, id_login, id_business, archived) {
    const transaction = await sequelize.transaction();
    try {
        const replacements = { patient: id_person, business: id_business, user: id_login, active: archived ? 0 : 1 };
        const rows = await sequelize.query(`SELECT id_person FROM person WHERE id_person = :patient AND id_business = :business FOR UPDATE`, { replacements, type: QueryTypes.SELECT, transaction });
        if (!rows.length) { await transaction.rollback(); return responseData.notSuccess('Paciente no encontrado.'); }
        await sequelize.query(`UPDATE person SET active = :active, updated_by = :user, updated_at = NOW() WHERE id_person = :patient AND id_business = :business`, { replacements, transaction });
        await transaction.commit();
        return responseData.success({ id_person, active: replacements.active }, archived ? 'Paciente archivado. Su expediente se conserva.' : 'Paciente restaurado.');
    } catch (error) { await transaction.rollback(); return identityError(error); }
}

async pxCreateMinimal(body) {
    if (body.request_id != null && !minimalRequest.validKey(body.request_id)) return responseData.bad_request('Clave de alta invalida.');
    const transaction = await sequelize.transaction();
    try {
        body = normalizePatient(body);
        const person = body.person || {};
        const address = body.address || {};
        const idPerson = body.request_id ? minimalRequest.patientIdFor(body) : uuidv4();
        await sequelize.query('SELECT id_business FROM business WHERE id_business=:business FOR UPDATE', { replacements: { business: body.id_business }, type: QueryTypes.SELECT, transaction });
        if (body.request_id) {
            const rows = await sequelize.query('SELECT id_person FROM person WHERE id_person=:id AND id_business=:business FOR UPDATE', { replacements: { id: idPerson, business: body.id_business }, type: QueryTypes.SELECT, transaction });
            if (rows.length) {
                const [stored]=await sequelize.query('SELECT request_hash FROM patient_identity WHERE id_person=:id AND id_business=:business',{replacements:{id:idPerson,business:body.id_business},type:QueryTypes.SELECT,transaction});
                const mismatch=stored && stored.request_hash && stored.request_hash!==require('../../domain/identity/service').hash(body);
                await transaction.rollback(); return {status:409,data:{code:mismatch?'PATIENT_CREATE_PAYLOAD_CONFLICT':'PATIENT_CREATE_ALREADY_RECORDED'},message:mismatch?'La clave de alta ya tiene otra captura. Consulta el resultado.':'Esta operacion ya creo un paciente. Consulta su resultado; no se creo otro.'};
            }
        }
        const idAddress = uuidv4();
        const idQuery = uuidv4();
        const idAllergy = uuidv4();

        const duplicate = await sequelize.query(
            `SELECT p.id_person
               FROM person p
              WHERE p.active = 1
                AND p.id_business COLLATE ${PATIENT_COLLATION} = :_id_business COLLATE ${PATIENT_COLLATION}
                AND p.name COLLATE ${PATIENT_COLLATION} = :_name COLLATE ${PATIENT_COLLATION}
                AND p.surname COLLATE ${PATIENT_COLLATION} = :_surname COLLATE ${PATIENT_COLLATION}
                AND p.birthday = :_birthday
              LIMIT 1`,
            {
                replacements: {
                    _id_business: body.id_business,
                    _name: person.name,
                    _surname: person.surname,
                    _birthday: person.birthday
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        if (duplicate && duplicate.length > 0) {
            await transaction.rollback();
            return responseData.notSuccess('Ya se encuentra un paciente con los datos proporcionados.');
        }

        const code = await nextPatientCode(sequelize, transaction);

        await sequelize.query(
            `INSERT INTO person (
                id_person, id_business, code, name, surname, birthday, age, ocupation, rfc, active,
                local_telephone, telephone, name_signature, social_media, id_signature,
                created_at, created_by, updated_at, updated_by
             ) VALUES (
                :_id_person, :_id_business, :_code, :_name, :_surname, :_birthday, :_age, :_ocupation, :_rfc, 1,
                :_local_telephone, :_telephone, NULL, NULL, '',
                NOW(), :_id_login, NULL, NULL
             )`,
            {
                replacements: {
                    _id_person: idPerson,
                    _id_business: body.id_business,
                    _code: code,
                    _name: person.name,
                    _surname: person.surname,
                    _birthday: person.birthday,
                    _age: person.age,
                    _ocupation: nullableValue(person.ocupation),
                    _rfc: nullableValue(person.rfc),
                    _local_telephone: nullableValue(cleanPhone(person.local_telephone)),
                    _telephone: cleanPhone(person.telephone),
                    _id_login: body.id_login
                },
                type: QueryTypes.INSERT,
                transaction
            }
        );

        await sequelize.query(
            `INSERT INTO address (
                id_address, id_business, id_person, place_birth, residence, direction, cp,
                last, created_at, created_by, updated_at, updated_by
             ) VALUES (
                :_id_address, :_id_business, :_id_person, :_place_birth, :_residence, :_direction, :_cp,
                1, NOW(), :_id_login, NULL, NULL
             )`,
            {
                replacements: {
                    _id_address: idAddress,
                    _id_business: body.id_business,
                    _id_person: idPerson,
                    _place_birth: nullableValue(address.place_birth),
                    _residence: nullableValue(address.residence),
                    _direction: nullableValue(address.direction),
                    _cp: nullableValue(address.cp),
                    _id_login: body.id_login
                },
                type: QueryTypes.INSERT,
                transaction
            }
        );

        await sequelize.query(
            `INSERT INTO query (
                id_query, id_business, id_person, reason_consultation, current_condition,
                pulse, blood_pressure, dia, oxygenation, tou, last, created_at, created_by, updated_at, updated_by
             ) VALUES (
                :_id_query, :_id_business, :_id_person, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL, 1, NOW(), :_id_login, NULL, NULL
             )`,
            {
                replacements: {
                    _id_query: idQuery,
                    _id_business: body.id_business,
                    _id_person: idPerson,
                    _id_login: body.id_login
                },
                type: QueryTypes.INSERT,
                transaction
            }
        );

        await sequelize.query(
            `INSERT INTO allergy (
                id_allergy, id_business, id_patient, has_allergy, description, active,
                is_active, created_at, created_by, updated_at, updated_by
             ) VALUES (
                :_id_allergy, :_id_business, :_id_person, NULL, NULL, 1,
                1, NOW(), :_id_login, NULL, NULL
             )`,
            {
                replacements: {
                    _id_allergy: idAllergy,
                    _id_business: body.id_business,
                    _id_person: idPerson,
                    _id_login: body.id_login
                },
                type: QueryTypes.INSERT,
                transaction
            }
        );

        await Identity.patientWrite(body, idPerson, transaction, true);
        await transaction.commit();
        return responseData.success({ id_person: idPerson }, Messages.DATA_SAVE_SUCCESSFULLY);
    } catch (error) {
        await transaction.rollback();
        return identityError(error);
    }
}

/**
 * Permite registrar un px
 * @returns Lista de paises
 */
async pxSave(body) {
    let response;        
    try {
        body = normalizePatient(body);

        // let _family_parents = body.family_parents.map((p)=>{
        //     return{
        //         ...p,
        //         live : Number(p.live),
        //         dead : Number(p.dead)
        //     }
        // });
        let resultFile = null;
        if(body.files && body.files.file) {
            resultFile = await uploadImage(config.BUCKETS.FIRMAS, body.files.file);
        }
        

        let person = body.person;
        let address = body.address;
        let query = body.query;
        let allergy = body.allergy;
        allergy = hydrateAllergy(allergy);
        if (allergy.review_status !== 'UNREVIEWED') {
            const reviewError = validateReview({ ...allergy, expected_revision: 0 });
            if (reviewError) return responseData.bad_request(reviewError);
        }
        let family_parents = null;//JSON.stringify(_family_parents);
        let family_brothers = null;//JSON.stringify(body.family_brothers);
        let family_grandparents = null;//JSON.stringify(body.family_grandparents);
        let pathological_data =  body.pathological_data ? JSON.stringify((body.pathological_data)) : null;
        let social_media =  body.social_media ? JSON.stringify((body.social_media)) : null;

        const transaction = await sequelize.transaction();
        try {
            const duplicate = await sequelize.query(
                `SELECT p.id_person
                   FROM person p
                  WHERE p.active = 1
                    AND p.id_business COLLATE ${PATIENT_COLLATION} = :_id_business COLLATE ${PATIENT_COLLATION}
                    AND p.name COLLATE ${PATIENT_COLLATION} = :_name COLLATE ${PATIENT_COLLATION}
                    AND p.surname COLLATE ${PATIENT_COLLATION} = :_surname COLLATE ${PATIENT_COLLATION}
                    AND p.birthday = :_birthday
                    AND p.age = :_age
                  LIMIT 1`,
                {
                    replacements: {
                        _id_business: body.id_business,
                        _name: person.name,
                        _surname: person.surname,
                        _birthday: person.birthday,
                        _age: person.age
                    },
                    type: QueryTypes.SELECT,
                    transaction
                }
            );

            if (duplicate && duplicate.length > 0) {
                await transaction.rollback();
                return responseData.notSuccess('Ya se encuentra un paciente con los datos proporcionados.');
            }

            const idPerson = uuidv4();
            const idAddress = uuidv4();
            const idQuery = uuidv4();
            const idAllergy = uuidv4();
            const code = await nextPatientCode(sequelize, transaction);

            await sequelize.query(
                `INSERT INTO person (
                    id_person, id_business, code, name, surname, birthday, age, ocupation, rfc, active,
                    local_telephone, telephone, name_signature, social_media, id_signature,
                    created_at, created_by, updated_at, updated_by
                 ) VALUES (
                    :_id_person, :_id_business, :_code, :_name, :_surname,
                    :_birthday, :_age, :_ocupation, :_rfc, 1,
                    :_local_telephone, :_telephone, :_name_signature, :_social_media, :_id_signature,
                    NOW(), :_id_login, NULL, NULL
                 )`,
                {
                    replacements: {
                        _id_person: idPerson,
                        _id_business: body.id_business,
                        _code: code,
                        _name: person.name,
                        _surname: person.surname,
                        _birthday: person.birthday,
                        _age: person.age,
                        _ocupation: person.ocupation,
                        _rfc: person.rfc,
                        _local_telephone: nullableValue(cleanPhone(person.local_telephone)),
                        _telephone: cleanPhone(person.telephone),
                        _name_signature: person.name_signature ? person.name_signature : null,
                        _social_media: social_media,
                        _id_signature: resultFile && resultFile.Location ? resultFile.Location : '',
                        _id_login: body.id_login
                    },
                    type: QueryTypes.INSERT,
                    transaction
                }
            );

            await sequelize.query(
                `INSERT INTO address (
                    id_address, id_business, id_person, place_birth, residence, direction, cp,
                    last, created_at, created_by, updated_at, updated_by
                 ) VALUES (
                    :_id_address, :_id_business, :_id_person, :_place_birth, :_residence, :_direction, :_cp,
                    1, NOW(), :_id_login, NULL, NULL
                 )`,
                {
                    replacements: {
                        _id_address: idAddress,
                        _id_business: body.id_business,
                        _id_person: idPerson,
                        _place_birth: address.place_birth,
                        _residence: address.residence,
                        _direction: address.direction,
                        _cp: address.cp,
                        _id_login: body.id_login
                    },
                    type: QueryTypes.INSERT,
                    transaction
                }
            );

            await sequelize.query(
                `INSERT INTO query (
                    id_query, id_business, id_person, reason_consultation, current_condition,
                    pulse, blood_pressure, dia, oxygenation, tou, last, created_at, created_by, updated_at, updated_by
                 ) VALUES (
                    :_id_query, :_id_business, :_id_person, :_reason_consultation, :_current_condition,
                    :_pulse, :_blood_pressure, :_dia, :_oxygenation, NULL, 1, NOW(), :_id_login, NULL, NULL
                 )`,
                {
                    replacements: {
                        _id_query: idQuery,
                        _id_business: body.id_business,
                        _id_person: idPerson,
                        _reason_consultation: query.reason_consultation,
                        _current_condition: query.current_condition,
                        _pulse: nullableValue(query.pulse),
                        _blood_pressure: nullableValue(query.blood_pressure),
                        _dia: nullableValue(query.dia),
                        _oxygenation: nullableValue(query.oxygenation),
                        _id_login: body.id_login
                    },
                    type: QueryTypes.INSERT,
                    transaction
                }
            );

            await sequelize.query(
                `INSERT INTO allergy (
                    id_allergy, id_business, id_patient, has_allergy, description, active,
                    is_active, created_at, created_by, updated_at, updated_by, review_status, revision, reviewed_at, reviewed_by
                 ) VALUES (
                    :_id_allergy, :_id_business, :_id_person, :_has_allergy, :_description, 1,
                    1, NOW(), :_id_login, NULL, NULL, :_review_status, :_revision, IF(:_revision > 0, NOW(3), NULL), IF(:_revision > 0, :_id_login, NULL)
                 )`,
                {
                    replacements: {
                        _id_allergy: idAllergy,
                        _id_business: body.id_business,
                        _id_person: idPerson,
                        _has_allergy: allergy.has_allergy,
                        _description: allergy.review_status === 'NONE_KNOWN' ? '' : allergy.description,
                        _review_status: allergy.review_status,
                        _revision: allergy.review_status === 'UNREVIEWED' ? 0 : 1,
                        _id_login: body.id_login
                    },
                    type: QueryTypes.INSERT,
                    transaction
                }
            );

            if (body.pathological_data && Array.isArray(body.pathological_data)) {
                for (const item of body.pathological_data) {
                    await sequelize.query(
                        `INSERT INTO pathological_personal (
                            id_pathological_personal, id_business, id_person, id_type_pathological_personal,
                            json, created_at, created_by, updated_at, updated_by
                         ) VALUES (
                            :_id_pathological_personal, :_id_business, :_id_person, :_id_type_pathological_personal,
                            :_json, NOW(), :_id_login, NULL, NULL
                         )`,
                        {
                            replacements: {
                                _id_pathological_personal: uuidv4(),
                                _id_business: body.id_business,
                                _id_person: idPerson,
                                _id_type_pathological_personal: item.id_type_pathological_personal,
                                _json: JSON.stringify(item),
                                _id_login: body.id_login
                            },
                            type: QueryTypes.INSERT,
                            transaction
                        }
                    );
                }
            }

            await Identity.patientWrite(body, idPerson, transaction, true);
            await transaction.commit();
            return responseData.success({ id_person: idPerson }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (innerError) {
            await transaction.rollback();
            throw innerError;
        }

        let result = await sequelize.query(SequelizeSP.SP_PX_SAVE, {
            replacements: {
                _name : person.name,
                _surname : person.surname,
                _birthday : person.birthday,
                _age : person.age,
                _ocupation : person.ocupation,
                _rfc : person.rfc,
                _local_telephone : person.local_telephone,
                _telephone : person.telephone,
                _id_signature : resultFile && resultFile.Location ? resultFile.Location : '',
                _name_signature : person.name_signature ? person.name_signature : null,
                _place_birth : address.place_birth,
                _residence : address.residence,
                _direction : address.direction,
                _cp : address.cp,
                _reason_consultation : query.reason_consultation,
                _current_condition : query.current_condition,
                _pulse : query.pulse,
                _blood_pressure : query.blood_pressure,
                _dia : query.dia,
                _oxygenation : query.oxygenation,
                _family_parents : family_parents,
                _family_brothers : family_brothers,
                _family_grandparents : family_grandparents,
                _pathological_personal : pathological_data,
                _has_allergy : allergy.has_allergy,
                _description : allergy.description,
                _social_media: social_media,
                _id_login : body.id_login,
                _id_business : body.id_business
            },
            type: QueryTypes.RAW,
            plain: true
        });

        if(result){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);
            if (!SQLValid.hasError && result[0] && result[0].id_person && body.id_business) {
                await sequelize.query(
                    'UPDATE person SET id_business = :_id_business WHERE id_person = :_id_person',
                    {
                        replacements: {
                            _id_business: body.id_business,
                            _id_person: result[0].id_person
                        },
                        type: QueryTypes.UPDATE
                    }
                );
            }
            response =  !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(SQLValid.message);
        }
        else{/* regresamos una excepción controlada al no obtener una respuesta */
            response = responseData.notSuccess(Messages.DATA_GET_ERROR)    
        }
    } catch (error) {
            response = identityError(error);
    }
    return response;
}


/**
 * Permite actualizar un px
 * @returns
 */
async pxUpdate(body) {
    // The old procedure commits internally; use one caller-owned transaction for identity + clinical draft.
    const transaction = await sequelize.transaction();
    try {
        body = normalizePatient(body);
        const p=body.person,a=body.address,q=body.query;
        const scope={id:p.id_person,business:body.id_business,actor:body.id_login};
        const [patient]=await sequelize.query('SELECT id_person FROM person WHERE id_person=:id AND id_business=:business AND active=1 FOR UPDATE',{replacements:scope,transaction,type:QueryTypes.SELECT});
        if(!patient) throw Object.assign(new Error('Paciente no encontrado.'),{status:404});
        // Validate current child ownership before any identity write or signature upload.
        for(const [table,key,data] of [['address','id_address',a],['query','id_query',q]]) {
            const [child]=await sequelize.query(`SELECT ${key} FROM ${table} WHERE ${key}=:child AND id_business=:business AND id_person=:id AND last=1 FOR UPDATE`,{replacements:{...scope,child:data[key]},transaction,type:QueryTypes.SELECT});
            if(!child)throw Object.assign(new Error('Recarga los datos del paciente.'),{status:409});
        }
        for(const item of body.pathological_data||[]) {
            if(!item.id_pathological_personal)continue;
            const [owned]=await sequelize.query('SELECT id_pathological_personal FROM pathological_personal WHERE id_pathological_personal=:child AND id_person=:id AND id_business=:business FOR UPDATE',{replacements:{...scope,child:item.id_pathological_personal},transaction,type:QueryTypes.SELECT});
            if(!owned)throw Object.assign(new Error('Antecedente no encontrado.'),{status:404});
        }
        await Identity.patientWrite(body,p.id_person,transaction);
        if(!p.id_signature && body.files && body.files.file) { const uploaded=await uploadImage(config.BUCKETS.FIRMAS,body.files.file);p.id_signature=uploaded.Location; }
        p.telephone=cleanPhone(p.telephone);p.local_telephone=cleanPhone(p.local_telephone);
        for(const [table,key,data,fields] of [
            ['person','id_person',p,['name','surname','birthday','age','ocupation','rfc','local_telephone','telephone','name_signature','id_signature']],
            ['address','id_address',a,['place_birth','residence','direction','cp']],
            ['query','id_query',q,['reason_consultation','current_condition','pulse','blood_pressure','dia','oxygenation']]
        ]) {
            const id=data[key];
            const values={...scope,child:id,...Object.fromEntries(fields.map(f=>[f,nullableValue(data[f])]))};
            if(table==='person') {
                await sequelize.query(`UPDATE person SET ${fields.map(f=>f+'=:'+f).join(',')},updated_at=UTC_TIMESTAMP(),updated_by=:actor WHERE id_person=:id AND id_business=:business`,{replacements:values,transaction});
            } else {
                // Preserve the legacy procedure's append-only address/query history, within this transaction.
                await sequelize.query(`UPDATE ${table} SET last=0 WHERE id_person=:id AND id_business=:business AND last=1`,{replacements:scope,transaction});
                await sequelize.query(`INSERT INTO ${table} (${key},id_business,id_person,${fields.join(',')},last,created_at,created_by) VALUES (:child,:business,:id,${fields.map(f=>':'+f).join(',')},1,UTC_TIMESTAMP(),:actor)`,{replacements:{...values,child:uuidv4()},transaction});
            }
        }
        await sequelize.query('UPDATE person SET social_media=:social WHERE id_person=:id AND id_business=:business',{replacements:{...scope,social:body.social_media?JSON.stringify(body.social_media):null},transaction});
        for(const item of body.pathological_data||[]) {
            const key=item.id_pathological_personal;
            const json=JSON.stringify(Object.fromEntries(Object.entries(item).filter(([k])=>k!=='id_pathological_personal')));
            if(key) {
                await sequelize.query('UPDATE pathological_personal SET json=:json,updated_at=UTC_TIMESTAMP(),updated_by=:actor WHERE id_pathological_personal=:child AND id_person=:id AND id_business=:business',{replacements:{...scope,child:key,json},transaction});
            } else await sequelize.query('INSERT INTO pathological_personal (id_pathological_personal,id_business,id_person,id_type_pathological_personal,json,created_at,created_by) VALUES (:child,:business,:id,:type,:json,UTC_TIMESTAMP(),:actor)',{replacements:{...scope,child:uuidv4(),type:item.id_type_pathological_personal,json},transaction});
        }
        // Allergy revisions and signatures remain on their dedicated endpoints.
        await transaction.commit();return responseData.success({id_person:p.id_person},Messages.DATA_SAVE_SUCCESSFULLY);
    } catch(error) {await transaction.rollback();return identityError(error);}
}


/**
 * Permite obtener un listado de los px
 * @returns Lista de paises
 */
async pxForceDelete() {
    return responseData.forbidden('El borrado definitivo de pacientes esta deshabilitado. Archiva el paciente para conservar su expediente.');
}

/**
 * Permite obtener un listado de los px
 * @returns Lista de paises
 */
async pxDelete(id_person, id_login, id_business) {
    return this.setArchived(id_person, id_login, id_business, true);
}

/**
 * Permite obtener un listado de los px
 * @returns Lista de paises
 */
async getPxSearchPage(param, idBusiness, options = {}) {
    if (!idBusiness) return responseData.forbidden('No hay consultorio activo.');
    const requestedPage = options.page === undefined ? 1 : options.page;
    const pageSize = options.pageSize === undefined ? 8 : options.pageSize;
    if (typeof param !== 'string' || param.length > 120 || !Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 1000000
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) return responseData.bad_request('Busqueda o paginacion invalida.');
    try {
        const term = normalizeSearchTerm(param);
        // '=' escapes LIKE metacharacters without depending on MySQL's
        // NO_BACKSLASH_ESCAPES mode. Search only the authorized tenant's rows.
        const match = term ? `CONCAT_WS(' ', p.name, p.surname, p.telephone, p.local_telephone, p.ocupation,
            CONCAT(p.age, ' años'), CONCAT('Expediente ', p.code), p.id_person) LIKE :term ESCAPE '='` : '1 = 1';
        const baseWhere = `p.id_business = :business AND ${options.includeArchived === true ? 'p.active IN (0, 1)' : 'p.active = 1'}`;
        const replacements = { business: idBusiness, term: `%${term.replace(/[=%_]/g, character => '=' + character)}%` };
        const totals = await sequelize.query(`SELECT COUNT(*) AS totalPatients,
            COALESCE(SUM(CASE WHEN ${match} THEN 1 ELSE 0 END), 0) AS total,
            COALESCE(SUM(CASE WHEN NULLIF(TRIM(p.ocupation), '') IS NOT NULL THEN 1 ELSE 0 END), 0) AS withOccupation
            FROM person p WHERE ${baseWhere}`, { replacements, type: QueryTypes.SELECT });
        const counts = totals[0] || {}, total = Number(counts.total || 0);
        const pageCount = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(requestedPage, pageCount);
        const items = total ? await sequelize.query(`SELECT p.id_person, p.code, p.active, p.name, p.surname,
            p.ocupation, p.local_telephone, p.telephone, p.age
            FROM person p WHERE ${baseWhere} AND (${match})
            ORDER BY p.created_at DESC, p.name ASC, p.id_person ASC LIMIT :limit OFFSET :offset`, {
            replacements: { ...replacements, limit: pageSize, offset: (page - 1) * pageSize }, type: QueryTypes.SELECT
        }) : [];
        return responseData.success({ items, pagination: { page, pageSize, pageCount, total,
            totalPatients: Number(counts.totalPatients || 0), withOccupation: Number(counts.withOccupation || 0) } }, Messages.DATA_GET_SUCCESSFULLY);
    } catch (error) { return SequelizeException(error, Messages.DATA_GET_ERROR); }
}

 async getPxSearch(param, id_business, options = {}) {
    let response;        
    try {
        const value = `%${param || ''}%`;
        let result = await sequelize.query(
            `SELECT
                p.id_person,
                p.code,
                p.active,
                p.name,
                p.surname,
                p.rfc,
                p.ocupation,
                p.local_telephone,
                p.telephone,
                p.birthday,
                p.age
             FROM person p
             WHERE ${options.includeArchived === true ? 'p.active IN (0, 1)' : 'p.active = 1'}
               AND p.id_business COLLATE ${PATIENT_COLLATION} = :_id_business COLLATE ${PATIENT_COLLATION}
               AND (
                    p.name COLLATE ${PATIENT_COLLATION} LIKE :_value COLLATE ${PATIENT_COLLATION}
                 OR p.surname COLLATE ${PATIENT_COLLATION} LIKE :_value COLLATE ${PATIENT_COLLATION}
                 OR p.telephone COLLATE ${PATIENT_COLLATION} LIKE :_value COLLATE ${PATIENT_COLLATION}
                 OR p.local_telephone COLLATE ${PATIENT_COLLATION} LIKE :_value COLLATE ${PATIENT_COLLATION}
                 OR p.code COLLATE ${PATIENT_COLLATION} LIKE :_value COLLATE ${PATIENT_COLLATION}
               )
             ORDER BY p.created_at DESC, p.name ASC`,
            {
                replacements: {
                    _value: value,
                    _id_business: id_business
                },
                type: QueryTypes.SELECT
            }
        );

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

async getPxFastSearch(query, id_business, options = {}) {
    let response;
    try {
        const term = normalizeSearchTerm(query);
        const limit = normalizeSearchLimit(options.limit);

        if(term.length < PATIENT_FAST_SEARCH_MIN_LENGTH) {
            return responseData.success([], Messages.DATA_GET_SUCCESSFULLY);
        }

        const escapedTerm = escapeLikeValue(term);
        const startsWith = `${escapedTerm}%`;
        const contains = `%${escapedTerm}%`;
        const phoneTerm = cleanPhone(term);
        const phoneStartsWith = phoneTerm ? `${escapeLikeValue(phoneTerm)}%` : startsWith;
        const phoneContains = phoneTerm ? `%${escapeLikeValue(phoneTerm)}%` : contains;

        const result = await sequelize.query(
            `SELECT
                p.id_person AS id,
                p.id_person,
                CONCAT(TRIM(IFNULL(p.name, '')), ' ', TRIM(IFNULL(p.surname, ''))) AS name,
                p.name AS firstName,
                p.surname,
                p.code,
                p.telephone,
                p.local_telephone AS localTelephone,
                p.birthday,
                p.age,
                CASE
                    WHEN p.code COLLATE ${PATIENT_COLLATION} = :_term COLLATE ${PATIENT_COLLATION} THEN 0
                    WHEN p.telephone COLLATE ${PATIENT_COLLATION} = :_term COLLATE ${PATIENT_COLLATION}
                      OR p.local_telephone COLLATE ${PATIENT_COLLATION} = :_term COLLATE ${PATIENT_COLLATION} THEN 1
                    WHEN CONCAT(TRIM(IFNULL(p.name, '')), ' ', TRIM(IFNULL(p.surname, ''))) COLLATE ${PATIENT_COLLATION} LIKE :_starts_with COLLATE ${PATIENT_COLLATION} THEN 2
                    WHEN p.name COLLATE ${PATIENT_COLLATION} LIKE :_starts_with COLLATE ${PATIENT_COLLATION}
                      OR p.surname COLLATE ${PATIENT_COLLATION} LIKE :_starts_with COLLATE ${PATIENT_COLLATION} THEN 3
                    WHEN p.telephone COLLATE ${PATIENT_COLLATION} LIKE :_phone_starts_with COLLATE ${PATIENT_COLLATION}
                      OR p.local_telephone COLLATE ${PATIENT_COLLATION} LIKE :_phone_starts_with COLLATE ${PATIENT_COLLATION} THEN 4
                    WHEN CONCAT(TRIM(IFNULL(p.name, '')), ' ', TRIM(IFNULL(p.surname, ''))) COLLATE ${PATIENT_COLLATION} LIKE :_contains COLLATE ${PATIENT_COLLATION} THEN 5
                    ELSE 6
                END AS relevance
             FROM person p
             WHERE p.active = 1
               AND p.id_business COLLATE ${PATIENT_COLLATION} = :_id_business COLLATE ${PATIENT_COLLATION}
               AND (
                    p.code COLLATE ${PATIENT_COLLATION} LIKE :_starts_with COLLATE ${PATIENT_COLLATION}
                 OR p.name COLLATE ${PATIENT_COLLATION} LIKE :_contains COLLATE ${PATIENT_COLLATION}
                 OR p.surname COLLATE ${PATIENT_COLLATION} LIKE :_contains COLLATE ${PATIENT_COLLATION}
                 OR CONCAT(TRIM(IFNULL(p.name, '')), ' ', TRIM(IFNULL(p.surname, ''))) COLLATE ${PATIENT_COLLATION} LIKE :_contains COLLATE ${PATIENT_COLLATION}
                 OR p.telephone COLLATE ${PATIENT_COLLATION} LIKE :_phone_contains COLLATE ${PATIENT_COLLATION}
                 OR p.local_telephone COLLATE ${PATIENT_COLLATION} LIKE :_phone_contains COLLATE ${PATIENT_COLLATION}
                 OR REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(p.telephone, ''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE :_phone_contains
                 OR REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(p.local_telephone, ''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE :_phone_contains
               )
             ORDER BY relevance ASC, p.created_at DESC, p.name ASC, p.surname ASC
             LIMIT :_limit`,
            {
                replacements: {
                    _term: term,
                    _starts_with: startsWith,
                    _contains: contains,
                    _phone_starts_with: phoneStartsWith,
                    _phone_contains: phoneContains,
                    _id_business: id_business,
                    _limit: limit
                },
                type: QueryTypes.SELECT
            }
        );

        const SQLValid = SQLException(result);
        response = !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
    } catch (error) {
        response = SequelizeException(error, Messages.DATA_GET_ERROR);
    }
    return response;
}

/**
 * Permite obtener un listado de los px
 * @returns Lista de paises
 */
async getPxBirtDay(id_business) {
    let response;        
    try {
        let result = await sequelize.query(SequelizeSP.SP_PX_BIRTHDAY, {
            replacements: {
                _month : new Date().getMonth() + 1,
                _id_business : id_business
            },
            type: QueryTypes.RAW,
            plain: true
        });

        if(result){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(SQLValid.message);
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
 * Permite obtener un listado los tipos de parentesco del paciente
 * @returns Lista de paises
 */
async getFamilyPath() {
    let response;        
    try {
        let result = await sequelize.query(SequelizeSP.SP_FAMILY_PATH_GET, {
            replacements: {        
            },
            type: QueryTypes.RAW,
            plain: true
        });

        if(result){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);
            response =  !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(SQLValid.message);
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
 * Permite obtener el expdiente de un px
 * @param {Number} _id_person id de PX
 * @returns 
 */
async getPxById(_id_person, id_business, options = {}) {
    let response;        
    try {
        if (options.clinical !== true) {
            const records = await sequelize.query(`SELECT
                JSON_OBJECT('id_person', p.id_person, 'code', p.code, 'fullname', CONCAT_WS(' ', p.name, p.surname),
                    'name', p.name, 'surname', p.surname, 'birthday', DATE_FORMAT(p.birthday, '%d-%m-%Y'),
                    'age', p.age, 'active', p.active, 'ocupation', p.ocupation, 'rfc', p.rfc,
                    'local_telephone', p.local_telephone, 'telephone', p.telephone, 'profile', prx.url) AS person,
                JSON_OBJECT('id_address', a.id_address, 'place_birth', a.place_birth, 'residence', a.residence,
                    'direction', a.direction, 'cp', a.cp) AS address
                FROM person p
                LEFT JOIN address a ON a.id_person = p.id_person AND a.id_business = p.id_business AND a.last = 1
                LEFT JOIN profile_px prx ON prx.id_person = p.id_person AND prx.active = 1
                WHERE p.id_person = :patient AND p.id_business = :business LIMIT 1`, {
                replacements: { patient: _id_person, business: id_business }, type: QueryTypes.SELECT
            });
            return records.length ? responseData.success({ person: parseJsonField(records[0].person), address: parseJsonField(records[0].address), access: { clinical: false } }, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess('Paciente no encontrado.');
        }
        let result = await sequelize.query(
            `SELECT IFNULL(p.social_media, '{"inputSelected":"","isCheck":false,"text":null}') social_media,
                     JSON_OBJECT('id_address', a.id_address, 'place_birth', a.place_birth, 'residence', a.residence, 'direction', a.direction, 'cp', a.cp) AS address,
                     JSON_OBJECT('id_query', q.id_query, 'reason_consultation', q.reason_consultation, 'current_condition', q.current_condition, 'pulse', q.pulse, 'blood_pressure', q.blood_pressure, 'dia', q.dia, 'oxygenation', q.oxygenation) AS query,
                     JSON_OBJECT('id_person', p.id_person, 'code', p.code, 'fullname', CONCAT_WS(' ', p.name, p.surname), 'name', p.name, 'surname', p.surname, 'birthday', DATE_FORMAT(p.birthday,'%d-%m-%Y'), 'age', p.age, 'active', p.active, 'ocupation', p.ocupation, 'rfc', p.rfc, 'local_telephone', p.local_telephone, 'telephone', p.telephone, 'id_signature', p.id_signature, 'name_signature', p.name_signature, 'profile', prx.url) AS person
                FROM person p
                LEFT JOIN address a ON p.id_person = a.id_person AND a.last = 1
                LEFT JOIN query q ON p.id_person = q.id_person AND q.last = 1
                LEFT JOIN profile_px prx ON p.id_person = prx.id_person AND prx.active = 1
               WHERE p.id_person COLLATE ${PATIENT_COLLATION} = :_id_person COLLATE ${PATIENT_COLLATION}
                 AND p.id_business COLLATE ${PATIENT_COLLATION} = :_id_business COLLATE ${PATIENT_COLLATION}`,
            {
                replacements: {
                    _id_person: _id_person,
                    _id_business: id_business
                },
                type: QueryTypes.SELECT
            }
        );

        if(result && result.length > 0){/*Validamos si existe un registro de salida */
            let SQLValid = SQLException(result);

            const pathologicalRows = await sequelize.query(
                `SELECT pp.id_pathological_personal, pp.json
                   FROM pathological_personal pp
                  WHERE pp.id_person COLLATE ${PATIENT_COLLATION} = :_id_person COLLATE ${PATIENT_COLLATION}
                    AND pp.id_business COLLATE ${PATIENT_COLLATION} = :_id_business COLLATE ${PATIENT_COLLATION}`,
                {
                    replacements: {
                        _id_person: _id_person,
                        _id_business: id_business
                    },
                    type: QueryTypes.SELECT
                }
            );

            let _pathological_data = pathologicalRows.map((row) => {
                let modelObj = {};
                try {
                    modelObj = typeof row.json === 'string' ? JSON.parse(row.json) : row.json;
                } catch (error) {
                    modelObj = {};
                }
                modelObj.id_pathological_personal = row.id_pathological_personal;
                return modelObj;
            });

            const row = result[0];
            let sqlmodel = {
                access: { clinical: true },
                person : parseJsonField(row.person),
                address : parseJsonField(row.address),
                query : parseJsonField(row.query),
                allergy : await PatientAllergyDao.getCurrent(_id_person, id_business),
                social_media : parseJsonField(row.social_media, { inputSelected: '', isCheck: false, text: null }),
                pathological_data : _pathological_data
            }
            response =  !SQLValid.hasError ? responseData.success(sqlmodel, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(SQLValid.message);
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

module.exports = new PXDao;
