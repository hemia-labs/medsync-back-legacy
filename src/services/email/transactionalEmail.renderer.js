'use strict';

// Compatibility renderer for SMTP only. SES renders its published templates.
const documentSignatureEmailTemplate = require('./templates/documentSignatureEmail.template');
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

module.exports = function renderTransactionalEmail(type, variables = {}) {
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
    if (type === 'password-changed') return {
        subject: 'Tu contrasena de MedSync fue actualizada',
        text: ['MedSync', '', 'Tu contrasena fue actualizada correctamente.', '', 'Si no realizaste este cambio, contacta a soporte de inmediato.'].join('\n'),
        html: '<div style="font-family: Arial, sans-serif; color: #17202a; line-height: 1.5;"><h1 style="font-size: 20px; margin: 0 0 12px;">MedSync</h1><p>Tu contrasena fue actualizada correctamente.</p><p>Si no realizaste este cambio, contacta a soporte de inmediato.</p></div>'
    };
    const error = new Error('Selecciona un tipo de correo transaccional permitido.');
    error.code = 'EMAIL_MESSAGE_TYPE_UNSUPPORTED'; error.safe = true; throw error;
};
