const { QueryTypes } = require('sequelize');
const sequelize = require('../db/Sequelize.connection');
const response = require('../util/responsedata');
const { getBusinessIdFromToken } = require('../util/tenant');
const eq = (left, right) => `${left} COLLATE utf8mb4_unicode_ci = ${right} COLLATE utf8mb4_unicode_ci`;
const validId = id => typeof id === 'string' && id.trim().length > 0 && id.length <= 50;

// Legacy procedures take globally unique ids. Authorize every reference before entering them.
module.exports = async function requireOdontogramScope(req, res, next) {
    try {
        const business = getBusinessIdFromToken(req.tokenDecode);
        const body = req.body || {}, params = req.params || {};
        const requireActive = !['GET', 'HEAD'].includes(req.method);
        const deny = () => { const result = response.forbidden('Odontograma o paciente no disponible en este consultorio.'); res.status(result.status).send(result); };
        if (!business) return deny();
        const patientIds = [params.id_person, params.person, body.id_person].filter(id => id !== undefined && id !== null && id !== '');
        if (patientIds.some(id => !validId(id)) || new Set(patientIds).size > 1) return deny();
        let patient = patientIds[0] || null;
        const references = [
            ['id_odontogram', `odontogram o JOIN person p ON ${eq('p.id_person', 'o.id_person')}`, 'o.id_odontogram', 'o.id_tooth'],
            ['id_odontogramv1', `odontogramv1 o JOIN person p ON ${eq('p.id_person', 'o.id_person')}`, 'o.id_odontogramv1', null],
            ['id_odontogram_detailv1', `odontogramDetailv1 d JOIN odontogramv1 o ON ${eq('o.id_odontogramv1', 'd.id_odontogramv1')} JOIN person p ON ${eq('p.id_person', 'o.id_person')}`, 'd.id_odontogram_detailv1', 'd.id_tooth']
        ];
        for (const [field, from, column, toothColumn] of references) {
            const id = body[field];
            if (id === undefined || id === null || id === '') continue;
            if (!validId(id)) return deny();
            const rows = await sequelize.query(`SELECT p.id_person${toothColumn ? `, ${toothColumn} AS id_tooth` : ''} FROM ${from}
                WHERE ${eq(column, ':id')} AND ${eq('p.id_business', ':business')} ${requireActive ? 'AND p.active = 1' : ''} LIMIT 1`,
                { replacements: { id, business }, type: QueryTypes.SELECT });
            if (!rows[0] || patient && rows[0].id_person !== patient || toothColumn && body.id_tooth && rows[0].id_tooth !== body.id_tooth) return deny();
            patient = rows[0].id_person;
        }
        if (!patient) return deny();
        const patients = await sequelize.query(`SELECT id_person FROM person WHERE ${eq('id_person', ':patient')} AND ${eq('id_business', ':business')} ${requireActive ? 'AND active = 1' : ''} LIMIT 1`,
            { replacements: { patient, business }, type: QueryTypes.SELECT });
        if (!patients[0]) return deny();
        next();
    } catch (error) { next(error); }
};
