'use strict';

function passwordChangedEmailTemplate() {
    const subject = 'Tu contraseña de MedSync fue actualizada';
    const text = [
        'MedSync',
        '',
        'Tu contraseña se actualizó correctamente.',
        'Ya puedes iniciar sesión con tu nueva contraseña.',
        '',
        'Si no realizaste este cambio, contacta a soporte de inmediato.'
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
                <div style="width:48px;height:48px;margin:0 0 18px;border-radius:50%;background:#eaf7ef;color:#21804a;font-size:28px;font-weight:700;line-height:48px;text-align:center;">&#10003;</div>
                <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:#123033;">Tu contraseña fue actualizada</h1>
                <p style="margin:0 0 20px;color:#3d565a;font-size:15px;line-height:1.55;">Se cambió la contraseña de tu cuenta de MedSync. Ya puedes iniciar sesión con tu nueva contraseña.</p>
                <div style="margin:0 0 20px;padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;color:#166534;font-size:14px;line-height:1.55;">
                  El cambio se realizó correctamente.
                </div>
                <p style="margin:0;color:#5f6f73;font-size:13px;line-height:1.5;">Si no realizaste este cambio, contacta a soporte de inmediato.</p>
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

module.exports = passwordChangedEmailTemplate;
