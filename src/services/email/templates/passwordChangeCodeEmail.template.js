'use strict';

function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function passwordChangeCodeEmailTemplate({ code, ttlMinutes = 10 } = {}) {
    const safeCode = escapeHtml(code);
    const ttl = Number.isFinite(Number(ttlMinutes)) && Number(ttlMinutes) > 0
        ? Math.min(Number(ttlMinutes), 10)
        : 10;
    const subject = 'Codigo para cambiar tu contrasena de MedSync';
    const text = [
        'MedSync',
        '',
        `Tu codigo para confirmar el cambio de contrasena es: ${code || ''}`,
        `Este codigo vence en ${ttl} minutos y solo se puede usar una vez.`,
        '',
        'Si no solicitaste este cambio, ignora este correo o contacta a soporte.',
        'Nunca compartas este codigo con otra persona.'
    ].join('\n');
    const html = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f8f7;color:#123033;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f8f7;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #dce8e6;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px 28px;border-bottom:1px solid #e5efed;">
                <strong style="font-size:26px;color:#1b6b6f;">MedSync</strong>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:#123033;">Confirma el cambio de contrasena</h1>
                <p style="margin:0 0 20px;color:#3d565a;font-size:15px;line-height:1.55;">Usa este codigo para confirmar el cambio solicitado en tu cuenta.</p>
                <div style="margin:0 0 20px;padding:18px;background:#f7faf9;border:1px solid #dce8e6;border-radius:8px;text-align:center;">
                  <span style="font-size:30px;font-weight:700;letter-spacing:6px;color:#123033;">${safeCode}</span>
                </div>
                <p style="margin:0 0 12px;color:#3d565a;font-size:14px;line-height:1.55;">El codigo vence en ${ttl} minutos y solo se puede usar una vez.</p>
                <p style="margin:0;color:#5f6f73;font-size:13px;line-height:1.5;">Si no solicitaste este cambio, ignora este correo. Nunca compartas el codigo con otra persona.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px;background:#f7faf9;color:#6b7d81;font-size:12px;text-align:center;">Mensaje de seguridad de MedSync.</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

    return { subject, text, html };
}

module.exports = passwordChangeCodeEmailTemplate;
