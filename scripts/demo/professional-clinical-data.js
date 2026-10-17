'use strict';

// Called only by the isolated presentation-account runner. It supplies one SQL
// connection, an outer transaction and the DAO adapter; this module never opens
// connections, changes schema, sends messages, or modifies existing tenants.
const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');

const signature = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=';
const ok = (response, label) => {
    assert.equal(response.status, 200, `${label}: ${response.message}`);
    return response.data;
};

const CASES = [
    { reason: 'Valoración integral y limpieza dental', condition: 'Acude a revisión preventiva. Refiere sangrado ocasional durante el cepillado.',
        diagnosis: 'Acumulación de placa y gingivitis localizada', findings: 'Placa en superficies posteriores e inflamación gingival leve. Sin dolor espontáneo.',
        plan: 'Profilaxis, refuerzo de higiene oral y revisión de encías.', procedure: 'Profilaxis dental', next: 'Revisión de encías e higiene oral' },
    { reason: 'Sensibilidad en una muela al beber frío', condition: 'Sensibilidad breve en el sector posterior derecho desde hace dos semanas.',
        diagnosis: 'Lesión cariosa en molar inferior derecho', findings: 'Cavidad oclusal localizada en pieza 46. Tejidos blandos sin alteraciones visibles.',
        plan: 'Restauración con resina y revisión posterior de la oclusión.', procedure: 'Restauración con resina', next: 'Revisión de restauración y oclusión' },
    { reason: 'Revisión de restauraciones anteriores', condition: 'Solicita valoración de restauraciones. No refiere dolor actual.',
        diagnosis: 'Control de restauraciones dentales', findings: 'Restauraciones conservadas, sin dolor a la exploración. Higiene oral mejorable en zona posterior.',
        plan: 'Control preventivo, limpieza y seguimiento de restauraciones.', procedure: 'Revisión de restauraciones', next: 'Control preventivo' },
    { reason: 'Revisión de encías', condition: 'Refiere inflamación y sangrado ocasional durante la higiene interdental.',
        diagnosis: 'Gingivitis asociada a placa', findings: 'Eritema marginal leve y placa supragingival. Sin movilidad dental.',
        plan: 'Profilaxis y seguimiento de hábitos de higiene oral.', procedure: 'Control de higiene oral', next: 'Revaloración periodontal' },
    { reason: 'Revisión de guarda oclusal', condition: 'Acude para revisar adaptación y comodidad de la guarda nocturna.',
        diagnosis: 'Seguimiento de guarda oclusal', findings: 'Guarda conservada. Se revisan ajuste y contactos oclusales.',
        plan: 'Ajuste de guarda, revisión de comodidad y control posterior.', procedure: 'Ajuste de guarda oclusal', next: 'Control de adaptación de guarda' },
    { reason: 'Primera valoración odontológica', condition: 'Solicita revisión general y opciones para mejorar su salud bucal.',
        diagnosis: 'Valoración odontológica inicial', findings: 'Exploración inicial pendiente de completar.',
        plan: 'Completar exploración y comentar alternativas de atención.', procedure: 'Valoración integral', next: 'Revisión de resultados y plan' },
    { reason: 'Valoración preventiva periódica', condition: 'Acude para valoración de salud bucal y programación de limpieza dental.',
        diagnosis: 'Necesidad de atención preventiva', findings: 'Placa supragingival localizada. Sin dolor ni sangrado espontáneo referido.',
        plan: 'Profilaxis y control de higiene oral; continuar con revisiones preventivas.', procedure: 'Control preventivo', next: 'Revisión de rutina' },
    { reason: 'Revisión dental general', condition: 'Acude por primera vez al consultorio para revisión.',
        diagnosis: 'Valoración inicial en curso', findings: 'Pendiente de completar exploración odontológica.',
        plan: 'Completar historia y exploración antes de establecer el plan.', procedure: 'Consulta de valoración', next: 'Continuación de valoración' }
];

function clinicalSnapshot(item, index, complete) {
    const snapshot = {
        consultation: { reason: item.reason, current_condition: item.condition, evolution_time: index === 1 ? 'Dos semanas' : 'Consulta programada', main_symptoms: index === 1 ? 'Sensibilidad breve al frío' : 'Sin dolor espontáneo referido' },
        family_history: { relevant: index === 2 ? 'Madre con hipertensión arterial.' : 'Sin antecedentes familiares relevantes referidos.' },
        pathological_history: { current_or_previous_diseases: 'No refiere enfermedades crónicas.', surgeries: 'Niega cirugías previas.', hospitalizations: 'Sin hospitalizaciones recientes.', transfusions: 'Niega transfusiones.' },
        non_pathological_history: { smoking: 'Niega tabaquismo.', alcohol: 'Consumo ocasional.', physical_activity: 'Caminata habitual.', hygiene_general_habits: 'Cepillado dos veces al día; uso irregular de hilo dental.' },
        allergies_medications: { current_medications: 'Sin medicación habitual referida.', known_adverse_reactions: 'No refiere reacciones adversas adicionales.' }
    };
    if (!complete) return snapshot;
    return { ...snapshot,
        systems_review: { review: 'Sin síntomas generales adicionales referidos en el interrogatorio.' },
        physical_exam: { general: 'Paciente alerta, orientado y cooperador. Tejidos blandos orales hidratados.', relevant_findings: item.findings },
        vital_signs: { blood_pressure: '118/76 mmHg', heart_rate: 72 + index, respiratory_rate: 16, temperature: 36.5, oxygen_saturation: 98 },
        studies_results: { previous_studies: 'Sin estudios recientes aportados.', current_results: 'Valoración clínica odontológica registrada.' },
        diagnosis: { initial_diagnosis: item.diagnosis, clinical_problems: item.findings },
        prognosis: { prognosis: 'Favorable con seguimiento y adherencia a las indicaciones.' },
        therapeutic_plan: { initial_plan: item.plan, initial_indications: 'Se explica el plan de atención y se resuelven dudas.', general_recommendations: 'Mantener higiene oral y acudir al control acordado.' },
        observations: { general: 'Se comentan los hallazgos, prioridades y siguientes pasos de atención.' }
    };
}

function completeRequiredValues(history) {
    const snapshot = structuredClone(history.clinical_snapshot_json);
    for (const section of history.template_snapshot_json.sections.filter(section => section.enabled !== false)) {
        snapshot[section.key] ||= {};
        for (const field of (section.fields || []).filter(field => field.enabled !== false && field.required && !(field.type === 'readonly' && field.source))) {
            if (section.key === 'allergies_medications') continue;
            if (snapshot[section.key][field.key] !== undefined && snapshot[section.key][field.key] !== '') continue;
            if (field.type === 'boolean') snapshot[section.key][field.key] = false;
            else if (field.type === 'checkbox') snapshot[section.key][field.key] = true;
            else if (field.type === 'number') snapshot[section.key][field.key] = 1;
            else if (field.type === 'multiselect') snapshot[section.key][field.key] = (field.options || []).slice(0, 1);
            else if (field.type === 'select') snapshot[section.key][field.key] = (field.options || [])[0] || 'Sin observaciones';
            else snapshot[section.key][field.key] = 'Sin otros datos relevantes referidos durante esta valoración.';
        }
    }
    return snapshot;
}

async function seedClinical({ connection, business, doctor, patients, today, dateOffset }) {
    assert.ok(connection && typeof connection.query === 'function', 'The caller must supply the transaction connection');
    const idBusiness = typeof business === 'string' ? business : business.id_business || business.id;
    assert.ok(idBusiness && doctor.id_login && doctor.id_doctor_professional_profile);
    assert.ok(patients.length >= 9, 'At least nine new patients are required');
    const ids = patients.map(patient => patient.id || patient.id_person);
    assert.equal(new Set(ids).size, ids.length);
    const [existing] = await connection.query('SELECT COUNT(*) AS total FROM clinical_histories WHERE business_id=?', [idBusiness]);
    assert.equal(Number(existing[0].total), 0, 'Presentation clinical seeding requires a new tenant without histories');

    const historyDao = require('../../src/Dao/mysql/clinicalHistory.dao');
    const templateDao = require('../../src/Dao/mysql/clinicalHistoryTemplate.dao');
    const allergyDao = require('../../src/Dao/mysql/patientAllergy.dao');
    const documentDao = require('../../src/Dao/mysql/document.dao');
    const prescriptionDao = require('../../src/Dao/mysql/prescription.dao');
    const tracingDao = require('../../src/Dao/mysql/tracing.Dao');
    const TreatmentPlan = require('../../src/Dao/mysql/treatmentPlan.dao');
    const plansDao = new TreatmentPlan();
    const ctx = { id_business: idBusiness, id_login: doctor.id_login };
    const counts = { historiesFinalized: 0, historiesDraft: 0, prescriptionsIssued: 0, prescriptionsDraft: 0, prescriptionsCancelled: 0, plansActive: 0, plansClosed: 0, treatmentItems: 0, followUps: 0, documentsSigned: 0, documentsPending: 0, documentsDraft: 0 };
    const result = { counts, followups: [], historyIds: [], prescriptionIds: [], planIds: [], documentIds: [] };

    if (!await templateDao.getBusinessTemplate(idBusiness)) {
        ok(await templateDao.createBusinessTemplate(ctx), 'Preparar formato de historia clínica');
    }

    // One natural-language template, owned exclusively by this new account.
    const templateId = uuid(), versionId = uuid();
    await connection.query(`INSERT INTO document_templates (id_document_template,id_business,template_type,name,description,
        requires_patient_signature,requires_tutor_signature,requires_doctor_signature,requires_witness1_signature,requires_witness2_signature,is_active,active,created_by)
        VALUES (?,?,'SENSITIVE_DATA_CONSENT','Autorización de tratamiento de datos personales','Información y autorización para el expediente clínico.',1,0,1,0,0,1,1,?)`, [templateId, idBusiness, doctor.id_login]);
    const content = '<h2>Autorización de tratamiento de datos personales</h2><p>Consultorio Dental Alameda</p><p>Paciente: {{nombrePaciente}}</p><p>He recibido información sobre el uso y resguardo de mis datos personales para integrar el expediente clínico y dar continuidad a mi atención. Pude expresar mis dudas y recibir una explicación del aviso de privacidad del consultorio.</p><p>Profesional responsable: {{nombreDoctor}}</p>';
    await connection.query(`INSERT INTO document_template_versions (id_document_template_version,id_document_template,version_number,content_html,status,is_current,created_by)
        VALUES (?,?,1,?,'ACTIVE',1,?)`, [versionId, templateId, content, doctor.id_login]);

    const planTemplateId = uuid(), planVersionId = uuid();
    await connection.query(`INSERT INTO document_templates (id_document_template,id_business,template_type,name,description,
        requires_patient_signature,requires_tutor_signature,requires_doctor_signature,requires_witness1_signature,requires_witness2_signature,is_active,active,created_by)
        VALUES (?,?,'TREATMENT_PLAN_CONSENT','Consentimiento del plan de tratamiento','Revisión y aceptación del plan acordado con el paciente.',1,0,1,0,0,1,1,?)`,
    [planTemplateId, idBusiness, doctor.id_login]);
    const planContent = '<p>He revisado con {{nombreDoctor}} el plan de tratamiento que se detalla a continuación. Recibí una explicación de los procedimientos propuestos, sus beneficios, riesgos y alternativas, así como de las etapas y costos estimados.</p><p>Tuve oportunidad de expresar mis dudas y recibir respuestas antes de decidir. Comprendo que puedo solicitar más información y que cualquier cambio relevante en el plan deberá explicarse nuevamente.</p><p>Después de revisar esta información, manifiesto mi conformidad con el plan acordado.</p>';
    await connection.query(`INSERT INTO document_template_versions (id_document_template_version,id_document_template,version_number,content_html,status,is_current,created_by)
        VALUES (?,?,1,?,'ACTIVE',1,?)`, [planVersionId, planTemplateId, planContent, doctor.id_login]);

    const offsets = [-35, -10, -6, -3, -1, -2, -35, 0];
    const finalizedPatients = new Set([0, 1, 2, 3, 6]);
    for (let index = 0; index < 8; index += 1) {
        const patientId = ids[index], patient = patients[index], item = CASES[index];
        const at = `${dateOffset(offsets[index])} 10:00:00`;
        const complete = finalizedPatients.has(index);
        const allergy = await allergyDao.getCurrent(patientId, idBusiness);
        ok(await allergyDao.update({ ...ctx, patient_id: patientId, expected_revision: allergy.revision,
            review_status: index === 4 ? 'HAS_ALLERGIES' : 'NONE_KNOWN', description: index === 4 ? 'Refiere alergia al látex.' : '' }), 'Registrar revisión de alergias');
        await connection.query('UPDATE allergy SET created_at=?,updated_at=?,reviewed_at=? WHERE id_business=? AND id_patient=?', [at, at, at, idBusiness, patientId]);
        await connection.query('UPDATE patient_allergy_events SET created_at=? WHERE business_id=? AND patient_id=?', [at, idBusiness, patientId]);
        let chart = ok(await historyDao.createDraft({ ...ctx, patient_id: patientId, doctor_responsible_user_id: doctor.id_login,
            source: 'MANUAL', clinical_snapshot_json: clinicalSnapshot(item, index, complete) }), 'Crear historia clínica').history;
        assert.ok(Array.isArray(chart.template_snapshot_json && chart.template_snapshot_json.sections), 'The real history template must be present');
        const docBody = { ...ctx, id_person: patientId, responsible_doctor_user_id: doctor.id_login, id_document_template: templateId, origin: 'CLINICAL_HISTORY' };
        const docList = ok(await documentDao.createDocument({ ...docBody, status: index === 7 ? 'BORRADOR' : 'PENDIENTE_FIRMA' }), 'Crear consentimiento');
        const document = docList.find(row => row.id_document_template === templateId);
        assert.ok(document);
        result.documentIds.push(document.id_patient_document);
        if (complete) {
            ok(await documentDao.updateStatus({ ...docBody, id_patient_document: document.id_patient_document,
                patient_signature: signature, signature_role: 'PATIENT', signer_name: `${patient.name} ${patient.surname}`.trim() },
            'FIRMADO', 'SIGNED', 'Firma presencial del consentimiento.'), 'Firmar consentimiento');
            counts.documentsSigned += 1;
            chart = ok(await historyDao.updateDraft({ ...ctx, id_clinical_history: chart.id_clinical_history, expected_revision: chart.revision,
                doctor_responsible_user_id: doctor.id_login, clinical_snapshot_json: completeRequiredValues(chart) }), 'Completar historia clínica').history;
            chart = ok(await historyDao.finalize({ ...ctx, id_clinical_history: chart.id_clinical_history, expected_revision: chart.revision }), 'Finalizar historia clínica').history;
            assert.equal(chart.status, 'FINALIZED');
            counts.historiesFinalized += 1;
        } else {
            counts.historiesDraft += 1;
            counts[index === 7 ? 'documentsDraft' : 'documentsPending'] += 1;
        }
        result.historyIds.push(chart.id_clinical_history);
        // Backdate only records just created here, preserving each clinical state
        // transition and frozen snapshot produced by the real application DAOs.
        await connection.query(`UPDATE clinical_histories SET created_at=?,updated_at=?,finalized_at=CASE WHEN status='FINALIZED' THEN ? ELSE NULL END
            WHERE business_id=? AND patient_id=? AND id_clinical_history=?`, [at, at, at, idBusiness, patientId, chart.id_clinical_history]);
        await connection.query('UPDATE clinical_history_events SET created_at=? WHERE business_id=? AND clinical_history_id=?', [at, idBusiness, chart.id_clinical_history]);
        await connection.query(`UPDATE patient_documents SET created_at=?,updated_at=?,signed_at=CASE WHEN status='FIRMADO' THEN ? ELSE NULL END
            WHERE id_business=? AND id_person=? AND id_patient_document=?`, [at, at, at, idBusiness, patientId, document.id_patient_document]);
        await connection.query('UPDATE patient_document_signatures SET signed_at=?,created_at=? WHERE id_business=? AND id_patient_document=?', [at, at, idBusiness, document.id_patient_document]);
        await connection.query('UPDATE patient_document_events SET created_at=? WHERE id_business=? AND id_patient_document=?', [at, idBusiness, document.id_patient_document]);
    }

    const rxOffsets = [-35, -10, -5, -3, -2, -1, 0, -1, -6];
    for (let index = 0; index < rxOffsets.length; index += 1) {
        const patientId = ids[index], issued = index < 6 || index === 8;
        const date = dateOffset(rxOffsets[index]), at = `${date} 11:30:00`;
        const prescription = { create_request_id: uuid(), id_person: patientId, issuer_doctor_id: doctor.id_login, issue_date: date,
            diagnosis: 'Control preventivo de salud bucal', notes: 'Indicaciones de higiene oral acordadas durante la consulta.',
            items: [{ generic_name: 'Pasta dental con fluoruro', presentation: 'Tubo', concentration: '1,450 ppm de flúor', pharmaceutical_form: 'Pasta dental',
                quantity: '1 tubo', dose: 'Una pequeña cantidad en el cepillo', administration_route: 'Uso dental', frequency: 'Dos veces al día', duration: 'Hasta la siguiente revisión',
                indications: 'Realizar el cepillado habitual y escupir al terminar. No ingerir.' }] };
        const draft = ok(await prescriptionDao.save({ ...ctx, prescription }), 'Guardar receta');
        const rxContext = { ...ctx, id_prescription: draft.id_prescription };
        if (issued) {
            ok(await prescriptionDao.issue(rxContext), 'Emitir receta');
            if (index === 8) {
                ok(await prescriptionDao.cancel({ ...rxContext, reason: 'Se sustituyó por la versión corregida de las indicaciones.' }), 'Cancelar receta sustituida');
                counts.prescriptionsCancelled += 1;
            } else counts.prescriptionsIssued += 1;
        } else counts.prescriptionsDraft += 1;
        await connection.query(`UPDATE prescription SET created_at=?,updated_at=?,issued_at=CASE WHEN status IN ('issued','cancelled') THEN ? ELSE NULL END,
            cancelled_at=CASE WHEN status='cancelled' THEN ? ELSE NULL END WHERE id_business=? AND id_person=? AND id_prescription=?`,
        [at, at, at, at, idBusiness, patientId, draft.id_prescription]);
        await connection.query('UPDATE prescription_audit_log SET created_at=? WHERE id_business=? AND id_prescription=?', [at, idBusiness, draft.id_prescription]);
        result.prescriptionIds.push(draft.id_prescription);
    }

    const planDefinitions = [
        { index: 0, title: 'Plan preventivo y restaurativo', items: [['Profilaxis dental', 'completed', 850, []], ['Restauración con resina', 'in_progress', 1450, ['16']], ['Control preventivo', 'pending', 650, []]] },
        { index: 1, title: 'Restauración de molar inferior', items: [['Restauración con resina', 'in_progress', 1450, ['46']], ['Revisión de oclusión', 'pending', 450, ['46']]] },
        { index: 2, title: 'Mantenimiento de restauraciones', items: [['Revisión de restauraciones', 'completed', 650, []], ['Profilaxis dental', 'pending', 850, []]] },
        { index: 3, title: 'Salud de encías', items: [['Profilaxis dental', 'completed', 850, []], ['Control de higiene oral', 'in_progress', 650, []]] },
        { index: 4, title: 'Control de guarda oclusal', items: [['Ajuste de guarda oclusal', 'completed', 700, []], ['Control de adaptación', 'pending', 450, []]] },
        { index: 5, title: 'Valoración inicial y prevención', items: [['Valoración integral', 'in_progress', 650, []], ['Limpieza dental', 'pending', 850, []]] },
        { index: 6, title: 'Plan preventivo concluido', closed: true, items: [['Profilaxis dental', 'completed', 850, []], ['Control preventivo', 'completed', 650, []]] }
    ];
    const returnOffsets = [2, 1, 7, -2, 10, 5, null];
    for (const definition of planDefinitions) {
        const index = definition.index, patientId = ids[index], item = CASES[index], planId = uuid();
        const px = { ...ctx, id_person: patientId }, started = dateOffset(index === 6 ? -35 : -12 + index);
        const planBody = { ...px, id_treatment_plan: planId };
        ok(await plansDao.createPlan({ ...px, request_id: planId, title: definition.title, diagnosis: item.diagnosis, notes: 'Plan revisado con el paciente. Se acuerdan prioridades y fechas de control.', started_at: started }), 'Crear plan de tratamiento');
        const treatmentIds = [];
        for (const [name, status, cost, teeth] of definition.items) {
            const itemId = uuid(); treatmentIds.push(itemId);
            ok(await plansDao.savePlanTreatment({ ...planBody, request_id: itemId, name, description: name,
                category: /resina/i.test(name) ? 'Restauración' : 'Prevención y control', cost, teeth,
                estimated_start_date: started, estimated_end_date: dateOffset(definition.closed ? -20 : 14), notes: '' }), 'Agregar tratamiento');
            if (status !== 'pending') ok(await plansDao.updatePlanTreatmentStatus({ ...planBody, id_patient_treatment: itemId, status }), 'Actualizar avance de tratamiento');
            await connection.query('UPDATE patient_treatment SET created_at=?,updated_at=? WHERE id_business=? AND id_person=? AND id_patient_treatment=?', [`${started} 12:00:00`, `${dateOffset(definition.closed ? -20 : -1)} 12:00:00`, idBusiness, patientId, itemId]);
            counts.treatmentItems += 1;
        }
        const tracingId = uuid(), nextDate = returnOffsets[index] === null ? null : dateOffset(returnOffsets[index]);
        const tracing = { id_tracing: tracingId, quote_date_now: dateOffset(definition.closed ? -20 : -4), treatment_now: definition.items[0][0],
            id_patient_treatment: treatmentIds[0], quote_date_after: nextDate || '', treatment_after: nextDate ? item.next : 'Control de rutina sin fecha acordada',
            note: definition.closed ? 'Plan completado. El paciente refiere buena evolución.' : 'Se revisa evolución y se acuerda el siguiente control.' };
        ok(await tracingDao.saveTracing({ ...px, tracing: [tracing] }), 'Registrar seguimiento vinculado');
        await connection.query('UPDATE tracing SET created_at=? WHERE id_business=? AND id_person=? AND id_tracing=?', [`${tracing.quote_date_now} 12:30:00`, idBusiness, patientId, tracingId]);
        await connection.query('UPDATE tracing_revision SET recorded_at=? WHERE id_business=? AND id_tracing=?', [`${tracing.quote_date_now} 12:30:00`, idBusiness, tracingId]);
        counts.followUps += 1;
        result.followups.push({ id_tracing: tracingId, patientId, date: nextDate, title: tracing.treatment_after, shouldSchedule: [0, 1, 2, 4].includes(index) });
        if (definition.closed) {
            ok(await plansDao.closePlan({ ...planBody, close_reason: 'Objetivos del plan cumplidos; continúa con controles preventivos.' }), 'Cerrar plan concluido');
            counts.plansClosed += 1;
        } else counts.plansActive += 1;
        await connection.query(`UPDATE treatment_plan SET created_at=?,updated_at=?,closed_at=CASE WHEN status='closed' THEN ? ELSE NULL END
            WHERE id_business=? AND id_person=? AND id_treatment_plan=?`, [`${started} 11:00:00`, `${dateOffset(definition.closed ? -20 : -1)} 12:00:00`, `${dateOffset(-20)} 13:00:00`, idBusiness, patientId, planId]);
        result.planIds.push(planId);
    }

    // A free-text procedure remains valid even when there is no treatment plan.
    const freeId = uuid(), freePatient = ids[8];
    ok(await tracingDao.saveTracing({ ...ctx, id_person: freePatient, tracing: [{ id_tracing: freeId,
        quote_date_now: dateOffset(-1), treatment_now: 'Revisión de rutina', quote_date_after: dateOffset(6),
        treatment_after: 'Revisión preventiva', note: 'Se explica la rutina de higiene oral y se acuerda revisión preventiva.' }] }), 'Registrar seguimiento libre');
    result.followups.push({ id_tracing: freeId, patientId: freePatient, date: dateOffset(6), title: 'Revisión preventiva', shouldSchedule: false });
    counts.followUps += 1;
    assert.equal(today, dateOffset(0));
    return result;
}

module.exports = { seedClinical };
