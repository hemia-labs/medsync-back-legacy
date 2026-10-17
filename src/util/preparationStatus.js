'use strict';

const PROFESSIONAL_ROLES = ['admin','business_admin','doctor','dentist','odontologist','specialist','professional','medico','odontologo','especialista'];
const yes = value => value === true || value === 1 || value === '1';

// Readiness explains prerequisites; it never grants permission to perform an action.
function preparationStatus(state, permissions) {
    const codes = new Set(permissions);
    const admin = ['admin','business_admin'].includes(state.role);
    const ownProfile = PROFESSIONAL_ROLES.includes(state.role);
    const canConfigure = admin && codes.has('admin.config');
    const canManageUsers = admin && codes.has('admin.users');
    const steps = [];
    const add = (id, title, ready, detail, section, allowed) => steps.push({
        id, title, ready: Boolean(ready), detail,
        action: allowed ? { label: ready ? 'Revisar' : 'Completar', path: `/admin?section=${section}` } : null,
        help: allowed ? null : 'Solicita al administrador del consultorio que revise este pendiente.'
    });
    if (canConfigure) add('identity', 'Datos del consultorio', yes(state.business_ready),
        yes(state.business_ready) ? 'Nombre, teléfono y domicilio registrados.' : 'Confirma el nombre, teléfono y domicilio del consultorio.', 'identity', true);

    const profileReady = yes(state.profile_exists) && yes(state.profile_active) && yes(state.profile_name) && yes(state.profile_license) && yes(state.profile_signature);
    if (ownProfile) {
        const missing = [['profile_name','nombre profesional'],['profile_license','cédula profesional'],['profile_signature','firma']].filter(([key]) => !yes(state[key])).map(([,label]) => label);
        const detail = !yes(state.profile_exists) ? 'Aún no has creado tu perfil profesional. Completa nombre, cédula y firma.'
            : !yes(state.profile_active) ? 'Tu perfil profesional está inactivo; solicita su revisión al administrador.'
            : missing.length ? `Falta completar: ${missing.join(', ')}.` : 'Identidad y firma registradas. Las autorizaciones se revisan por separado.';
        add('profile', 'Tu perfil profesional', profileReady, detail, 'doctor-identity', true);
        if (codes.has('prescriptions.issue') || codes.has('documents.sign')) {
            const authorized = yes(state.profile_active) && (!codes.has('prescriptions.issue') || yes(state.can_issue)) && (!codes.has('documents.sign') || yes(state.can_sign));
            add('authorizations', 'Autorizaciones profesionales', authorized,
                authorized ? 'Autorizaciones del perfil registradas; cada operación valida sus requisitos.' : 'Revisa las autorizaciones para emitir recetas y firmar documentos. Completar tus datos no las concede automáticamente.', 'users', canManageUsers);
        }
    }
    const agendaProfileReady = yes(state.profile_exists) && yes(state.profile_active);
    if (codes.has('px.dates')) add('agenda', ownProfile ? 'Tu agenda de atención' : 'Agenda de atención', yes(state.agenda_ready),
        yes(state.agenda_ready) ? 'Hay horarios activos de atención.' : !yes(state.has_doctor) ? 'Primero se necesita un doctor con perfil activo; después configura sus horarios.' : 'Configura y activa los horarios del doctor. Los cierres generales no sustituyen su agenda.',
        ownProfile && !agendaProfileReady ? 'doctor-identity' : 'agenda', ownProfile);
    if (['documents.view','documents.create','documents.sign','documents.config','clinical_history.create','clinical_history.finalize'].some(code => codes.has(code))) add('consent', 'Consentimiento de datos personales sensibles', yes(state.consent_ready),
        yes(state.consent_ready) ? 'Existe un formato activo con versión vigente para generar documentos nuevos.' : 'Prepara y activa este formato antes de generar el consentimiento del paciente.', 'documents', codes.has('documents.config'));
    if (ownProfile && (codes.has('prescriptions.config') || codes.has('prescriptions.issue'))) add('prescriptions', 'Formato de tus recetas', yes(state.prescription_ready),
        yes(state.prescription_ready) ? 'Domicilio y teléfono del formato registrados.' : yes(state.prescription_shared) ? 'Hay un formato general anterior como referencia. Revísalo y guárdalo como formato de este doctor antes de emitir. Identidad y autorización se validan por separado.' : 'Revisa el domicilio y teléfono del formato de receta del doctor. Identidad y autorización se validan por separado.',
        yes(state.profile_exists) && yes(state.profile_active) ? 'prescriptions' : 'doctor-identity', codes.has('prescriptions.config'));
    return { steps, pending: steps.filter(step => !step.ready).length, completed: steps.filter(step => step.ready).length };
}

module.exports = { preparationStatus };
