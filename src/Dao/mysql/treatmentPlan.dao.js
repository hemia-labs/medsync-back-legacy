const effectivePermissions = require('../../util/effectivePermissions');
const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const response = require('../../util/responsedata');
const { SequelizeException } = require('../../util/sequelizeException');
const { STATUSES, validateTreatment, validatePlan } = require('../../util/treatmentPlanValidation');
const prescriptionDao = require('./prescription.dao');
const { createHmac, randomBytes } = require('node:crypto');
const reviewKey = process.env.SESSION_SECRET || randomBytes(32);
const consentDocuments = require('../../services/documentSignature/treatmentPlanConsentDocument.service');
const eq = (column, param) => `${column} COLLATE utf8mb4_unicode_ci = ${param} COLLATE utf8mb4_unicode_ci`;
const FLAGS = { view: 'view', create: 'create', edit: 'edit', complete: 'complete', cancel: 'cancel', closePlan: 'close_plan', consentView: 'consent.view', consentSign: 'consent.sign', costView: 'cost_view', costEdit: 'cost_edit' };
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const missingTable = error => (error.original || error).code === 'ER_NO_SUCH_TABLE';

class TreatmentPlanDao {
    reviewToken(plan) {
        const value = { title: plan.title, diagnosis: plan.diagnosis, notes: plan.notes, started_at: plan.started_at,
            treatments: (plan.treatments || []).map(item => ({ id: item.id_patient_treatment, name: item.name, description: item.description, category: item.category,
                status: item.status, cost: item.cost, start: item.estimated_start_date, end: item.estimated_end_date, notes: item.notes, teeth: item.teeth })).sort((a, b) => a.id.localeCompare(b.id)) };
        return createHmac('sha256', reviewKey).update(JSON.stringify(value)).digest('hex');
    }
    async query(sql, replacements, transaction = null, type = QueryTypes.SELECT) {
        return sequelize.query(sql, { replacements, transaction, type });
    }
    keys(body) {
        return { business: body.id_business, patient: body.id_person, actor: body.id_login, plan: body.id_treatment_plan || null, item: body.id_patient_treatment || null };
    }
    async permissions(actor) {
        const rows = await effectivePermissions.rows(actor, {enabledCatalog:true});
        const codes = new Set(rows.map(row => row.code));
        const permissions = Object.fromEntries(Object.entries(FLAGS).map(([flag, code]) => [flag, codes.has(`treatments.${code}`)]));
        permissions.remoteRequest = codes.has('documents.signature.request') && (permissions.consentView || permissions.consentSign);
        permissions.consentPrepare = permissions.consentSign || permissions.remoteRequest;
        return permissions;
    }
    async context(body, flag) {
        if (!body.id_business) return { error: response.forbidden('No hay consultorio activo.') };
        const permissions = await this.permissions(body.id_login);
        if (!permissions[flag]) return { error: response.forbidden('No tienes permiso para esta operación del plan de tratamiento.') };
        const rows = await this.query(`SELECT id_person, id_business, name, surname, age, birthday FROM person
            WHERE ${eq('id_person', ':patient')} AND ${eq('id_business', ':business')} AND active = 1 LIMIT 1`, this.keys(body));
        if (!rows[0]) return { error: response.forbidden('El paciente no pertenece al consultorio activo.') };
        return { permissions, patient: rows[0] };
    }
    async configuration(body, transaction = null) {
        const rows = await this.query(`SELECT odontogram_enabled AS odontogramEnabled, treatment_plan_enabled AS treatmentPlanEnabled,
            allow_treatment_tooth_selection AS allowTreatmentToothSelection, show_treatment_costs AS showTreatmentCosts,
            show_treatment_status AS showTreatmentStatus FROM clinical_module_config WHERE ${eq('id_business', ':business')} LIMIT 1`, this.keys(body), transaction);
        const config = rows[0] || {};
        return { odontogramEnabled: Boolean(config.odontogramEnabled), treatmentPlanEnabled: config.treatmentPlanEnabled === undefined || Boolean(config.treatmentPlanEnabled),
            allowTreatmentToothSelection: Boolean(config.allowTreatmentToothSelection), showTreatmentCosts: config.showTreatmentCosts === undefined || Boolean(config.showTreatmentCosts),
            showTreatmentStatus: config.showTreatmentStatus === undefined || Boolean(config.showTreatmentStatus) };
    }
    async plans(body, transaction = null, lock = false) {
        return this.query(`SELECT tp.*, creator.name AS created_by_name, editor.name AS updated_by_name, closer.name AS closed_by_name
            FROM treatment_plan tp
            LEFT JOIN login creator ON ${eq('creator.id_login', 'tp.created_by')} AND ${eq('creator.id_business', 'tp.id_business')}
            LEFT JOIN login editor ON ${eq('editor.id_login', 'tp.updated_by')} AND ${eq('editor.id_business', 'tp.id_business')}
            LEFT JOIN login closer ON ${eq('closer.id_login', 'tp.closed_by')} AND ${eq('closer.id_business', 'tp.id_business')}
            WHERE ${eq('tp.id_business', ':business')} AND ${eq('tp.id_person', ':patient')} AND tp.active = 1
            ORDER BY tp.created_at DESC${lock ? ' FOR UPDATE' : ''}`, this.keys(body), transaction);
    }
    async items(body, transaction = null) {
        const rows = await this.query(`SELECT pt.* FROM patient_treatment pt WHERE ${eq('pt.id_business', ':business')}
            AND ${eq('pt.id_person', ':patient')} AND pt.active = 1 ORDER BY pt.created_at DESC`, this.keys(body), transaction);
        const teeth = await this.query(`SELECT ptt.id_patient_treatment, ptt.tooth_number FROM patient_treatment_tooth ptt
            INNER JOIN patient_treatment pt ON pt.id_patient_treatment = ptt.id_patient_treatment AND pt.id_business = ptt.id_business
            WHERE ${eq('pt.id_business', ':business')} AND ${eq('pt.id_person', ':patient')} AND pt.active = 1`, this.keys(body), transaction);
        const byItem = {};
        for (const tooth of teeth) (byItem[tooth.id_patient_treatment] ||= []).push(String(tooth.tooth_number));
        return rows.map(row => ({ ...row, teeth: (byItem[row.id_patient_treatment] || []).sort() }));
    }
    visibleConsent(consent, permissions) {
        if (!consent) return null;
        const result = { ...consent, plan_snapshot: consent.plan_snapshot ? JSON.parse(JSON.stringify(consent.plan_snapshot)) : null };
        if (!permissions.costView && result.plan_snapshot) {
            for (const item of result.plan_snapshot.treatments || []) delete item.cost;
        }
        return result;
    }
    async getPlan(body) {
        try {
            const context = await this.context(body, 'view');
            if (context.error) return context.error;
            const { permissions, patient } = context;
            const config = await this.configuration(body);
            const plans = await this.plans(body);
            const items = await this.items(body);
            const prepared = permissions.consentView || permissions.consentSign ? await consentDocuments.documentsForPatient(body, null, permissions.consentView) : { available: true, documents: [] };
            if (!permissions.costView) for (const document of prepared.documents.filter(document => document.includes_costs)) { delete document.content_html_snapshot; delete document.signed_content_html_snapshot; delete document.pdf_url; }
            let consents = [], versions = [], versioningAvailable = true;
            // No restricted signatures or costs are sent to a role lacking these permissions.
            if (permissions.consentView) {
                consents = await this.query(`SELECT * FROM treatment_plan_consent WHERE ${eq('id_business', ':business')}
                    AND ${eq('id_person', ':patient')} AND active = 1`, this.keys(body));
            }
            try {
                versions = await this.query(`SELECT ${permissions.consentView ? '*' : 'id_consent_version'} FROM treatment_plan_consent_version
                    WHERE ${eq('id_business', ':business')} AND ${eq('id_person', ':patient')} ORDER BY revision DESC`, this.keys(body));
            } catch (error) {
                if (!missingTable(error)) throw error;
                versioningAvailable = false;
            }
            const enriched = plans.map(plan => {
                const planVersions = permissions.consentView ? versions.filter(version => version.id_treatment_plan === plan.id_treatment_plan).map(version => this.visibleConsent({
                    ...parse(version.consent_snapshot_json), id_consent_version: version.id_consent_version, revision: version.revision,
                    plan_snapshot: version.plan_snapshot_json ? parse(version.plan_snapshot_json) : null
                }, permissions)) : [];
                const related = items.filter(item => item.id_treatment_plan === plan.id_treatment_plan);
                return { ...plan, review_token: this.reviewToken({ ...plan, treatments: related }), treatments: related.map(item => {
                    const safe = { ...item };
                    if (!permissions.costView) delete safe.cost;
                    return safe;
                }), consent: planVersions[0] || (permissions.consentView ? consents.find(consent => consent.id_treatment_plan === plan.id_treatment_plan) || null : null), consent_versions: planVersions,
                consent_document: prepared.documents.find(document => document.treatment_plan_id === plan.id_treatment_plan && document.status !== 'CANCELADO') || null };
            });
            return response.success({ patient, permissions, config: { ...config, consentVersioningAvailable: versioningAvailable, consentDocumentAvailable: prepared.available }, activePlan: enriched.find(plan => plan.status === 'active') || null, history: enriched.filter(plan => plan.status !== 'active') }, 'Plan de tratamiento consultado.');
        } catch (error) { return SequelizeException(error, 'No se pudo consultar el plan de tratamiento.'); }
    }
    async signingDoctors(body) {
        try {
            const context = await this.context(body, 'consentPrepare');
            if (context.error) return context.error;
            const rows = await this.query(`SELECT dpp.id_login, dpp.id_doctor_professional_profile, dpp.professional_name, dpp.professional_license, dpp.signature_image,
                dpp.is_active AS professional_profile_active, dpp.can_sign_documents
                FROM doctor_professional_profile dpp INNER JOIN login l ON l.id_login = dpp.id_login AND l.id_business = dpp.id_business
                INNER JOIN rol r ON r.id_rol = l.id_rol
                WHERE ${eq('dpp.id_business', ':business')} AND l.active = 1 AND dpp.is_active = 1 AND dpp.can_sign_documents = 1
                AND r.code IN ('doctor', 'admin', 'business_admin') ORDER BY dpp.professional_name`, this.keys(body));
            const templates = await this.query(`SELECT dt.id_document_template, dt.template_type, dt.is_active, dtv.content_html
                FROM document_templates dt INNER JOIN document_template_versions dtv ON dtv.id_document_template = dt.id_document_template AND dtv.is_current = 1
                WHERE ${eq('dt.id_business', ':business')} AND dt.template_type = 'TREATMENT_PLAN_CONSENT' AND dt.active = 1 AND dt.is_active = 1
                ORDER BY dt.created_at DESC LIMIT 1`, this.keys(body));
            const legacy = templates.length ? [] : await this.query(`SELECT state, consent FROM signature_consent WHERE ${eq('id_business', ':business')} AND active = 1 ORDER BY created_at DESC LIMIT 1`, this.keys(body));
            return response.success({ doctors: rows, template: templates[0] || null, legacyText: legacy[0] || {} }, 'Contexto del consentimiento disponible.');
        } catch (error) { return SequelizeException(error, 'No se pudieron consultar los doctores.'); }
    }
    async mutation(body, flag, work) {
        let transaction;
        try {
            const context = await this.context(body, flag);
            if (context.error) return context.error;
            transaction = await sequelize.transaction();
            // All writes for the same patient serialize with create/close/sign and use one connection.
            await this.query(`SELECT id_person FROM person WHERE ${eq('id_person', ':patient')} AND ${eq('id_business', ':business')} FOR UPDATE`, this.keys(body), transaction);
            const result = await work(transaction, context);
            if (result && result.status >= 400) { await transaction.rollback(); return result; }
            if (!['consentSign', 'consentPrepare'].includes(flag)) await consentDocuments.invalidateStale(body, transaction);
            await transaction.commit();
            transaction = null;
            if (!context.permissions.view) return response.success({ id_person: body.id_person, persisted: true }, 'Cambios guardados.');
            const refreshed = await this.getPlan(body);
            // A failed refresh must not turn a committed mutation into a reported failed save.
            return refreshed.status === 200 ? refreshed : response.success({ id_person: body.id_person, persisted: true, refreshRequired: true }, 'Cambios guardados. Reintenta la consulta del plan.');
        } catch (error) {
            if (transaction) await transaction.rollback();
            if (missingTable(error)) return response.bad_request('Falta habilitar el historial de versiones. No se guardaron ni reemplazaron datos.');
            return SequelizeException(error, 'No se pudieron guardar los cambios del plan.');
        }
    }
    async active(body, transaction) {
        const rows = await this.query(`SELECT * FROM treatment_plan WHERE ${eq('id_business', ':business')} AND ${eq('id_person', ':patient')}
            AND ${eq('id_treatment_plan', ':plan')} AND status = 'active' AND active = 1 FOR UPDATE`, this.keys(body), transaction);
        return rows[0];
    }
    createPlan(body) {
        const errors = validatePlan(body);
        if (Object.keys(errors).length) return Promise.resolve(response.bad_request(Object.values(errors)[0], { errors }));
        return this.mutation(body, 'create', async transaction => {
            const existing = (await this.plans(body, transaction)).find(plan => plan.status === 'active');
            if (existing) {
                if (body.request_id === existing.id_treatment_plan) return;
                return response.bad_request('Ya existe un plan activo. Cierra el actual antes de crear otro.');
            }
            await this.query(`INSERT INTO treatment_plan (id_treatment_plan, id_business, id_person, title, diagnosis, notes, status, started_at, active, created_at, created_by)
                VALUES (:id, :business, :patient, :title, :diagnosis, :notes, 'active', :started_at, 1, NOW(), :actor)`, {
                ...this.keys(body), id: /^[a-zA-Z0-9-]{1,50}$/.test(body.request_id || '') ? body.request_id : uuidv4(), title: body.title.trim(), diagnosis: body.diagnosis || null, notes: body.notes || null, started_at: body.started_at || null
            }, transaction, QueryTypes.INSERT);
        });
    }
    updatePlan(body) {
        const errors = validatePlan(body);
        if (Object.keys(errors).length) return Promise.resolve(response.bad_request(Object.values(errors)[0], { errors }));
        return this.mutation(body, 'edit', async transaction => {
            const current = await this.active(body, transaction);
            if (!current) return response.bad_request('Solo se pueden editar los datos del plan activo.');
            const updated = { title: body.title.trim(), diagnosis: body.diagnosis || null, notes: body.notes || null, started_at: body.started_at || null };
            await this.query(`INSERT INTO treatment_plan_audit (id_plan_audit, id_business, id_person, id_treatment_plan, previous_snapshot_json, new_snapshot_json, created_at, created_by)
                VALUES (:id, :business, :patient, :plan, :previous, :next, NOW(), :actor)`, { ...this.keys(body), id: uuidv4(), previous: JSON.stringify(current), next: JSON.stringify(updated) }, transaction, QueryTypes.INSERT);
            await this.query(`UPDATE treatment_plan SET title = :title, diagnosis = :diagnosis, notes = :notes, started_at = :started_at, updated_at = NOW(), updated_by = :actor
                WHERE ${eq('id_treatment_plan', ':plan')} AND ${eq('id_business', ':business')} AND ${eq('id_person', ':patient')} AND status = 'active'`, { ...this.keys(body), ...updated }, transaction, QueryTypes.UPDATE);
        });
    }
    closePlan(body) {
        return this.mutation(body, 'closePlan', async transaction => {
            if (!await this.active(body, transaction)) {
                const closed = await this.query(`SELECT id_treatment_plan FROM treatment_plan WHERE ${eq('id_treatment_plan', ':plan')}
                    AND ${eq('id_business', ':business')} AND ${eq('id_person', ':patient')} AND active = 1 AND status = 'closed'`, this.keys(body), transaction);
                if (closed[0]) return; // Retry preserves the first close reason and actor.
                return response.bad_request('Este plan ya no está activo. Reintenta la consulta.');
            }
            await this.query(`UPDATE treatment_plan SET status = 'closed', closed_at = NOW(), closed_by = :actor, close_reason = :reason, updated_at = NOW(), updated_by = :actor
                WHERE ${eq('id_treatment_plan', ':plan')} AND ${eq('id_business', ':business')} AND ${eq('id_person', ':patient')} AND status = 'active'`, { ...this.keys(body), reason: body.close_reason || null }, transaction, QueryTypes.UPDATE);
        });
    }
    savePlanTreatment(body) {
        const errors = validateTreatment(body);
        if (Object.keys(errors).length) return Promise.resolve(response.bad_request(Object.values(errors)[0], { errors }));
        return this.mutation(body, body.id_patient_treatment ? 'edit' : 'create', async (transaction, context) => {
            if (!await this.active(body, transaction)) return response.bad_request('Solo se pueden guardar tratamientos en un plan activo.');
            const isUpdate = Boolean(body.id_patient_treatment);
            const id = isUpdate ? body.id_patient_treatment : (/^[a-zA-Z0-9-]{1,50}$/.test(body.request_id || '') ? body.request_id : uuidv4());
            const existing = await this.query(`SELECT * FROM patient_treatment WHERE ${eq('id_patient_treatment', ':id')} AND ${eq('id_business', ':business')}
                AND ${eq('id_person', ':patient')} AND ${eq('id_treatment_plan', ':plan')} AND active = 1 FOR UPDATE`, { ...this.keys(body), id }, transaction);
            if (isUpdate && !existing[0]) return response.bad_request('El tratamiento ya no está disponible en este plan.');
            if (!isUpdate && existing[0]) return; // Retry of a committed create.
            if (body.cost !== undefined && !context.permissions.costEdit && Number(body.cost || 0) !== Number(existing[0] && existing[0].cost || 0)) return response.forbidden('No tienes permiso para modificar costos.');
            const values = { ...this.keys(body), id, name: body.name.trim(), description: body.description || null, category: body.category || null,
                status: isUpdate ? body.status || existing[0].status : 'pending', start: body.estimated_start_date || null, end: body.estimated_end_date || null,
                cost: context.permissions.costEdit && body.cost !== undefined ? (body.cost === '' || body.cost === null ? null : body.cost) : (existing[0] ? existing[0].cost : null), notes: body.notes || null };
            if (isUpdate) {
                await this.query(`UPDATE patient_treatment SET name=:name, description=:description, category=:category, status=:status, estimated_start_date=:start,
                    estimated_end_date=:end, cost=:cost, notes=:notes, updated_at=NOW(), updated_by=:actor WHERE ${eq('id_patient_treatment', ':id')} AND ${eq('id_business', ':business')}
                    AND ${eq('id_person', ':patient')} AND ${eq('id_treatment_plan', ':plan')}`, values, transaction, QueryTypes.UPDATE);
            } else {
                await this.query(`INSERT INTO patient_treatment (id_patient_treatment, id_business, id_person, id_treatment_plan, name, description, category, status, estimated_start_date, estimated_end_date, cost, notes, source, active, created_at, created_by)
                    VALUES (:id, :business, :patient, :plan, :name, :description, :category, :status, :start, :end, :cost, :notes, 'manual', 1, NOW(), :actor)`, values, transaction, QueryTypes.INSERT);
            }
            await this.query(`DELETE FROM patient_treatment_tooth WHERE ${eq('id_business', ':business')} AND ${eq('id_patient_treatment', ':id')}`, values, transaction, QueryTypes.DELETE);
            for (const tooth of [...new Set((body.teeth || []).map(String))]) await this.query(`INSERT INTO patient_treatment_tooth (id_patient_treatment_tooth, id_business, id_patient_treatment, tooth_number, created_at)
                VALUES (:toothId, :business, :id, :tooth, NOW())`, { ...values, toothId: uuidv4(), tooth }, transaction, QueryTypes.INSERT);
        });
    }
    async itemMutation(body, deleting = false) {
        if (!deleting && !STATUSES.includes(body.status)) return response.bad_request('Selecciona un estado válido.');
        const permissions = await this.permissions(body.id_login);
        const flag = deleting || !['completed', 'cancelled'].includes(body.status) ? 'edit' : (permissions.edit ? 'edit' : body.status === 'completed' ? 'complete' : 'cancel');
        return this.mutation(body, flag, async transaction => {
            const rows = await this.query(`SELECT pt.id_treatment_plan FROM patient_treatment pt
                INNER JOIN treatment_plan tp ON tp.id_treatment_plan = pt.id_treatment_plan AND tp.id_business = pt.id_business AND tp.id_person = pt.id_person
                WHERE ${eq('pt.id_business', ':business')} AND ${eq('pt.id_person', ':patient')} AND ${eq('pt.id_patient_treatment', ':item')}
                AND pt.active = 1 AND tp.active = 1 AND tp.status = 'active' FOR UPDATE`, this.keys(body), transaction);
            if (!rows[0]) return response.bad_request('Solo se pueden modificar tratamientos del plan activo.');
            await this.query(`UPDATE patient_treatment SET ${deleting ? 'active = 0' : 'status = :status'}, updated_at = NOW(), updated_by = :actor
                WHERE ${eq('id_patient_treatment', ':item')} AND ${eq('id_business', ':business')} AND ${eq('id_person', ':patient')}`, { ...this.keys(body), status: body.status || null }, transaction, QueryTypes.UPDATE);
        });
    }
    updatePlanTreatmentStatus(body) { return this.itemMutation(body); }
    deletePlanTreatment(body) { return this.itemMutation(body, true); }
    prepareConsentDocument(body) {
        return this.mutation(body, 'consentPrepare', async (transaction, context) => {
            const plan = await this.active(body, transaction);
            if (!plan) return response.bad_request('Solo se puede preparar el consentimiento de un plan activo.');
            const doctor = await prescriptionDao.getDoctor(body.doctor_user_id, body.id_business, transaction);
            if (!doctor || !doctor.id_doctor_professional_profile || doctor.professional_profile_active === 0 || !doctor.can_sign_documents || !doctor.professional_name || !doctor.professional_license) return response.bad_request('Selecciona un doctor con perfil activo, cédula y autorización de firma.');
            const snapshot = { ...plan, patient: context.patient, treatments: (await this.items(body, transaction)).filter(item => item.id_treatment_plan === plan.id_treatment_plan) };
            if (body.review_token !== this.reviewToken(snapshot)) return response.bad_request('El plan cambió. Reintenta la consulta antes de preparar el consentimiento.');
            await consentDocuments.invalidateStale(body, transaction);
            const config = await this.configuration(body, transaction);
            const includesCosts = Boolean(context.permissions.costView && config.showTreatmentCosts);
            const existing = (await consentDocuments.documentsForPatient(body, transaction)).documents.find(document => document.treatment_plan_id === plan.id_treatment_plan
                && document.responsible_doctor_user_id === doctor.id_login && document.includes_costs === includesCosts && ['BORRADOR', 'PENDIENTE_FIRMA'].includes(document.status));
            if (existing) return;
            const template = (await this.query(`SELECT dt.*, dtv.content_html, dtv.id_document_template_version, dtv.version_number FROM document_templates dt
                INNER JOIN document_template_versions dtv ON dtv.id_document_template = dt.id_document_template AND dtv.is_current = 1
                WHERE ${eq('dt.id_business', ':business')} AND dt.template_type = 'TREATMENT_PLAN_CONSENT' AND dt.active = 1 AND dt.is_active = 1 ORDER BY dt.created_at DESC LIMIT 1`, this.keys(body), transaction))[0];
            const legacy = template ? {} : (await this.query(`SELECT state, consent FROM signature_consent WHERE ${eq('id_business', ':business')} AND active = 1 ORDER BY created_at DESC LIMIT 1`, this.keys(body), transaction))[0] || {};
            const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
            const patientName = `${context.patient.name || ''} ${context.patient.surname || ''}`.trim();
            const business = (await this.query(`SELECT name, legal_name FROM business WHERE ${eq('id_business', ':business')} LIMIT 1`, this.keys(body), transaction))[0] || {};
            const variables = { nombrePaciente: patientName, edadPaciente: context.patient.age, fechaNacimientoPaciente: context.patient.birthday,
                nombreDoctor: doctor.professional_name, cedulaDoctor: doctor.professional_license, nombreConsultorio: business.legal_name || business.name,
                nombreBusiness: business.name, fechaActual: new Date().toISOString().slice(0, 10), diagnostico: plan.diagnosis || '', planTratamiento: snapshot.treatments.map(item => item.name).join(', ') };
            const declare = template ? String(template.content_html || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => escape(variables[key])) : escape(legacy.state || '').replace(/\n/g, '<br>');
            const text = template ? '' : escape(legacy.consent || '').replace(/\n/g, '<br>');
            if (!declare.trim() && !text.trim()) return response.bad_request('Configura el texto del consentimiento antes de preparar la firma.');
            const requirements = {
                requires_patient_signature: template ? Number(template.requires_patient_signature !== 0) : 1,
                requires_tutor_signature: template ? Number(template.requires_tutor_signature === 1) : 0,
                requires_doctor_signature: template ? Number(template.requires_doctor_signature !== 0) : 1,
                requires_witness1_signature: template ? Number(template.requires_witness1_signature === 1) : 0,
                requires_witness2_signature: template ? Number(template.requires_witness2_signature === 1) : 0
            };
            if (!requirements.requires_patient_signature && !requirements.requires_tutor_signature) return response.bad_request('El formato del plan debe solicitar firma del paciente o tutor. Revisa su configuración.');
            if (requirements.requires_doctor_signature && !doctor.signature_image) return response.bad_request('Este formato requiere la firma profesional del doctor. Complétala en su perfil antes de preparar el documento.');
            const labels = { pending: 'Pendiente', in_progress: 'En progreso', paused: 'Pausado', completed: 'Completado', cancelled: 'Cancelado' };
            const rows = snapshot.treatments.map(item => `<li><strong>${escape(item.name)}</strong>${item.description ? `<p>${escape(item.description)}</p>` : ''}<p>Estado: ${escape(labels[item.status] || item.status)}${includesCosts && item.cost !== null && item.cost !== undefined ? ` · Costo estimado: $${Number(item.cost).toFixed(2)}` : ''}${item.teeth.length ? ` · Dientes: ${escape(item.teeth.join(', '))}` : ''}</p></li>`).join('');
            const html = `<h2>Consentimiento del plan de tratamiento</h2><p>Paciente: ${escape(patientName)}</p><p>Doctor: ${escape(doctor.professional_name)} · Cédula: ${escape(doctor.professional_license)}</p>${declare}${text ? `<section>${text}</section>` : ''}<h3>${escape(plan.title)}</h3>${plan.diagnosis ? `<p>Diagnóstico: ${escape(plan.diagnosis)}</p>` : ''}<ul>${rows || '<li>Sin tratamientos registrados.</li>'}</ul>`;
            const id = uuidv4();
            const values = { ...this.keys(body), id, title: String(`Consentimiento: ${plan.title}`).slice(0, 255), html, doctorId: doctor.id_login, profileId: doctor.id_doctor_professional_profile,
                doctorName: doctor.professional_name, license: doctor.professional_license, signature: doctor.signature_image || null, templateId: template ? template.id_document_template : null,
                templateVersion: template ? template.id_document_template_version : null, versionNumber: template ? template.version_number : null };
            await this.query(`INSERT INTO patient_documents (id_patient_document, id_business, id_person, id_document_template, id_document_template_version, template_version_number,
                document_type, origin, status, title, content_html_snapshot, responsible_doctor_user_id, responsible_doctor_profile_id, doctor_name_snapshot,
                professional_license_snapshot, doctor_signature_snapshot, treatment_plan_id, created_at, created_by, issued_by_user_id, active)
                VALUES (:id, :business, :patient, :templateId, :templateVersion, :versionNumber, 'TREATMENT_PLAN_CONSENT', 'TREATMENT_PLAN', 'PENDIENTE_FIRMA', :title, :html,
                :doctorId, :profileId, :doctorName, :license, :signature, :plan, NOW(), :actor, :actor, 1)`, values, transaction, QueryTypes.INSERT);
            const frozen = { declare_text_snapshot: declare, consent_text_snapshot: text, doctor_signature_snapshot: values.signature, doctor_name_snapshot: values.doctorName,
                professional_license_snapshot: values.license, responsible_doctor_user_id: doctor.id_login, responsible_doctor_profile_id: doctor.id_doctor_professional_profile, includes_costs: includesCosts, signature_requirements: requirements };
            await this.query(`INSERT INTO treatment_plan_consent_document (id_patient_document, id_business, id_person, id_treatment_plan, doctor_user_id, content_fingerprint, plan_snapshot_json, consent_snapshot_json, prepared_at, prepared_by)
                VALUES (:id, :business, :patient, :plan, :doctorId, :fingerprint, :snapshot, :consent, NOW(6), :actor)`, { ...values, fingerprint: consentDocuments.fingerprint(snapshot), snapshot: JSON.stringify(snapshot), consent: JSON.stringify(frozen) }, transaction, QueryTypes.INSERT);
            await this.query(`INSERT INTO patient_document_events (id_patient_document_event, id_patient_document, id_business, event_type, notes, created_at, created_by)
                VALUES (:event, :id, :business, 'CREATED', 'Consentimiento preparado desde el plan de tratamiento.', NOW(), :actor)`, { ...values, event: uuidv4() }, transaction, QueryTypes.INSERT);
        });
    }
    signPreparedConsent(body) {
        const validation = require('../../validators/treatment.validator').validateSignPreparedConsent({ body });
        if (!validation.isValid) return Promise.resolve(response.bad_request(validation.message));
        return this.mutation(body, 'consentSign', async transaction => {
            let document = (await this.query(`SELECT * FROM patient_documents WHERE ${eq('id_patient_document', ':document')} AND ${eq('id_business', ':business')}
                AND ${eq('id_person', ':patient')} AND origin='TREATMENT_PLAN' AND active=1 FOR UPDATE`, { ...this.keys(body), document: body.id_patient_document }, transaction))[0];
            if (!document) return response.bad_request('Documento del plan no disponible.');
            if (document.status === 'FIRMADO') return;
            if (!['BORRADOR', 'PENDIENTE_FIRMA'].includes(document.status) || !await consentDocuments.assertCurrent(document, transaction)) return response.bad_request('Este consentimiento ya no está vigente. Consulta el plan y prepara una nueva versión.');
            document = await consentDocuments.decorate(document, transaction);
            const required = [];
            if (document.requires_tutor_signature) required.push('TUTOR'); else if (document.requires_patient_signature) required.push('PATIENT');
            if (document.requires_doctor_signature) required.push('DOCTOR');
            if (document.requires_witness1_signature) required.push('WITNESS1');
            if (document.requires_witness2_signature) required.push('WITNESS2');
            const signatures = await this.query(`SELECT signature_role, signer_name_snapshot, signature_image, signed_at FROM patient_document_signatures
                WHERE ${eq('id_patient_document', ':document')} AND ${eq('id_business', ':business')} FOR UPDATE`, { ...this.keys(body), document: document.id_patient_document }, transaction);
            const completed = new Set(signatures.map(signature => signature.signature_role));
            if (document.doctor_signature_snapshot) completed.add('DOCTOR');
            const role = body.signature_role || 'PATIENT';
            if (!required.includes(role)) return response.bad_request('Esta firma no forma parte del documento preparado.');
            if (completed.has(role)) return; // Retry of a committed capture.
            if (role !== 'PATIENT' && !String(body.signer_name || '').trim()) return response.bad_request('Escribe el nombre de la persona que firma.');
            await this.query(`INSERT INTO patient_document_signatures (id_patient_document_signature, id_patient_document, id_business, signature_role, signer_name_snapshot, signature_image, signed_at, signed_by_user_id, created_at, created_by)
                VALUES (:id, :document, :business, :role, :name, :signature, NOW(), :actor, NOW(), :actor)`, { ...this.keys(body), id: uuidv4(), document: document.id_patient_document,
                role, name: body.signer_name || null, signature: body.patient_signature }, transaction, QueryTypes.INSERT);
            completed.add(role);
            const status = required.every(value => completed.has(value)) ? 'FIRMADO' : 'PENDIENTE_FIRMA';
            await this.query(`UPDATE patient_documents SET status=:status, signed_content_html_snapshot=CASE WHEN :status='FIRMADO' THEN content_html_snapshot ELSE signed_content_html_snapshot END,
                signed_at=CASE WHEN :status='FIRMADO' THEN NOW() ELSE signed_at END, signed_by_user_id=:actor, updated_at=NOW(), updated_by=:actor
                WHERE ${eq('id_patient_document', ':document')} AND ${eq('id_business', ':business')}`, { ...this.keys(body), document: document.id_patient_document, status }, transaction, QueryTypes.UPDATE);
            await consentDocuments.syncSigned({ ...document, status, signed_at: new Date().toISOString() }, transaction, body.id_login);
            await this.query(`UPDATE document_signature_requests SET status='revoked', revoked_at=NOW(), revoked_by=:actor, updated_at=NOW()
                WHERE ${eq('id_business', ':business')} AND ${eq('id_patient_document', ':document')} AND signature_role=:role AND status IN ('pending','opened')`, { ...this.keys(body), document: document.id_patient_document, role }, transaction, QueryTypes.UPDATE);
            await this.query(`INSERT INTO patient_document_events (id_patient_document_event, id_patient_document, id_business, event_type, notes, created_at, created_by)
                VALUES (:event, :document, :business, :eventType, 'Firma presencial capturada desde Tratamiento.', NOW(), :actor)`, { ...this.keys(body), document: document.id_patient_document, event: uuidv4(), eventType: status === 'FIRMADO' ? 'SIGNED' : 'SIGNATURE_CAPTURED' }, transaction, QueryTypes.INSERT);
        });
    }
    savePlanConsent(body) {
        return this.mutation(body, 'consentSign', async (transaction, context) => {
            const plan = await this.active(body, transaction);
            if (!plan) return response.bad_request('Solo se puede firmar el consentimiento del plan activo.');
            const keys = this.keys(body);
            const versions = await this.query(`SELECT * FROM treatment_plan_consent_version WHERE ${eq('id_business', ':business')}
                AND ${eq('id_treatment_plan', ':plan')} ORDER BY revision DESC FOR UPDATE`, keys, transaction);
            if (versions.some(version => version.request_id === body.request_id)) return;
            const doctor = await prescriptionDao.getDoctor(body.doctor_user_id, body.id_business, transaction);
            if (!doctor || !doctor.id_doctor_professional_profile || doctor.professional_profile_active === 0 || !doctor.can_sign_documents || !doctor.professional_name || !doctor.professional_license) return response.bad_request('Selecciona un doctor del consultorio con perfil activo, cédula y permiso de firma.');
            const current = (await this.query(`SELECT * FROM treatment_plan_consent WHERE ${eq('id_business', ':business')} AND ${eq('id_treatment_plan', ':plan')} AND active = 1 FOR UPDATE`, keys, transaction))[0];
            let revision = versions[0] ? versions[0].revision : 0;
            const insertVersion = async (consent, snapshot, requestId) => {
                revision++;
                await this.query(`INSERT INTO treatment_plan_consent_version (id_consent_version, id_business, id_person, id_treatment_plan, revision, request_id, consent_snapshot_json, plan_snapshot_json, created_at, created_by)
                    VALUES (:id, :business, :patient, :plan, :revision, :request, :consent, :snapshot, NOW(), :actor)`, { ...keys, id: uuidv4(), revision, request: requestId, consent: JSON.stringify(consent), snapshot: snapshot ? JSON.stringify(snapshot) : null }, transaction, QueryTypes.INSERT);
            };
            // Legacy text/signatures are preserved, but a past plan snapshot cannot be reconstructed.
            if (current && !versions.length) await insertVersion(current, null, null);
            const snapshot = { ...plan, patient: context.patient, treatments: (await this.items(body, transaction)).filter(item => item.id_treatment_plan === plan.id_treatment_plan) };
            if (!body.review_token || body.review_token !== this.reviewToken(snapshot)) return response.bad_request('El plan cambió durante la captura. Consulta los cambios y vuelve a revisar el consentimiento antes de firmar.');
            const consent = { id_treatment_plan_consent: current ? current.id_treatment_plan_consent : uuidv4(), ...keys,
                declare_text_snapshot: body.declare_text_snapshot || null, consent_text_snapshot: body.consent_text_snapshot || null, patient_signature: body.patient_signature,
                doctor_signature_snapshot: doctor.signature_image || null, doctor_name_snapshot: doctor.professional_name, professional_license_snapshot: doctor.professional_license,
                responsible_doctor_user_id: doctor.id_login, responsible_doctor_profile_id: doctor.id_doctor_professional_profile, signed_by_user_id: body.id_login,
                signed_at: new Date().toISOString(), created_at: current ? current.created_at : new Date().toISOString() };
            await insertVersion(consent, snapshot, body.request_id);
            const values = { ...keys, id: consent.id_treatment_plan_consent, declare: consent.declare_text_snapshot, text: consent.consent_text_snapshot, patientSignature: consent.patient_signature,
                doctorSignature: consent.doctor_signature_snapshot, doctorName: consent.doctor_name_snapshot, license: consent.professional_license_snapshot, doctorId: doctor.id_login, profileId: doctor.id_doctor_professional_profile };
            if (current) await this.query(`UPDATE treatment_plan_consent SET declare_text_snapshot=:declare, consent_text_snapshot=:text, patient_signature=:patientSignature,
                doctor_signature_snapshot=:doctorSignature, doctor_name_snapshot=:doctorName, professional_license_snapshot=:license, responsible_doctor_user_id=:doctorId,
                responsible_doctor_profile_id=:profileId, signed_at=NOW(), signed_by_user_id=:actor, updated_at=NOW(), updated_by=:actor
                WHERE ${eq('id_treatment_plan_consent', ':id')} AND ${eq('id_business', ':business')} AND ${eq('id_treatment_plan', ':plan')}`, values, transaction, QueryTypes.UPDATE);
            else await this.query(`INSERT INTO treatment_plan_consent (id_treatment_plan_consent, id_business, id_person, id_treatment_plan, declare_text_snapshot, consent_text_snapshot,
                patient_signature, doctor_signature_snapshot, doctor_name_snapshot, professional_license_snapshot, responsible_doctor_user_id, responsible_doctor_profile_id, signed_at, signed_by_user_id, active, created_at, created_by)
                VALUES (:id, :business, :patient, :plan, :declare, :text, :patientSignature, :doctorSignature, :doctorName, :license, :doctorId, :profileId, NOW(), :actor, 1, NOW(), :actor)`, values, transaction, QueryTypes.INSERT);
        });
    }
}
module.exports = TreatmentPlanDao;
