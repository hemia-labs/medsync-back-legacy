const { v5 } = require('uuid');
const { QueryTypes } = require('sequelize');
const db = require('../../db/Sequelize.connection');
const validKey = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
const patientIdFor = body => v5(JSON.stringify(['co25-minimal-v1', body.id_business, body.id_login, body.request_id]), v5.URL);
async function result(body) {
    if (!validKey(body.request_id)) return { status: 400, message: 'Clave de alta invalida.' };
    const transaction = await db.transaction();
    try {
        // Wait for an in-flight creation using the same tenant lock and read current state.
        await db.query('SELECT id_business FROM business WHERE id_business=:business FOR UPDATE', { replacements: { business: body.id_business }, transaction, type: QueryTypes.SELECT });
        const [person] = await db.query('SELECT id_person,active FROM person WHERE id_person=:id AND id_business=:business AND created_by=:actor FOR UPDATE', { replacements: { id: patientIdFor(body), business: body.id_business, actor: body.id_login }, transaction, type: QueryTypes.SELECT });
        await transaction.rollback();
        return person ? { status: 200, success: true, data: person, message: 'Alta encontrada.' }
            : { status: 404, data: { code: 'PATIENT_CREATE_NOT_FOUND' }, message: 'No hay un alta guardada para esta operacion.' };
    } catch (_) { if (!transaction.finished) await transaction.rollback(); return { status: 503, message: 'No se pudo consultar el resultado. Conserva la captura.' }; }
}
module.exports = { validKey, patientIdFor, result };
