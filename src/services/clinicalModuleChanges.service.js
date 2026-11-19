'use strict';
const { randomUUID } = require('node:crypto');
const sequelize = require('../db/Sequelize.connection');
const { QueryTypes } = require('sequelize');

const columns = {
    odontogramEnabled: 'odontogram_enabled',
    treatmentPlanEnabled: 'treatment_plan_enabled',
    allowTreatmentToothSelection: 'allow_treatment_tooth_selection',
    showTreatmentCosts: 'show_treatment_costs',
    showTreatmentStatus: 'show_treatment_status'
};
const selection = 'allowTreatmentToothSelection';

function invalid() {
    throw Object.assign(new Error('Revisa los cambios de secciones clínicas.'), { status: 422 });
}

function validate(body) {
    const { changes, expected } = body || {};
    for (const values of [changes, expected]) {
        if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) invalid();
        for (const [key, value] of Object.entries(values)) {
            if (!Object.hasOwn(columns, key) || typeof value !== 'boolean') invalid();
        }
    }
    if (Object.keys(changes).some(key => !Object.hasOwn(expected, key))) invalid();
    if (changes.odontogramEnabled === false && !Object.hasOwn(expected, selection)) invalid();
    if (changes[selection] === true && !Object.hasOwn(expected, 'odontogramEnabled')) invalid();
}

async function save(business, actor, body) {
    validate(body);
    const { changes, expected } = body;
    return sequelize.transaction(async transaction => {
        const options = { transaction, replacements: { business, actor } };
        // The tenant's unique key also serializes two simultaneous first-time activations.
        await sequelize.query(
            'INSERT INTO clinical_module_config (id_clinical_module_config, id_business, created_by) ' +
            'VALUES (:id, :business, :actor) ON DUPLICATE KEY UPDATE id_business = id_business',
            { ...options, replacements: { ...options.replacements, id: randomUUID() } }
        );
        const projection = Object.entries(columns).map(([key, column]) => column + ' AS ' + key).join(', ');
        const [row] = await sequelize.query(
            'SELECT ' + projection + ' FROM clinical_module_config WHERE id_business = :business FOR UPDATE',
            { ...options, type: QueryTypes.SELECT }
        );
        const current = Object.fromEntries(Object.keys(columns).map(key => [key, Boolean(Number(row[key]))]));
        if (!current.odontogramEnabled) current[selection] = false;
        if (Object.entries(expected).some(([key, value]) => current[key] !== value)) {
            throw Object.assign(new Error('La configuración cambió desde que la abriste.'), { status: 409, current });
        }
        const next = { ...current, ...changes };
        if (changes[selection] === true && !next.odontogramEnabled) invalid();
        if (!next.odontogramEnabled) next[selection] = false;
        const keys = Object.keys(columns).filter(key => Boolean(Number(row[key])) !== next[key]);
        if (keys.length) {
            const assignments = keys.map(key => columns[key] + ' = :' + key);
            await sequelize.query(
                'UPDATE clinical_module_config SET ' + assignments.join(', ') +
                ', updated_at = NOW(), updated_by = :actor WHERE id_business = :business',
                { ...options, replacements: { ...options.replacements, ...next } }
            );
        }
        return next;
    });
}
module.exports = { save };
