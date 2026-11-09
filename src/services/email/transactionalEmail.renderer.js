'use strict';

// Shared rendering for SMTP and transactional SES messages; other SES types use published templates.
const documentSignatureEmailTemplate = require('./templates/documentSignatureEmail.template');
const passwordChangeCodeEmailTemplate = require('./templates/passwordChangeCodeEmail.template');
const passwordChangedEmailTemplate = require('./templates/passwordChangedEmail.template');
const { slogan, logoHtml } = require('./emailBrand');
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

module.exports = function renderTransactionalEmail(type, variables = {}) {
    if (type === 'registration-contact-code') {
        if (!/^[0-9]{6}$/.test(variables.code || '')) throw new Error('EMAIL_VERIFICATION_CODE_INVALID');
        const title = 'Confirma tu correo';
        const instruction = 'En la pantalla «Confirma tu correo» de MedSync, ingresa este código para continuar con tu registro.';
        const expiry = 'Vence en 10 minutos';
        const safety = 'Es de un solo uso. No lo compartas.';
        const resend = 'Si vence, selecciona «Reenviar código» en MedSync.';
        const notice = '¿No solicitaste este código? Puedes ignorar este correo.';
        return {
            subject: 'Confirma tu correo en MedSync',
            text: ['MedSync', slogan, '', title, '', instruction, '',
                `Código de verificación: ${variables.code}`, `${expiry}. ${safety}`, resend, '', notice].join('\n'),
            html: `<div lang="es" style="max-width:520px;margin:0 auto;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#0d1b2a;line-height:1.5;">
                ${logoHtml}
                <h1 style="margin:24px 0 16px;font-size:28px;">${title}</h1>
                <p style="margin:0 0 24px;">${instruction}</p>
                <div style="padding:16px;background:#f0f7fb;border-radius:12px;text-align:center;">
                    <p style="margin:0 0 8px;font-size:13px;">Código de verificación</p>
                    <p dir="ltr" style="margin:0;font:bold 36px Consolas,'Courier New',monospace;letter-spacing:5px;">${escapeHtml(variables.code)}</p>
                </div>
                <p style="text-align:center;font-size:14px;">${expiry}. ${safety}<br>${resend}</p>
                <p style="margin:24px 0 0;font-size:13px;color:#5a6c7c;">${notice}</p>
            </div>`
        };
    }
    if (type === 'document-signature') return documentSignatureEmailTemplate(variables);
    if (type === 'password-reset-code') {
        const { code, ttlMinutes } = variables;
        const ttl = Number.isFinite(Number(ttlMinutes)) && Number(ttlMinutes) > 0 ? Number(ttlMinutes) : 10;
        return {
            subject: 'Codigo de recuperacion de MedSync',
            text: ['MedSync', slogan, '', `Tu codigo de recuperacion es: ${code}`, `Este codigo vence en ${ttl} minutos.`, '',
                'Si no solicitaste este cambio, ignora este correo o contacta a soporte.', 'Nunca compartas este codigo con otra persona.'].join('\n'),
            html: `<div style="font-family: Arial, sans-serif; color: #17202a; line-height: 1.5;">
                ${logoHtml}
                <p>Usa este codigo para continuar con la recuperacion de tu contrasena.</p>
                <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; margin: 20px 0;">${escapeHtml(code)}</p>
                <p>Este codigo vence en ${ttl} minutos.</p><p>Si no solicitaste este cambio, ignora este correo o contacta a soporte.</p>
                <p>Nunca compartas este codigo con otra persona.</p></div>`
        };
    }
    if (type === 'password-change-code') return passwordChangeCodeEmailTemplate(variables);
    if (type === 'password-changed') return passwordChangedEmailTemplate(variables);
    const error = new Error('Selecciona un tipo de correo transaccional permitido.');
    error.code = 'EMAIL_MESSAGE_TYPE_UNSUPPORTED'; error.safe = true; throw error;
};
