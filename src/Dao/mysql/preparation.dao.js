'use strict';
const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const { rows } = require('../../util/effectivePermissions');
const { preparationStatus } = require('../../util/preparationStatus');
const { fromRows } = require('../../domain/appointments/preparation');
const PROFESSIONAL_ROLES = ['admin','business_admin','doctor','dentist','odontologist','specialist','professional','medico','odontologo','especialista'];

class PreparationDao {
    async current(business, login, options = {}) {
        if (!business || !login) return responseData.forbidden('No hay un consultorio activo para revisar su preparación.');
        try {
            const records = await sequelize.query(`SELECT r.code AS role,
                (LENGTH(TRIM(COALESCE(b.name,'')))>0 AND LENGTH(TRIM(COALESCE(b.phone,'')))>0 AND LENGTH(TRIM(COALESCE(b.address,'')))>0) AS business_ready,
                (d.id_doctor_professional_profile IS NOT NULL) AS profile_exists, d.is_active AS profile_active,
                LENGTH(TRIM(COALESCE(d.professional_name,'')))>0 AS profile_name,
                LENGTH(TRIM(COALESCE(d.professional_license,'')))>0 AS profile_license,
                LENGTH(TRIM(COALESCE(d.signature_image,'')))>0 AS profile_signature,
                d.can_issue_prescriptions AS can_issue, d.can_sign_documents AS can_sign,
                EXISTS(SELECT 1 FROM doctor_professional_profile p JOIN login pl ON pl.id_login=p.id_login AND pl.id_business=p.id_business AND pl.active=1 WHERE p.id_business=b.id_business AND p.is_active=1) AS has_doctor,
                0 AS agenda_ready,
                EXISTS(SELECT 1 FROM document_templates dt JOIN document_template_versions v ON v.id_document_template=dt.id_document_template AND v.is_current=1 AND v.status='ACTIVE'
                    WHERE dt.id_business=b.id_business AND dt.active=1 AND dt.is_active=1 AND dt.template_type='SENSITIVE_DATA_CONSENT' AND LENGTH(TRIM(COALESCE(v.content_html,'')))>0) AS consent_ready,
                EXISTS(SELECT 1 FROM prescription_config pc WHERE pc.id_business COLLATE utf8mb4_unicode_ci=b.id_business COLLATE utf8mb4_unicode_ci AND pc.active=1 AND pc.doctor_profile_id COLLATE utf8mb4_unicode_ci=d.id_doctor_professional_profile COLLATE utf8mb4_unicode_ci
                    AND LENGTH(TRIM(COALESCE(pc.clinic_address,'')))>0 AND LENGTH(TRIM(COALESCE(pc.clinic_phone,'')))>0) AS prescription_ready,
                EXISTS(SELECT 1 FROM prescription_config legacy WHERE legacy.id_business COLLATE utf8mb4_unicode_ci=b.id_business COLLATE utf8mb4_unicode_ci
                    AND legacy.active=1 AND legacy.doctor_profile_id IS NULL) AS prescription_shared
                FROM login l JOIN rol r ON r.id_rol=l.id_rol AND r.active=1
                JOIN business b ON b.id_business=l.id_business AND b.active=1
                LEFT JOIN doctor_professional_profile d ON d.id_business=l.id_business AND d.id_login=l.id_login
                WHERE l.id_login=:login AND l.id_business=:business AND l.active=1 AND r.code<>'super_admin' LIMIT 1`, {
                replacements: { business, login }, type: QueryTypes.SELECT
            });
            if (!records[0]) return responseData.forbidden('Tu sesión no tiene acceso a la preparación de este consultorio.');
            const permissions = (await rows(login, { enabledCatalog:true })).map(row => row.code);
            const professional = PROFESSIONAL_ROLES.includes(records[0].role);
            const admin = ['admin','business_admin'].includes(records[0].role) && permissions.includes('admin.config');
            const book = permissions.includes('px.dates') || permissions.includes('admin.config');
            const target = options.agenda ? options.doctorProfileId : undefined;
            if (options.agenda && !book && !permissions.includes('px.tab.monitoring')) return responseData.forbidden('No tienes acceso al estado de las agendas.');
            if (target !== undefined && (typeof target !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(target))) return responseData.bad_request('Selecciona una agenda válida.');
            let projections = [];
            if (permissions.includes('px.dates') || options.agenda) {
                // Both checklist and expanded guide use this persisted, read-only projection.
                // A professional's summary remains their own even when inspecting another doctor.
                const detail = await this.agendaRows(business, login, professional, target);
                const groups = new Map();
                for (const row of detail) {
                    if (!groups.has(row.owner_id)) groups.set(row.owner_id, []);
                    groups.get(row.owner_id).push(row);
                }
                projections = [...groups.entries()].map(([owner, entries]) => ({owner, value:fromRows(entries, {view:true, book, configureOwn:owner===login && professional && book, configureOthers:admin, configureClinic:admin})}));
                const own = projections.find(item=>item.owner===login);
                records[0].agenda_ready = professional ? !!(own && own.value.canBookDefaultDuration) : projections.some(item=>item.value.canBookDefaultDuration);
                if (professional && own) records[0].agenda_detail = (own.value.issues[0] || {}).message;
            }
            const status = preparationStatus(records[0], permissions);
            if (options.clinicalHistory) {
                // Resolve through the existing passive query, never current(), which records TEMPLATE_VIEWED.
                status.clinicalHistory = { state:'restricted' };
                if (permissions.includes('clinical_history_template.view')) {
                    const templates = require('./clinicalHistoryTemplate.dao');
                    const { template, source } = await templates.getCurrentTemplateForBusiness(business);
                    const schema = template && template.schema_json;
                    const usable = !!(schema && Array.isArray(schema.sections) && schema.sections.length &&
                        schema.sections.every(section => section && section.key && section.label && Array.isArray(section.fields)));
                    status.clinicalHistory = {
                        state:!template ? 'absent' : usable ? 'available' : 'incomplete', source,
                        templateId:template && template.id_clinical_history_template,
                        version:template && template.version_number
                    };
                }
            }
            if (options.agenda) {
                const selected = projections.find(item=>target ? item.value.subject===target : item.owner===login);
                if (!selected) return responseData.forbidden('Esta agenda no está disponible para tu consultorio.');
                status.agenda = {...selected.value, subjectIsOwn:selected.owner===login};
            }
            return responseData.success(status, 'Preparación del consultorio consultada.');
        } catch (_) {
            return responseData.error('No se pudo revisar la preparación del consultorio. Intenta de nuevo.');
        }
    }

    agendaRows(business, login, professional, target) {
        return sequelize.query(`SELECT d.id_doctor_professional_profile AS profile_id, l.id_login AS owner_id,
                    d.is_active AS profile_active, l.active AS user_active,
                    ac.id_appointment_config AS config_id, ac.enabled, ac.revision, ac.default_appointment_duration AS duration,
                    bc.id_appointment_config AS business_config_id, bc.enabled AS business_enabled, bc.revision AS business_revision, bc.timezone,
                    wd.id_appointment_working_day AS day_id, wd.day_of_week, wd.enabled AS day_enabled,
                    tr.id_appointment_time_range AS range_id, TIME_FORMAT(tr.start_time,'%H:%i') AS start_time, TIME_FORMAT(tr.end_time,'%H:%i') AS end_time
                    FROM login l LEFT JOIN doctor_professional_profile d ON d.id_login=l.id_login AND d.id_business=l.id_business
                    LEFT JOIN appointment_config ac ON ac.doctor_profile_id=d.id_doctor_professional_profile AND ac.id_business=l.id_business AND ac.active=1
                    LEFT JOIN appointment_config bc ON bc.id_business=l.id_business AND bc.doctor_profile_id IS NULL AND bc.active=1
                    LEFT JOIN appointment_working_day wd ON wd.id_appointment_config=ac.id_appointment_config AND wd.id_business=l.id_business
                    LEFT JOIN appointment_time_range tr ON tr.id_appointment_working_day=wd.id_appointment_working_day AND tr.id_business=l.id_business
                    WHERE l.id_business=:business AND ${professional ? `(l.id_login=:login${target ? ' OR d.id_doctor_professional_profile=:target' : ''})` : 'l.active=1'}
                    ORDER BY wd.day_of_week, tr.start_time`, {
                    replacements:{business, login, ...(target ? {target} : {})}, type:QueryTypes.SELECT
                });
    }
}
module.exports = new PreparationDao();
