'use strict';
// NC1-EC1: primary emergency contact stored in patient_emergency_contacts (existing table, no DDL).
// Request contract for PUT /api/px/administrative:
//   emergencyContact absent  -> unchanged
//   emergencyContact null    -> the active primary contact is retired (active = 0, row kept)
//   emergencyContact object  -> { name, phone?, relationship? } creates or updates the primary contact
const { randomUUID } = require('node:crypto');

const KEYS = ['name', 'phone', 'relationship'];
const LIMITS = { name: 255, relationship: 150 };
const fail = (field) => { throw Object.assign(new Error('Revisa el contacto de emergencia: ' + field), { status: 400, code: 'EMERGENCY_CONTACT_INVALID', field: 'emergencyContact.' + field }); };
const optionalText = (value, field) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') fail(field);
    const text = value.trim().replace(/\s+/g, ' ');
    if (text.length > LIMITS[field]) fail(field);
    return text || null;
};

function normalize(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) fail('value');
    for (const key of Object.keys(value)) if (!KEYS.includes(key)) fail(key);
    const name = optionalText(value.name, 'name');
    if (!name) fail('name');
    let phone = null;
    if (value.phone !== undefined && value.phone !== null && value.phone !== '') {
        if (typeof value.phone !== 'string') fail('phone');
        phone = value.phone.replace(/[()\s.-]/g, '');
        if (!/^\d{10}$/.test(phone)) fail('phone');
    }
    return { name, phone, relationship: optionalText(value.relationship, 'relationship') };
}

const view = row => row ? { name: row.contact_name, phone: row.contact_phone || null, relationship: row.relationship || null } : null;
const missingTable = error => error && ((error.original && error.original.code) || error.code) === 'ER_NO_SUCH_TABLE';

function createStore(db) {
    const select = (sql, replacements, transaction) => db.query(sql, { replacements, transaction, type: 'SELECT' });
    const ACTIVE = `FROM patient_emergency_contacts WHERE id_person = :patient AND id_business = :business AND active = 1 AND is_primary = 1
        ORDER BY COALESCE(updated_at, created_at) DESC, id_patient_emergency_contact`;

    // Reads tolerate an environment without the table so the patient sheet keeps loading.
    async function read(patient, business, transaction = null) {
        try {
            const rows = await select(`SELECT contact_name, contact_phone, relationship ${ACTIVE} LIMIT 1`, { patient, business }, transaction);
            return view(rows[0]);
        } catch (error) {
            if (missingTable(error)) return null;
            throw error;
        }
    }

    // Caller owns the transaction and has already locked the person row of this tenant.
    async function write(patient, business, actor, value, transaction) {
        if (!transaction || !actor) throw new Error('Emergency contact writes require actor and transaction');
        const next = normalize(value);
        if (next === undefined) return { changed: false };
        const rows = await select(`SELECT id_patient_emergency_contact, contact_name, contact_phone, relationship ${ACTIVE} FOR UPDATE`, { patient, business }, transaction);
        const [current, ...duplicates] = rows;
        const replacements = { patient, business, actor };
        if (next === null) {
            if (!rows.length) return { changed: false };
            await db.query(`UPDATE patient_emergency_contacts SET active = 0, updated_at = NOW(), updated_by = :actor
                WHERE id_person = :patient AND id_business = :business AND active = 1 AND is_primary = 1`, { replacements, transaction });
            return { changed: true };
        }
        // Legacy rows could hold more than one active primary contact; only the newest stays primary.
        for (const row of duplicates) {
            await db.query(`UPDATE patient_emergency_contacts SET is_primary = 0, updated_at = NOW(), updated_by = :actor
                WHERE id_patient_emergency_contact = :id AND id_person = :patient AND id_business = :business`, { replacements: { ...replacements, id: row.id_patient_emergency_contact }, transaction });
        }
        const same = current && current.contact_name === next.name && (current.contact_phone || null) === next.phone && (current.relationship || null) === next.relationship;
        if (same) return { changed: duplicates.length > 0 };
        const values = { ...replacements, name: next.name, phone: next.phone, relationship: next.relationship };
        if (current) {
            await db.query(`UPDATE patient_emergency_contacts SET contact_name = :name, contact_phone = :phone, relationship = :relationship,
                updated_at = NOW(), updated_by = :actor WHERE id_patient_emergency_contact = :id AND id_person = :patient AND id_business = :business`,
            { replacements: { ...values, id: current.id_patient_emergency_contact }, transaction });
        } else {
            await db.query(`INSERT INTO patient_emergency_contacts (id_patient_emergency_contact, id_business, id_person, contact_name, contact_phone, relationship, is_primary, active, created_at, created_by)
                VALUES (:id, :business, :patient, :name, :phone, :relationship, 1, 1, NOW(), :actor)`, { replacements: { ...values, id: randomUUID() }, transaction });
        }
        return { changed: true };
    }

    return { read, write };
}

module.exports = { KEYS, LIMITS, normalize, view, createStore };
