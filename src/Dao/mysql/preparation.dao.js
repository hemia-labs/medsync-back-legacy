'use strict';
const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const { rows } = require('../../util/effectivePermissions');
const { preparationStatus } = require('../../util/preparationStatus');

const agenda = own => `EXISTS(SELECT 1 FROM appointment_config ac
    JOIN doctor_professional_profile ap ON ap.id_doctor_professional_profile=ac.doctor_profile_id AND ap.id_business=ac.id_business AND ap.is_active=1
    JOIN login al ON al.id_login=ap.id_login AND al.id_business=ap.id_business AND al.active=1
    JOIN appointment_working_day wd ON wd.id_appointment_config=ac.id_appointment_config AND wd.id_business=ac.id_business AND wd.enabled=1
    JOIN appointment_time_range tr ON tr.id_appointment_working_day=wd.id_appointment_working_day AND tr.id_business=ac.id_business AND tr.start_time<tr.end_time
    WHERE ac.id_business=b.id_business AND ac.active=1 AND ac.enabled=1 ${own ? 'AND ap.id_login=l.id_login' : ''}
      AND NOT EXISTS(SELECT 1 FROM appointment_config bc WHERE bc.id_business=b.id_business AND bc.doctor_profile_id IS NULL AND bc.active=1 AND bc.enabled=0))`;

class PreparationDao {
    async current(business, login) {
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
                CASE WHEN r.code IN ('admin','business_admin','doctor','dentist','odontologist','specialist','professional','medico','odontologo','especialista') THEN ${agenda(true)} ELSE ${agenda(false)} END AS agenda_ready,
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
            return responseData.success(preparationStatus(records[0], permissions), 'Preparación del consultorio consultada.');
        } catch (_) {
            return responseData.error('No se pudo revisar la preparación del consultorio. Intenta de nuevo.');
        }
    }
}
module.exports = new PreparationDao();
