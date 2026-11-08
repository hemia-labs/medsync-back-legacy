'use strict';

require('../../../config/env');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { validatedAwsRegion } = require('../../../config/aws/region');
const { logEmailError } = require('../emailErrorDiagnostics');
const { isEmailUrl } = require('../emailUrls');
const ROUTES = Object.freeze({
    'registration-contact-code': ['EMAIL_REGISTRATION_CODE_TEMPLATE', 'EMAIL_FROM_AUTH', 'EMAIL_CONFIGURATION_SET_AUTH'],
    'registration-welcome': ['EMAIL_REGISTRATION_WELCOME_TEMPLATE', 'EMAIL_FROM_AUTH', 'EMAIL_CONFIGURATION_SET_AUTH'],
    'password-reset-code': ['EMAIL_PASSWORD_RESET_TEMPLATE', 'EMAIL_FROM_AUTH', 'EMAIL_CONFIGURATION_SET_AUTH'],
    'password-change-code': ['EMAIL_PASSWORD_CHANGE_CODE_TEMPLATE', 'EMAIL_FROM_AUTH', 'EMAIL_CONFIGURATION_SET_AUTH'],
    'password-changed': ['EMAIL_PASSWORD_CHANGED_TEMPLATE', 'EMAIL_FROM_AUTH', 'EMAIL_CONFIGURATION_SET_AUTH'],
    'document-signature': ['EMAIL_DOCUMENT_SIGNATURE_TEMPLATE', 'EMAIL_FROM_NOTIFICATIONS', 'EMAIL_CONFIGURATION_SET_TRANSACTIONAL']
});
const EMAIL = /^[^\s@<>";,]+@[^\s@<>";,]+\.[^\s@<>";,]+$/;
const CONTROLS = /[\x00-\x1f\x7f]/;
function invalid(message, code = 'EMAIL_SES_CONFIG_INVALID') {
    const error = new Error(message); error.code = code; error.safe = true; return error;
}
function required(name) {
    const raw = String(process.env[name] || '');
    if (!raw.trim() || CONTROLS.test(raw)) throw invalid(`Revisa la configuración de ${name}.`);
    return raw.trim();
}
function emailAddress(value) { return typeof value === 'string' && value.length <= 254 && EMAIL.test(value) && !CONTROLS.test(value); }
function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function templateData(type, input = {}) {
    const variables = input || {};
    let data;
    if (type === 'password-changed') {
        const date = variables.changedAt ? new Date(variables.changedAt) : null;
        const recovery = variables.changeMethod === 'recovery';
        const settings = variables.changeMethod === 'settings';
        data = {
            accountEmail: variables.accountEmail || '',
            changedAtLabel: date && Number.isFinite(date.getTime())
                ? `${new Intl.DateTimeFormat('es-MX', {
                    timeZone: 'America/Mexico_City', day: '2-digit', month: 'short', year: 'numeric',
                    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
                }).format(date)} (Ciudad de México)` : '',
            changeOrigin: recovery ? 'Recuperación de contraseña' : settings ? 'Configuración de tu cuenta' : '',
            sessionNotice: recovery ? 'Todas las sesiones se cerraron. Inicia sesión con tu nueva contraseña.'
                : settings ? 'Las demás sesiones se cerraron. Tu sesión actual sigue abierta.' : '',
            supportUrl: emailAddress(variables.supportEmail) ? `mailto:${encodeURIComponent(variables.supportEmail)}` : ''
        };
    } else if (type === 'password-reset-code' || type === 'password-change-code' || type === 'registration-contact-code') {
        if (type === 'registration-contact-code' && !/^[0-9]{6}$/.test(variables.code || '')) {
            throw invalid('El codigo de verificacion debe tener seis digitos.', 'EMAIL_SES_MESSAGE_INVALID');
        }
        if (typeof variables.code !== 'string' || !variables.code.trim() || CONTROLS.test(variables.code)) {
            throw invalid('El código de verificación debe ser una cadena no vacía.', 'EMAIL_SES_MESSAGE_INVALID');
        }
        const ttl = Number(variables.ttlMinutes);
        const validTtl = Number.isFinite(ttl) && ttl > 0 ? ttl : 10;
        data = { code: variables.code, ttlMinutes: type === 'password-change-code' ? Math.min(validTtl, 10) : validTtl };
    } else if (type === 'registration-welcome') {
        const {firstName, clinicName, trialDurationLabel, trialEndsAtLabel, loginUrl} = variables;
        if (![firstName, clinicName, trialDurationLabel, trialEndsAtLabel, loginUrl].every(value => typeof value === 'string' && value.trim() && !CONTROLS.test(value))
            || !isEmailUrl(loginUrl, { allowLocalApp: true })) {
            throw invalid('Los datos del correo de bienvenida no son válidos.', 'EMAIL_SES_MESSAGE_INVALID');
        }
        data = {firstName, clinicName, trialDurationLabel, trialEndsAtLabel, loginUrl};
    } else {
        const text = (value, fallback = '') => String(value ?? '').trim() || fallback;
        data = {
            patientName: text(variables.patientName, 'paciente'),
            clinicName: text(variables.clinicName, 'Tu consultorio').replace(/[\r\n]+/g, ' '),
            clinicLogoUrl: text(variables.clinicLogoUrl),
            documentTitle: text(variables.documentTitle, 'Documento para firma'),
            doctorName: text(variables.doctorName),
            expiresAt: text(variables.expiresAt, 'la fecha indicada'),
            publicUrl: text(variables.publicUrl)
        };
        if (!isEmailUrl(data.publicUrl, { allowLocalApp: true })) throw invalid('El enlace de firma debe apuntar a una URL válida de MedSync.', 'EMAIL_SES_MESSAGE_INVALID');
        if (data.clinicLogoUrl && !isEmailUrl(data.clinicLogoUrl)) data.clinicLogoUrl = '';
    }
    return { ...data, html: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, escapeHtml(value)])) };
}
function config() {
    const region = required('AWS_REGION');
    try { validatedAwsRegion(region); } catch (_) { throw invalid('Revisa la configuración de AWS_REGION.'); }
    const credentials = { accessKeyId: required('AWS_ACCESS_KEY_ID'), secretAccessKey: required('AWS_SECRET_ACCESS_KEY') };
    if (process.env.AWS_SESSION_TOKEN) credentials.sessionToken = required('AWS_SESSION_TOKEN');
    const fromName = required('EMAIL_FROM_NAME');
    if (/[<>"\\]/.test(fromName)) throw invalid('Revisa la configuración de EMAIL_FROM_NAME.');
    const replyTo = required('EMAIL_REPLY_TO');
    if (!emailAddress(replyTo)) throw invalid('Revisa la configuración de EMAIL_REPLY_TO.');
    const routes = {};
    for (const [type, [templateKey, fromKey, setKey]] of Object.entries(ROUTES)) {
        // Optional new capability must not break existing transactional templates.
        if (['registration-contact-code','registration-welcome'].includes(type) && !process.env[templateKey]) continue;
        const template = templateKey ? required(templateKey) : null;
        const from = required(fromKey), configurationSet = required(setKey);
        if (template && !/^[A-Za-z0-9_-]{1,64}$/.test(template)) throw invalid(`Revisa la configuración de ${templateKey}.`);
        if (!emailAddress(from)) throw invalid(`Revisa la configuración de ${fromKey}.`);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(configurationSet)) throw invalid(`Revisa la configuración de ${setKey}.`);
        routes[type] = { template, from, configurationSet };
    }
    return { region, credentials, fromName, replyTo, routes };
}

class SesProvider {
    initialize() {
        if (!this.client) {
            this.config = config();
            this.client = new SESv2Client({
                region: this.config.region, credentials: this.config.credentials,
                // An accepted-but-lost response must not trigger a second delivery.
                maxAttempts: 1,
                requestHandler: { connectionTimeout: 5000, requestTimeout: 15000, throwOnRequestTimeout: true }
            });
        }
    }
    async send({ type, to, variables } = {}) {
        if (typeof type !== 'string' || !Object.hasOwn(ROUTES, type)) throw invalid('Selecciona un tipo de correo transaccional permitido.', 'EMAIL_SES_MESSAGE_INVALID');
        if (!emailAddress(to)) throw invalid('El destinatario del correo no es válido.', 'EMAIL_SES_MESSAGE_INVALID');
        const data = templateData(type, type === 'password-changed'
            ? { ...variables, accountEmail: to, supportEmail: required('EMAIL_REPLY_TO') } : variables);
        this.initialize();
        const route = this.config.routes[type];
        if (!route) throw invalid('La plantilla del correo no está configurada.', 'EMAIL_SES_CONFIG_INVALID');
        const content = { Template: { TemplateName: route.template, TemplateData: JSON.stringify(data) } };
        try {
            const result = await this.client.send(new SendEmailCommand({
                FromEmailAddress: `${this.config.fromName} <${route.from}>`,
                Destination: { ToAddresses: [to] }, ReplyToAddresses: [this.config.replyTo],
                ConfigurationSetName: route.configurationSet,
                Content: content
            }));
            if (!result || typeof result.MessageId !== 'string' || !result.MessageId.trim()) {
                return { success: false, provider: 'ses', code: 'EMAIL_SES_NOT_ACCEPTED', message: 'El servicio de correo no confirmó la aceptación del mensaje.' };
            }
            return { success: true, provider: 'ses', messageId: result.MessageId };
        } catch (error) {
            // SDK errors may contain addresses, token links or credential details.
            logEmailError(error, { provider: 'ses', type });
            return { success: false, provider: 'ses', code: 'EMAIL_SES_SEND_FAILED', message: 'No se pudo enviar el correo. Revisa el servicio de correo e intenta de nuevo.' };
        }
    }
}
module.exports = SesProvider;
