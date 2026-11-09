'use strict';

const { slogan, logoHtml } = require('../emailBrand');

const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function passwordChangedEmailTemplate({ accountEmail, changedAt, changeMethod, supportEmail } = {}) {
    const subject = 'Tu contraseña de MedSync fue actualizada';
    const rows = [];
    if (accountEmail) rows.push(['Cuenta', accountEmail]);
    // Use the event time supplied after the update, never the email delivery time.
    const date = changedAt ? new Date(changedAt) : null;
    if (date && Number.isFinite(date.getTime())) {
        rows.push(['Fecha y hora', `${new Intl.DateTimeFormat('es-MX', {
            timeZone: 'America/Mexico_City', day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).format(date)} (Ciudad de México)`]);
    }
    if (changeMethod === 'settings') {
        rows.push(['Origen', 'Configuración de tu cuenta']);
        rows.push(['Sesiones', 'Las demás sesiones se cerraron. Tu sesión actual sigue abierta.']);
    } else if (changeMethod === 'recovery') {
        rows.push(['Origen', 'Recuperación de contraseña']);
        rows.push(['Sesiones', 'Todas las sesiones se cerraron. Inicia sesión con tu nueva contraseña.']);
    }
    const support = typeof supportEmail === 'string' && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(supportEmail)
        ? supportEmail : '';
    const advice = 'Si no realizaste este cambio, recupera tu contraseña y contacta a soporte de inmediato. Nunca compartas tu contraseña ni códigos de verificación.';
    const text = ['MedSync', slogan, '', 'Tu contraseña fue actualizada',
        'El cambio se completó correctamente. Ya puedes usar tu nueva contraseña para acceder a MedSync.', '',
        ...rows.map(([label, value]) => `${label}: ${value}`), '', advice,
        ...(support ? [`Soporte: ${support}`] : [])].join('\n');
    const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#edf2f6;color:#0d1b2a;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border:1px solid #dce6ed;border-radius:20px;overflow:hidden;">
<tr><td style="padding:28px 24px;border-bottom:1px solid #e7edf2;">${logoHtml}</td></tr>
<tr><td style="padding:32px 24px;">
<p style="margin:0 0 16px;color:#0d6e78;font-size:10px;font-weight:700;letter-spacing:1px;">SEGURIDAD DE TU CUENTA</p>
<h1 style="margin:0 0 20px;font-size:28px;line-height:1.2;">Tu contraseña fue actualizada</h1>
<p style="margin:0 0 24px;color:#5a6672;font-size:15px;line-height:1.6;">El cambio se completó correctamente. Ya puedes usar tu nueva contraseña para acceder a MedSync.</p>
${rows.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f7fb;border-radius:12px;">${rows.map(([label, value]) => `<tr><td style="padding:12px 20px;font-size:13px;line-height:1.6;word-break:break-word;"><span style="color:#47647c;">${escapeHtml(label)}</span><br><strong style="font-weight:500;">${escapeHtml(value)}</strong></td></tr>`).join('')}</table>` : ''}
</td></tr>
<tr><td style="padding:24px;background:#f7f9fb;border-top:1px solid #e7edf2;">
<p style="margin:0 0 8px;color:#35526a;font-size:14px;font-weight:700;">¿No realizaste este cambio?</p>
<p style="margin:0;color:#5a6672;font-size:13px;line-height:1.6;">Recupera tu contraseña y contacta a soporte de inmediato. Nunca compartas tu contraseña ni códigos de verificación.</p>
${support ? `<p style="margin:12px 0 0;font-size:13px;"><a href="mailto:${escapeHtml(encodeURIComponent(support))}" style="color:#0d6e78;">Contactar a soporte</a></p>` : ''}
</td></tr></table><p style="margin:24px 0;color:#788b9c;font-size:11px;">MedSync · Gestión clínica</p>
</td></tr></table></body></html>`;
    return { subject, text, html };
}

module.exports = passwordChangedEmailTemplate;
