const { slogan, logoHtml } = require('../emailBrand');

function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatText(value, fallback = '') {
    const text = String(value || '').trim();
    return text || fallback;
}

function documentSignatureEmailTemplate({
    patientName,
    clinicName,
    clinicLogoUrl,
    documentTitle,
    doctorName,
    expiresAt,
    publicUrl
}) {
    const plainClinicName = formatText(clinicName, 'Tu consultorio').replace(/[\r\n]+/g, ' ');
    const safePatientName = escapeHtml(formatText(patientName, 'paciente'));
    const safeClinicName = escapeHtml(plainClinicName);
    const safeDocumentTitle = escapeHtml(formatText(documentTitle, 'Documento para firma'));
    const safeDoctorName = escapeHtml(formatText(doctorName, ''));
    const safeExpiresAt = escapeHtml(formatText(expiresAt, 'la fecha indicada'));
    const safePublicUrl = escapeHtml(formatText(publicUrl));
    const safeLogoUrl = /^https?:\/\//i.test(String(clinicLogoUrl || '')) ? escapeHtml(clinicLogoUrl) : '';
    const doctorLine = safeDoctorName ? `<p style="margin:0;color:#5f6f73;">Doctor responsable: ${safeDoctorName}</p>` : '';
    const clinicLogo = safeLogoUrl
        ? `<img src="${safeLogoUrl}" alt="${safeClinicName}" style="display:block;margin:12px 0 0;max-height:56px;max-width:180px;object-fit:contain;">`
        : '';

    const subject = `${plainClinicName} te solicita firmar un documento`;
    const html = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeDocumentTitle}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f8f7;color:#123033;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f8f7;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #dce8e6;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px 28px;border-bottom:1px solid #e5efed;">
                ${logoHtml}
                ${clinicLogo}
                <p style="margin:12px 0 0;color:#1b6b6f;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">${safeClinicName}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:#123033;">Revisa y firma tu documento</h1>
                <p style="margin:0 0 16px;color:#3d565a;font-size:15px;line-height:1.55;">Hola ${safePatientName}, ${safeClinicName} te comparte un documento para revision y firma.</p>
                <div style="background:#f7faf9;border:1px solid #dce8e6;border-radius:8px;padding:14px;margin:0 0 20px;">
                  <p style="margin:0 0 6px;color:#7a8a8f;font-size:12px;text-transform:uppercase;font-weight:700;">Documento</p>
                  <strong style="display:block;color:#123033;font-size:17px;">${safeDocumentTitle}</strong>
                  ${doctorLine}
                  <p style="margin:8px 0 0;color:#5f6f73;">El enlace vence el ${safeExpiresAt}.</p>
                </div>
                <p style="margin:0 0 22px;color:#3d565a;font-size:14px;line-height:1.55;">Por seguridad, este enlace es temporal y se cerrara despues de firmar.</p>
                <a href="${safePublicUrl}" style="display:inline-block;background:#1b6b6f;color:#ffffff;text-decoration:none;border-radius:8px;padding:13px 18px;font-weight:700;">Revisar y firmar documento</a>
                <p style="margin:22px 0 8px;color:#5f6f73;font-size:12px;line-height:1.45;">Si el boton no abre, copia y pega este enlace en tu navegador:</p>
                <p style="word-break:break-all;margin:0;color:#1b6b6f;font-size:12px;">${safePublicUrl}</p>
                <div style="margin-top:22px;padding:12px;border-left:4px solid #f4b740;background:#fff9eb;color:#6f4f00;font-size:13px;line-height:1.45;">
                  Si no reconoces esta solicitud, contacta al consultorio.
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px;background:#f7faf9;color:#6b7d81;font-size:12px;text-align:center;">
                Enviado por Hemia. No respondas con informacion clinica sensible a este correo.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

    const text = [
        'MedSync',
        slogan,
        `Hola ${formatText(patientName, 'paciente')},`,
        '',
        `${formatText(clinicName, 'Tu consultorio')} te comparte un documento para revision y firma.`,
        `Documento: ${formatText(documentTitle, 'Documento para firma')}`,
        doctorName ? `Doctor responsable: ${doctorName}` : '',
        `El enlace vence el ${formatText(expiresAt, 'la fecha indicada')}.`,
        '',
        `Revisar y firmar documento: ${formatText(publicUrl)}`,
        '',
        'Si no reconoces esta solicitud, contacta al consultorio.',
        'Enviado por Hemia.'
    ].filter((line) => line !== '').join('\n');

    return {
        subject,
        html,
        text
    };
}

module.exports = documentSignatureEmailTemplate;
