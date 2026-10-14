const { QueryTypes } = require('sequelize');
const sequelize = require('../db/Sequelize.connection');
const response = require('../util/responsedata');
const eq = (a, b) => `${a} COLLATE utf8mb4_unicode_ci = ${b} COLLATE utf8mb4_unicode_ci`;
const validId = id => typeof id === 'string' && id.trim().length > 0 && id.length <= 50;

// Legacy procedures accept global IDs; authorize every reference before calling them.
module.exports = async function requireLegacyTreatmentScope(req, res, next) {
    try {
        const body = req.body || {}, params = req.params || {};
        const business = req.tokenDecode && req.tokenDecode.id_business;
        const patient = params.id_person || body.id_person;
        const deny = () => {
            const result = response.forbidden('Paciente o tratamiento no disponible en este consultorio.');
            return res.status(result.status).send(result);
        };
        if (!business || !validId(patient) || params.id_person && body.id_person && params.id_person !== body.id_person) return deny();
        const [owned] = await sequelize.query(`SELECT id_person FROM person WHERE ${eq('id_person', ':patient')} AND ${eq('id_business', ':business')} AND active=1 LIMIT 1`,
            { replacements: { patient, business }, type: QueryTypes.SELECT });
        if (!owned) return deny();
        const ids = [...new Set([body.id_treatment, ...(Array.isArray(body.treatment) ? body.treatment.map(item => item && item.id_treatment) : [])].filter(id => id !== undefined && id !== null))];
        if (ids.some(id => !validId(id))) return deny();
        if (ids.length) {
            const matches = await sequelize.query(`SELECT id_treatment FROM treatment WHERE id_treatment IN (:ids) AND ${eq('id_person', ':patient')}`,
                { replacements: { ids, patient }, type: QueryTypes.SELECT });
            if (matches.length !== ids.length) return deny();
        }
        if (body.id_odontogram !== undefined) {
            if (!validId(body.id_odontogram)) return deny();
            // SP_diagnosis_Get exposes a V1 detail ID as id_odontogram, and
            // SP_aux_diagnosis updates diagnosisV1. Validate those actual rows.
            const rows = await sequelize.query(`SELECT od.id_odontogram_detailv1 FROM odontogramDetailv1 od
                INNER JOIN odontogramv1 o ON ${eq('o.id_odontogramv1', 'od.id_odontogramv1')}
                WHERE ${eq('od.id_odontogram_detailv1', ':id')} AND ${eq('o.id_person', ':patient')} LIMIT 1`,
                { replacements: { id: body.id_odontogram, patient }, type: QueryTypes.SELECT });
            if (!rows[0]) return deny();
        }
        if (body.id_diagnosis !== undefined) {
            if (!validId(body.id_diagnosis)) return deny();
            const rows = await sequelize.query(`SELECT id_diagnosisv1 FROM diagnosisV1 WHERE ${eq('id_diagnosisv1', ':id')} AND ${eq('id_person', ':patient')} AND ${eq('id_odontogram_detailv1', ':odontogram')} LIMIT 1`,
                { replacements: { id: body.id_diagnosis, patient, odontogram: body.id_odontogram || null }, type: QueryTypes.SELECT });
            if (!rows[0]) return deny();
        }
        next();
    } catch (error) { next(error); }
};
