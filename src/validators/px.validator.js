const identityContract = require('../domain/identity/contract');
const { normalizeBirthday } = require('../domain/identity/legacyDate');
const validateIdentity = req => { try { identityContract.validate('patient', req.body.identity, {}, {creating:true}); return valid(); } catch(e) { return invalid(e.message); } };
const {
    requireField,
    requireFields,
    requireObject,
    invalid,
    valid
} = require('./common.validator');

const normalizePhone = value => String(value || '').replace(/[()\s-]/g, '');
const validateAdministrativeFormats = (person, address = {}, today = new Date()) => {
    if (typeof person.name !== 'string' || !person.name.trim() || typeof person.surname !== 'string' || !person.surname.trim()) return invalid('El nombre y el apellido del paciente son obligatorios.');
    let date;
    try { date = normalizeBirthday(person.birthday); } catch (_) { return invalid('Ingresa una fecha de nacimiento válida.'); }
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return invalid('Ingresa una fecha de nacimiento válida.');
    const birth = new Date(`${date}T00:00:00`);
    const formatted = Number.isFinite(birth.getTime()) ? `${birth.getFullYear()}-${String(birth.getMonth() + 1).padStart(2, '0')}-${String(birth.getDate()).padStart(2, '0')}` : '';
    if (formatted !== date || birth > today) return invalid('La fecha de nacimiento debe ser real y no puede ser futura.');
    let age = today.getFullYear() - birth.getFullYear();
    if (today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
    if (!Number.isInteger(Number(person.age)) || Number(person.age) !== age || age < 0 || age > 150) return invalid('La edad debe corresponder con la fecha de nacimiento y ser de hasta 150 años.');
    if (typeof person.telephone !== 'string' || !/^\d{10}$/.test(normalizePhone(person.telephone))) return invalid('El teléfono de contacto debe tener 10 dígitos.');
    if (person.local_telephone != null && person.local_telephone !== '' && (typeof person.local_telephone !== 'string' || !/^\d{10}$/.test(normalizePhone(person.local_telephone)))) return invalid('El teléfono local debe tener 10 dígitos.');
    if (address.cp != null && address.cp !== '' && (typeof address.cp !== 'string' || !/^\d{5}$/.test(address.cp))) return invalid('El código postal debe tener 5 dígitos.');
    return valid();
};

const validatePerson = (person, isUpdate = false) => {
    const fields = [
        'name',
        'surname',
        'birthday',
        'age',
        'ocupation',
        'telephone'
    ];

    if (isUpdate) {
        fields.unshift('id_person');
    }

    const required = requireFields(person, fields);
    return required.isValid ? validateAdministrativeFormats(person) : required;
};

const validateMinimalPerson = (person) => {
    const fields = [
        'name',
        'surname',
        'birthday',
        'age',
        'telephone'
    ];

    const required = requireFields(person, fields);
    return required.isValid ? validateAdministrativeFormats(person) : required;
};

const validateAddress = (address, isUpdate = false) => {
    const fields = ['place_birth', 'residence', 'direction', 'cp'];
    if (isUpdate) {
        fields.unshift('id_address');
    }

    return requireFields(address, fields);
};

const validateQuery = (query, isUpdate = false) => {
    const fields = [
        'reason_consultation',
        'current_condition'
    ];

    if (isUpdate) {
        fields.unshift('id_query');
    }

    return requireFields(query, fields);
};

const validateAllergy = (allergy, isUpdate = false) => {
    // Patient details updates no longer change the independently reviewed allergy record.
    if (isUpdate || allergy.review_status === 'UNREVIEWED' || allergy.review_status === 'UNKNOWN') return valid();
    const fields = ['has_allergy'];
    if (isUpdate) {
        fields.unshift('id_allergy');
    }

    return requireFields(allergy, fields);
};

const validatePxPayload = (req, isUpdate = false) => {
    for (const field of ['person', 'address', 'query', 'allergy']) {
        const result = requireObject(req.body, field);
        if (!result.isValid) {
            return result;
        }
    }

    const validators = [
        validatePerson(req.body.person, isUpdate),
        validateAddress(req.body.address, isUpdate),
        validateQuery(req.body.query, isUpdate),
        validateAllergy(req.body.allergy, isUpdate)
    ];

    return validators.find((result) => !result.isValid) || validateAdministrativeFormats(req.body.person, req.body.address);
};

const validatePxSave = (req) => {
    const result = validateIdentity(req);
    return result.isValid ? validatePxPayload(req) : result;
};

const validatePxCreateMinimal = (req) => {
    const identity = validateIdentity(req); if (!identity.isValid) return identity;
    const personResult = requireObject(req.body, 'person');
    if (!personResult.isValid) {
        return personResult;
    }

    const result = validateMinimalPerson(req.body.person);
    if (!result.isValid) return result;
    if (req.body.address != null && (typeof req.body.address !== 'object' || Array.isArray(req.body.address))) return invalid('Campo invalido: address');
    return validateAdministrativeFormats(req.body.person, req.body.address || {});
};

const validatePxUpdate = (req) => {
    return validatePxPayload(req, true);
};

const validatePxDelete = (req) => {
    return requireField(req.body, 'id_person');
};

const validatePxAdministrative = (req) => {
    for (const field of ['person', 'address']) {
        const result = requireObject(req.body, field);
        if (!result.isValid) return result;
    }
    const person = req.body.person;
    const required = requireFields(person, ['id_person', 'name', 'surname', 'birthday', 'age', 'telephone']);
    if (!required.isValid) return required;
    for (const field of ['id_person', 'name', 'surname', 'birthday', 'telephone']) {
        if (typeof person[field] !== 'string' || !person[field].trim() || person[field].length > 500) return invalid(`Campo invalido: ${field}`);
    }
    if (person.id_person.length > 50 || !/^\d{4}-\d{2}-\d{2}$/.test(person.birthday)) return invalid('Fecha de nacimiento o paciente invalido.');
    const birth = new Date(`${person.birthday}T00:00:00Z`);
    if (!Number.isFinite(birth.getTime()) || birth.toISOString().slice(0, 10) !== person.birthday || birth > new Date()) return invalid('Fecha de nacimiento invalida.');
    if (!Number.isInteger(Number(person.age)) || Number(person.age) < 0 || Number(person.age) > 150) return invalid('Edad invalida.');
    for (const object of [person, req.body.address]) {
        for (const field of ['ocupation', 'rfc', 'local_telephone', 'place_birth', 'residence', 'direction', 'cp']) {
            if (object[field] != null && (typeof object[field] !== 'string' || object[field].length > 1000)) return invalid(`Campo invalido: ${field}`);
        }
    }
    return validateAdministrativeFormats(person, req.body.address);
};

const validatePxSearch = (req) => {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'param')) {
        return valid();
    }

    return requireField(req.body, 'param');
};

const validatePxSearchPage = (req) => {
    const body = req.body || {};
    if (typeof body.param !== 'string' || body.param.length > 120) return invalid('Busqueda invalida (maximo 120 caracteres).');
    if (body.page !== undefined && (!Number.isSafeInteger(body.page) || body.page < 1 || body.page > 1000000)) return invalid('Pagina invalida.');
    if (body.page_size !== undefined && (!Number.isSafeInteger(body.page_size) || body.page_size < 1 || body.page_size > 50)) return invalid('Tamano de pagina invalido (1 a 50).');
    return valid();
};

const validatePxFastSearch = (req) => {
    if (req.body && (
        Object.prototype.hasOwnProperty.call(req.body, 'query')
        || Object.prototype.hasOwnProperty.call(req.body, 'param')
    )) {
        return valid();
    }

    return requireField(req.body, 'query');
};

const validatePxIdParam = (req) => {
    return requireField(req.params, 'id');
};

module.exports = {
    validatePxSearchPage,
    validatePxAdministrative,
    validatePxDelete,
    validatePxFastSearch,
    validatePxIdParam,
    validatePxCreateMinimal,
    validatePxSave,
    validatePxSearch,
    validatePxUpdate
};
