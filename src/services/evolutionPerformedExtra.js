'use strict';

const { QueryTypes } = require('sequelize');
const { randomUUID } = require('crypto');

// Called inside the clinical transaction, after locking the tenant's patient.
// The source note owns the captured name; patient_treatment owns future edits.
async function recordPerformedExtra(db, transaction, { business, patient, actor, note, name, date }) {
    if (!transaction) throw new Error('Se requiere la transacción de la atención.');
    const trimmed = name.trim();
    if (!trimmed) return;
    if (Array.from(trimmed).length > 255) throw new RangeError('El tratamiento admite hasta 255 caracteres.');
    const keys = { business, patient, note, actor, date, name: trimmed, id: randomUUID() };
    const run = (sql, type) => db.query(sql, { transaction, replacements: keys, type });
    const original = await run(`SELECT id_extra FROM evolution_note_performed_extra
        WHERE id_business=:business AND id_person=:patient AND id_note=:note FOR UPDATE`, QueryTypes.SELECT);
    if (original.length) return;
    await run(`INSERT INTO evolution_note_performed_extra
        (id_extra,id_business,id_person,id_note,name_snapshot,performed_on,created_by)
        VALUES (:id,:business,:patient,:note,:name,:date,:actor)`, QueryTypes.INSERT);
    const plans = await run(`SELECT id_treatment_plan FROM treatment_plan
        WHERE id_business=:business AND id_person=:patient AND active=1 AND status='active' FOR UPDATE`, QueryTypes.SELECT);
    if (plans.length) await attachPendingExtras(db, transaction, business, patient, plans[0].id_treatment_plan);
}

async function attachPendingExtras(db, transaction, business, patient, plan) {
    if (!transaction) throw new Error('Se requiere la transacción del plan.');
    const opts = { replacements: { business, patient, plan }, transaction };
    await db.query(`INSERT INTO patient_treatment
        (id_patient_treatment,id_business,id_person,id_treatment_plan,name,status,cost,source,active,created_by,created_at)
        SELECT id_extra,id_business,id_person,:plan,name_snapshot,'completed',NULL,'performed_extra',1,created_by,NOW()
        FROM evolution_note_performed_extra WHERE id_business=:business AND id_person=:patient AND id_treatment_plan IS NULL`, opts);
    await db.query(`UPDATE evolution_note_performed_extra SET id_treatment_plan=:plan
        WHERE id_business=:business AND id_person=:patient AND id_treatment_plan IS NULL`, opts);
}

module.exports = { recordPerformedExtra, attachPendingExtras };

