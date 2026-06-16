const nodemailer = require('nodemailer');
const config = require('../config/config');
const EmailService = require('../services/email/email.service');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeEmailResult(result) {
  return {
    process: Boolean(result && (result.success || result.process))
  };
}

  /**
   * Envia un correo deacuerdo a los parametros enviados
   * @param {String} to A quien va dirijido el correo
   * @param {String} mensaje Mensaje a enviar
   * @param {String} subject Subject (Opcional)
   * @author Marco Antonio Saraos Hernandez
   */
async function SendMail(to, mensaje, subject = 'Envio de correo', text="",){
try {
  

//Creamos el objeto de transporte
const transporter = nodemailer.createTransport({
    service: config.SERVICEMAIL,
    auth: {
      user: config.USERGMAIL,
      pass: config.PASSWORDGMAIL
    }
  });    

   //----------------------------------------------------------------
    // Message object
    let Messageobject = {
        from: config.USERGMAIL,

        // Comma separated list of recipients
        to: to,
        //bcc: 'andris@ethereal.email',

        // Subject of the message
        subject: subject,

        // plaintext body
        text: text,

        // HTML body
        html:mensaje
            // '<p><b>Hello</b> to myself <img src="cid:note@example.com"/></p>' +
            // '<p>Here\'s a nyan cat for you as an embedded attachment:<br/><img src="cid:nyan@example.com"/></p>',

        // An array of attachments
        // attachments: [
        //     {
        //         filename: 'notes.txt',
        //         content: 'Si puedes leer esto, marco es la verga',
        //         contentType: 'text/plain' // optional, would be detected from the filename
        //     },

        //     {
        //         filename: 'img.png',
        //         path: __dirname + '/login.png',
        //         cid: to // should be as unique as possible
        //     }
        // ]
    };

   //----------------------------------------------------------------
  
    // let mailOptions = {
    //   from: config.USERGMAIL,
    //   to: to,
    //   subject: subject,
    //   text: mensaje
    // };    

    let sendMailOtp = await transporter.sendMail(Messageobject);

    if(sendMailOtp.messageId){
        return { process: true}
    }
    } catch (error) {
      console.error('[MAIL ERROR]', {
        message: error && error.message ? error.message : 'Mail delivery failed',
        code: error && error.code ? error.code : null,
        command: error && error.command ? error.command : null
      });
      return { process: false}
    }
}

async function SendPasswordResetCode(to, { code, ttlMinutes } = {}) {
  const safeCode = escapeHtml(code);
  const safeTtl = Number.isFinite(Number(ttlMinutes)) && Number(ttlMinutes) > 0 ? Number(ttlMinutes) : 10;
  const subject = 'Codigo de recuperacion de MedSync';
  const text = [
    'MedSync',
    '',
    `Tu codigo de recuperacion es: ${code}`,
    `Este codigo vence en ${safeTtl} minutos.`,
    '',
    'Si no solicitaste este cambio, ignora este correo o contacta a soporte.',
    'Nunca compartas este codigo con otra persona.'
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; color: #17202a; line-height: 1.5;">
      <h1 style="font-size: 20px; margin: 0 0 12px;">MedSync</h1>
      <p>Usa este codigo para continuar con la recuperacion de tu contrasena.</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; margin: 20px 0;">${safeCode}</p>
      <p>Este codigo vence en ${safeTtl} minutos.</p>
      <p>Si no solicitaste este cambio, ignora este correo o contacta a soporte.</p>
      <p>Nunca compartas este codigo con otra persona.</p>
    </div>
  `;

  const result = await EmailService.sendTransactionalEmail({ to, subject, html, text });
  return normalizeEmailResult(result);
}

async function SendPasswordChanged(to) {
  const subject = 'Tu contrasena de MedSync fue actualizada';
  const text = [
    'MedSync',
    '',
    'Tu contrasena fue actualizada correctamente.',
    '',
    'Si no realizaste este cambio, contacta a soporte de inmediato.'
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; color: #17202a; line-height: 1.5;">
      <h1 style="font-size: 20px; margin: 0 0 12px;">MedSync</h1>
      <p>Tu contrasena fue actualizada correctamente.</p>
      <p>Si no realizaste este cambio, contacta a soporte de inmediato.</p>
    </div>
  `;

  const result = await EmailService.sendTransactionalEmail({ to, subject, html, text });
  return normalizeEmailResult(result);
}

module.exports = {
    SendMail,
    SendPasswordChanged,
    SendPasswordResetCode
}
