'use strict';

// Insert-only setup for one isolated Professional presentation account. The
// caller owns the single connection, transaction, password generation and log.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

// Valid synthetic PNG used by the S19 integration fixtures; no real signature.
const SYNTHETIC_SIGNATURE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=';
const CREATED_BY = 'PROFESSIONAL_PRESENTATION_SETUP';
const BCRYPT_HASH = /^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;
const CLINICAL_PERMISSION_PREFIXES = ['clinical_history.', 'clinical_history_template.', 'prescriptions.', 'documents.', 'treatments.', 'tracing.', 'odontogram.', 'px.'];
const ADMIN_EXPLICIT_PERMISSIONS = new Set(['admin.config', 'dashboard.operations', 'dashboard.clinical', 'dashboard.financial', 'dashboard.scope.all']);
const ASSISTANT_DENIED = new Set(['dashboard.clinical', 'dashboard.financial', 'dashboard.scope.all',
    'clinical_history.finalize', 'clinical_history.cancel', 'clinical_history_template.manage',
    'prescriptions.issue', 'prescriptions.cancel', 'prescriptions.config',
    'documents.sign', 'documents.cancel', 'documents.config', 'documents.template.manage',
    'treatments.consent.sign', 'treatments.config', 'treatments.cost_view', 'treatments.cost_edit']);

function dateValue(today) {
    const value = today instanceof Date ? today.toISOString().slice(0, 10) : String(today || '');
    assert.match(value, /^\d{4}-\d{2}-\d{2}$/, 'today must be YYYY-MM-DD');
    const date = new Date(`${value}T12:00:00Z`);
    assert.equal(date.toISOString().slice(0, 10), value, 'today must be a real calendar date');
    const end = new Date(date);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    return { start: `${value} 00:00:00`, end: `${end.toISOString().slice(0, 10)} 23:59:59` };
}

function assertIdentity(identity, idKey) {
    assert.ok(identity && typeof identity[idKey] === 'string' && identity[idKey].length <= 50 && identity[idKey], `Missing ${idKey}`);
    assert.ok(identity.name && identity.email, 'Every demo identity requires a name and email');
    assert.match(identity.email, /@[^@]+\.example$/i, 'Use reserved .example email domains');
}

async function setupTenant({ connection, business, doctor, assistant = null, today, passwordHash, assistantPasswordHash = null }) {
    assert.ok(connection && typeof connection.query === 'function', 'Caller must supply its transaction connection');
    assertIdentity(business, 'id');
    assertIdentity(doctor, 'id_login');
    assert.ok(doctor.id_doctor_professional_profile && doctor.id_doctor_professional_profile.length <= 50);
    assert.match(passwordHash || '', BCRYPT_HASH, 'Only a bcrypt hash is accepted');
    const includeAssistant = Boolean(assistant && assistantPasswordHash);
    if (includeAssistant) {
        assertIdentity(assistant, 'id_login');
        assert.notEqual(assistant.id_login, doctor.id_login);
        assert.notEqual(assistant.email.toLowerCase(), doctor.email.toLowerCase());
        assert.match(assistantPasswordHash, BCRYPT_HASH, 'Assistant requires its own bcrypt hash');
        assert.notEqual(assistantPasswordHash, passwordHash, 'Do not reuse the doctor password hash');
    }
    const period = dateValue(today);
    const [existingBusiness] = await connection.query('SELECT id_business FROM business WHERE id_business = ? OR slug = ?', [business.id, business.slug]);
    assert.equal(existingBusiness.length, 0, 'The presentation tenant already exists; do not overwrite it');
    const identities = includeAssistant ? [doctor, assistant] : [doctor];
    for (const identity of identities) {
        assert.match(identity.telephone || '', /^000\d{7}$/, 'A non-routable ten-digit phone is required by the login form');
        const [existingLogin] = await connection.query('SELECT id_login FROM login WHERE id_login = ? OR LOWER(email) = LOWER(?) OR telephone=?', [identity.id_login, identity.email,identity.telephone]);
        assert.equal(existingLogin.length, 0, 'The presentation login already exists; do not overwrite it');
    }
    const [roles] = await connection.query("SELECT id_rol,code FROM rol WHERE active = 1 AND code IN ('admin','business_admin','assistant')");
    const adminRole = roles.find(role => role.code === 'admin') || roles.find(role => role.code === 'business_admin');
    const assistantRole = roles.find(role => role.code === 'assistant');
    assert.ok(adminRole, 'An active tenant administrator role is required');
    if (includeAssistant) assert.ok(assistantRole, 'An active assistant role is required');
    const [permissions] = await connection.query('SELECT id_cat_permission,code FROM cat_permission WHERE active = 1 AND is_active = 1');
    for (const code of [...ADMIN_EXPLICIT_PERMISSIONS, 'clinical_history.view', 'prescriptions.issue', 'px.dates']) {
        assert.ok(permissions.some(permission => permission.code === code), `Required permission is not installed: ${code}`);
    }
    const [themes] = await connection.query("SELECT id_cat_ui_theme,code FROM cat_ui_theme WHERE active = 1 ORDER BY CASE WHEN code = 'medical-blue' THEN 0 ELSE 1 END,id_cat_ui_theme LIMIT 1");
    assert.ok(themes.length, 'An active application theme is required');

    await connection.query(`INSERT INTO business (id_business,name,legal_name,slug,email,phone,address,status,plan,active,subscription_status,
        current_period_starts_at,current_period_ends_at,created_at,created_by)
        VALUES (?,?,?,?,?,NULL,?,'active','pro',1,'active',?,?,NOW(),?)`,
    [business.id,business.name,business.name,business.slug,business.email,business.address,period.start,period.end,CREATED_BY]);
    await connection.query(`INSERT INTO login (id_login,id_business,id_rol,name,email,telephone,password,locked,active,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,0,1,NOW(),?)`, [doctor.id_login,business.id,adminRole.id_rol,doctor.name,doctor.email,doctor.telephone,passwordHash,CREATED_BY]);
    if (includeAssistant) {
        await connection.query(`INSERT INTO login (id_login,id_business,id_rol,name,email,telephone,password,locked,active,created_at,created_by)
            VALUES (?,?,?,?,?,?,?,0,1,NOW(),?)`, [assistant.id_login,business.id,assistantRole.id_rol,assistant.name,assistant.email,assistant.telephone,assistantPasswordHash,CREATED_BY]);
    }
    const profile = {
        id_doctor_professional_profile: doctor.id_doctor_professional_profile, id_login: doctor.id_login,
        professional_name: doctor.name, professional_license: '00000000', university: 'Universidad Metropolitana',
        specialty: 'Odontología general', signature_image: SYNTHETIC_SIGNATURE_PNG,
        can_issue_prescriptions: 1, can_sign_documents: 1, is_active: 1
    };
    await connection.query(`INSERT INTO doctor_professional_profile (id_doctor_professional_profile,id_business,id_login,professional_name,
        professional_license,university,specialty,signature_image,can_issue_prescriptions,can_sign_documents,is_active,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,1,1,1,NOW(),?)`, [profile.id_doctor_professional_profile,business.id,doctor.id_login,doctor.name,
        profile.professional_license,profile.university,profile.specialty,profile.signature_image,doctor.id_login]);

    // Snapshot the existing role defaults only for this tenant; never grant
    // platform permissions. KPI finances are explicitly granted to its owner.
    for (const [role, isOwner] of [[adminRole, true], ...(includeAssistant ? [[assistantRole, false]] : [])]) {
        const [defaults] = await connection.query('SELECT id_cat_permission FROM permission_rol WHERE id_rol = ? AND active = 1', [role.id_rol]);
        const inherited = new Set(defaults.map(row => row.id_cat_permission));
        const assignments = [];
        for (const permission of permissions) {
            const code = permission.code;
            const platformOnly = code.startsWith('super_admin') || code.startsWith('platform.');
            let enabled = !platformOnly && (inherited.has(permission.id_cat_permission) || (isOwner &&
                (ADMIN_EXPLICIT_PERMISSIONS.has(code) || CLINICAL_PERMISSION_PREFIXES.some(prefix => code.startsWith(prefix)))));
            if (!isOwner && (ASSISTANT_DENIED.has(code) || code.startsWith('admin.') || code.startsWith('clinical_history_template.') || code.startsWith('documents.template.'))) enabled = false;
            if (!isOwner && ['dashboard.operations','px.tab.treatment'].includes(code)) enabled = true;
            assignments.push([business.id,role.id_rol,permission.id_cat_permission,enabled ? 1 : 0,doctor.id_login]);
        }
        await connection.query('INSERT INTO business_role_permission (id_business,id_rol,id_cat_permission,active,updated_by) VALUES ?', [assignments]);
    }

    const configuration = { generalAgenda: randomUUID(), doctorAgenda: randomUUID(), prescription: randomUUID(), clinicalModules: randomUUID(), theme: randomUUID() };
    for (const [configId, profileId] of [[configuration.generalAgenda, null], [configuration.doctorAgenda, doctor.id_doctor_professional_profile]]) {
        await connection.query(`INSERT INTO appointment_config (id_appointment_config,id_business,doctor_profile_id,enabled,default_appointment_duration,timezone,active,created_at,created_by)
            VALUES (?,?,?,1,30,'America/Mexico_City',1,NOW(),?)`, [configId,business.id,profileId,doctor.id_login]);
        for (let day = 0; day <= 6; day++) {
            const dayId = randomUUID();
            await connection.query(`INSERT INTO appointment_working_day (id_appointment_working_day,id_business,id_appointment_config,day_of_week,enabled,created_at,created_by)
                VALUES (?,?,?,?,?,NOW(),?)`, [dayId,business.id,configId,day,day === 0 ? 0 : 1,doctor.id_login]);
            const ranges = day === 0 ? [] : day === 6 ? [['09:00:00','14:00:00']] : [['09:00:00','14:00:00'],['16:00:00','19:00:00']];
            for (const [start, end] of ranges) {
                await connection.query(`INSERT INTO appointment_time_range (id_appointment_time_range,id_business,id_appointment_working_day,start_time,end_time,created_at,created_by)
                    VALUES (?,?,?,?,?,NOW(),?)`, [randomUUID(),business.id,dayId,start,end,doctor.id_login]);
            }
        }
    }
    await connection.query(`INSERT INTO prescription_config (id_prescription_config,id_business,doctor_profile_id,doctor_name,professional_license,university,
        specialty,clinic_name,clinic_address,signature_image,clinic_phone,template_mode,show_specialty,show_university,show_footer_note,active,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,'0000000000','header',1,1,0,1,NOW(),?)`, [configuration.prescription,business.id,doctor.id_doctor_professional_profile,doctor.name,
        profile.professional_license,profile.university,profile.specialty,business.name,business.address,profile.signature_image,doctor.id_login]);
    await connection.query(`INSERT INTO clinical_module_config (id_clinical_module_config,id_business,odontogram_enabled,treatment_plan_enabled,
        allow_treatment_tooth_selection,show_treatment_costs,show_treatment_status,active,created_at,created_by)
        VALUES (?,?,1,1,1,1,1,1,NOW(),?)`, [configuration.clinicalModules,business.id,doctor.id_login]);
    await connection.query(`INSERT INTO ui_theme_configuration (id_ui_theme_configuration,id_business,id_cat_ui_theme,active,created_by,created_at)
        VALUES (?,?,?,1,?,NOW())`, [configuration.theme,business.id,themes[0].id_cat_ui_theme,doctor.id_login]);
    return { businessId: business.id, doctor: profile, assistantCreated: includeAssistant,
        doctorRoleId: adminRole.id_rol, assistantRoleId: includeAssistant ? assistantRole.id_rol : null,
        configuration, themeCode: themes[0].code, subscriptionEndsAt: period.end,
        summary: { plan: 'pro', activeProfessionals: 1, activeStaff: includeAssistant ? 1 : 0, createdBy: CREATED_BY } };
}

module.exports = { setupTenant, SYNTHETIC_SIGNATURE_PNG, CREATED_BY };
