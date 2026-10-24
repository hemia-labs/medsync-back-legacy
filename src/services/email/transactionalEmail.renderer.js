'use strict';

// Shared rendering for SMTP and transactional SES messages; other SES types use published templates.
const documentSignatureEmailTemplate = require('./templates/documentSignatureEmail.template');
const passwordChangeCodeEmailTemplate = require('./templates/passwordChangeCodeEmail.template');
const passwordChangedEmailTemplate = require('./templates/passwordChangedEmail.template');
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

module.exports = function renderTransactionalEmail(type, variables = {}) {
    if (type === 'registration-contact-code') {
        if (!/^[0-9]{6}$/.test(variables.code || '')) throw new Error('EMAIL_VERIFICATION_CODE_INVALID');
        return {
            subject: 'Verifica tu correo en MedSync',
            text: `Tu codigo para verificar este correo en MedSync es: ${variables.code}. Vence en 10 minutos. No compartas el codigo. Si no creaste una cuenta, ignora este mensaje.`,
            html: `<p>Verifica tu correo en MedSync.</p><p><strong>${escapeHtml(variables.code)}</strong></p><p>Vence en 10 minutos. No compartas el codigo. Si no creaste una cuenta, ignora este mensaje.</p>`
        };
    }
    if (type === 'document-signature') return documentSignatureEmailTemplate(variables);
    if (type === 'password-reset-code') {
        const { code, ttlMinutes } = variables;
        const ttl = Number.isFinite(Number(ttlMinutes)) && Number(ttlMinutes) > 0 ? Number(ttlMinutes) : 10;
        return {
            subject: 'Codigo de recuperacion de MedSync',
            text: ['MedSync', '', `Tu codigo de recuperacion es: ${code}`, `Este codigo vence en ${ttl} minutos.`, '',
                'Si no solicitaste este cambio, ignora este correo o contacta a soporte.', 'Nunca compartas este codigo con otra persona.'].join('\n'),
            html: `<div style="font-family: Arial, sans-serif; color: #17202a; line-height: 1.5;">
                <h1 style="font-size: 20px; margin: 0 0 12px;">MedSync</h1><p>Usa este codigo para continuar con la recuperacion de tu contrasena.</p>
                <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; margin: 20px 0;">${escapeHtml(code)}</p>
                <p>Este codigo vence en ${ttl} minutos.</p><p>Si no solicitaste este cambio, ignora este correo o contacta a soporte.</p>
                <p>Nunca compartas este codigo con otra persona.</p></div>`
        };
    }
    if (type === 'password-change-code') return passwordChangeCodeEmailTemplate(variables);
    if (type === 'password-changed') return passwordChangedEmailTemplate();
    const error = new Error('Selecciona un tipo de correo transaccional permitido.');
    error.code = 'EMAIL_MESSAGE_TYPE_UNSUPPORTED'; error.safe = true; throw error;
};
