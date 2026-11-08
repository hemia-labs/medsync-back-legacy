# Cambio de contraseña con sesión


## Activación de SES en el entorno local — 2026-10-29

Se configuró `EMAIL_PROVIDER=ses` en `.env.local` (sin versionar), usando las
credenciales runtime existentes de la cuenta MedSync PROD `379492770798`, región
`us-east-2`; no se cambiaron credenciales de S3 ni permisos IAM. El remitente de
autenticación es `auth@medsync.mx` y el de firma `notifications@medsync.mx`.
`EMAIL_REPLY_TO` conserva la dirección que ya se usaba como remitente SMTP.

Registro, recuperación, código de confirmación del cambio, contraseña actualizada
y firma usan las plantillas `medsync-prod-*` del ambiente. SMTP queda disponible como proveedor alternativo,
pero ya no es el seleccionado en este entorno. `PUBLIC_APP_URL` se configuró
con `https://app.medsync.mx`, que responde por HTTPS con la SPA de MedSync tanto
en la raíz como en `/sign/d/...`. Esta comprobación no equivale a firmar un
documento real ni verifica que el secreto de enlaces coincida entre despliegues.

Infra: PR [22](https://github.com/hemia-labs/hemia-infra/pull/22) y
[23](https://github.com/hemia-labs/hemia-infra/pull/23), fusionados.
[Publicación completa DEV/PROD](https://github.com/hemia-labs/hemia-infra/actions/runs/40944280685):
respaldo, comparación de contenido y test-render de las cuatro plantillas en cada
cuenta. Readiness local sin campos faltantes y enlaces HTTPS. El backend se
reinició para cargar la configuración; `/readyz` devuelve 200. No se enviaron
mensajes reales ni se ejecutaron migraciones. La activación local no despliega el
código o las variables en el servidor remoto de la aplicación.

## Notificación de contraseña actualizada — 2026-10-29

El aviso posterior al cambio y a la recuperación incluye el correo de la cuenta,
la hora del evento (capturada antes del commit, sin usar la hora de entrega),
la zona Ciudad de México (`America/Mexico_City`), el origen y el resultado sobre
las sesiones. Configuración conserva la sesión actual y cierra las demás;
recuperación cierra todas. Se envía únicamente después del commit; una excepción
de correo sigue sin cambiar el resultado de la operación ya completada.

`SendPasswordChanged(to, { changedAt, changeMethod })` obtiene el correo desde la
cuenta y el método desde el DAO (`settings` / `recovery`), sin aceptar estos datos
del cliente. La plantilla omite campos desconocidos en llamadas antiguas y escapa
todos los valores HTML. El enlace de soporte usa `EMAIL_REPLY_TO` solo si es una
dirección válida. No incluye contraseñas, OTP, identificadores de sesión ni IP o
ubicación inferida. No requiere cambios de esquema.

SES usa ahora `Content.Template` con `EMAIL_PASSWORD_CHANGED_TEMPLATE`:
`medsync-dev-password-changed` o `medsync-prod-password-changed`. El proveedor
prepara `accountEmail`, `changedAtLabel`, `changeOrigin`, `sessionNotice`,
`supportUrl` y copias `html.*` escapadas, a partir de los datos internos del DAO.
El destinatario y `EMAIL_REPLY_TO` prevalecen sobre los valores recibidos en
variables. El formato de fecha indica Ciudad de México. La plantilla debe estar
configurada y publicada: no hay fallback a HTML local en SES. SMTP conserva
`passwordChangedEmail.template.js` para instalaciones que seleccionen SMTP. La cabecera blanca y el
logo del CDN corresponden al diseño de Figma. La regresión offline de correo
comprueba ambos proveedores, ambos orígenes, la conversión horaria, omisión de datos
ausentes y escape HTML. No envía correos ni conecta con la base de datos.

El flujo de Configuración está separado de la recuperación pública desde el inicio de sesión.

1. `POST /api/auth/changePassword/sendCode` requiere sesión activa y CSRF. Valida la contraseña actual en el servidor, la política de la contraseña nueva y su confirmación. Solo después crea el reto y envía el OTP al correo registrado.
2. `POST /api/auth/changePassword/confirm` requiere la misma cuenta autenticada y el OTP. Si coincide y no expiró, actualiza la contraseña dentro de una transacción.

El reto se liga a `id_login`; la base guarda el HMAC del OTP, nunca el código en texto plano, además del hash pendiente de la contraseña nueva. Vence como máximo en 10 minutos aunque `PASSWORD_RESET_CODE_TTL_MINUTES` esté configurado con un valor mayor. Al confirmar, el registro cambia de `pending` a `used`, guarda `used_at` y borra el hash pendiente; por eso no puede reutilizarse. También se comprueba que el correo y la contraseña de origen no hayan cambiado durante el proceso. Los reenvíos revocan retos anteriores y los intentos fallidos se limitan y bloquean. El cambio conserva la sesión actual y revoca las demás.

El código de confirmación usa ahora una plantilla almacenada en SES:
`EMAIL_PASSWORD_CHANGE_CODE_TEMPLATE=medsync-dev-password-change-code` en DEV o
`medsync-prod-password-change-code` en PROD. El proveedor envía exclusivamente
`Content.Template` con `code`, `ttlMinutes`, `html.code` y `html.ttlMinutes`;
conserva ceros iniciales, escapa HTML una vez y mantiene el máximo de 10 minutos
que ya aplica el reto. Un fallo SES se informa sin intentar un envío Simple ni
SMTP. La plantilla local `passwordChangeCodeEmail.template.js` queda solo para
instalaciones que seleccionen explícitamente SMTP.

El diseño procede de [Figma](https://www.figma.com/design/lAjhrNQFNohQFUEcaSTgdk/medsync?node-id=57-573):
cabecera blanca, código destacado, vigencia y aviso de que la contraseña aún no
ha cambiado. JSON y ejemplos DEV/PROD viven en hemia-infra; su publicador admite
`scope=password-change`, guarda respaldo y verifica contenido y test-render sin
enviar correos reales. No modifica el flujo, los retos ni la base de datos.

Publicación de la plantilla: [PR 24](https://github.com/hemia-labs/hemia-infra/pull/24),
fusionado; [ejecución DEV/PROD exitosa](https://github.com/hemia-labs/hemia-infra/actions/runs/40945969989).
El entorno local ya configura `EMAIL_PASSWORD_CHANGE_CODE_TEMPLATE` para PROD.
Validación: 13 comprobaciones offline del proveedor, readiness sin variables
faltantes y revisión HTML a 760/390 px sin desbordamientos. Se comprobaron
vigencia, ceros iniciales, escape, errores sin fallback y ausencia de contraseñas
en `TemplateData`. No se enviaron correos reales ni se ejecutaron migraciones.

La tabla `auth_password_change_tokens` se instala con `scripts/migrations/apply-auth-password-change-tokens.js`.

Desde `medsync-back-legacy`, con la configuración de base de datos cargada, primero valida el destino y luego instala la tabla:

```sh
npm run migration:auth-password-change -- --expect-database hemia_assitant_legacy
npm run migration:auth-password-change -- --expect-database hemia_assitant_legacy --apply
```

En SES, configura el remitente y el configuration set de autenticación como para los demás correos transaccionales.

## Corrección de cambio y recuperación — 2026-10-29

El cambio autenticado comparte ahora la política de registro/recuperación:
8–128 caracteres Unicode, normalización NFC, hasta 512 bytes, espacios
conservados y lista local de contraseñas comprometidas. El hash pendiente se
crea con scrypt; no vuelve a bcrypt. Esto evita perder espacios al iniciar
sesión y diferencias ignoradas después de 72 bytes. Los hashes bcrypt antiguos
siguen siendo compatibles para comprobar la contraseña actual.

El reenvío autenticado espera al menos 60 segundos. El servidor bloquea primero
la cuenta y comprueba el último `issued_at` dentro de la transacción, por lo que
solicitudes simultáneas no emiten dos códigos. Devuelve `resendAfterSeconds` al
enviar y `Retry-After`/`retryAfterSeconds` al rechazar por espera; el frontend
muestra el contador y conserva esa espera aunque se vuelva a editar el formulario.
Los límites generales de autenticación también exponen su espera en el cuerpo.

Al confirmar el cambio se revocan también los retos de recuperación públicos
pendientes/verificados, en la misma transacción que consume el código, actualiza
la contraseña y cierra las demás sesiones. La sesión actual se conserva. Si la
revocación falla, el cambio se revierte. La notificación posterior es informativa:
un fallo al enviarla no convierte en error un cambio que ya fue confirmado.
Un error/excepción en la entrega del código inicial revoca el reto y borra su hash
pendiente.

La pantalla conserva dos pasos (contraseñas → código → resultado), elimina la
ayuda lateral repetida y utiliza el mismo validador del registro. El código sigue
siendo de un solo uso; no se ha agregado otra confirmación por correo.

En «Olvidé mi contraseña» se mantienen correo → código → nueva contraseña →
resultado. Se sustituyó «Volver al código» por «Solicitar otro código», respetando
la espera: una validación anterior no se vuelve a enviar como si estuviera
pendiente. Un nuevo envío confirmado o cambiar de correo limpia código y
contraseñas anteriores. El envío desde la pantalla de correo tampoco evita el
contador. Un error de conexión libera el estado de carga. Los secretos no se
persisten en el navegador.

No requiere migración: el hash scrypt cabe en `pending_password_hash VARCHAR(255)`
y se utilizan las tablas y columnas existentes. No se modificaron cuentas ni
credenciales en la base real.

Validación: DAO real con consultas/transacciones simuladas y KDF real; ocho letras,
Unicode, espacios, diferencias después de 72 bytes, lista de contraseñas comunes,
reenvío concurrente, espera, cinco intentos, consumo único, revocación de códigos,
rollback y fallos de correo. Validadores y métodos Vue reales probados con dobles,
compilación de ambas plantillas, ESLint, sintaxis Node y comprobación de cambios.
Los scripts temporales de comprobación permanecieron fuera del repositorio.
La comprobación visual en Chrome no se pudo completar bajo el aislamiento exigido
por la habilidad `security-audit`: el navegador no pudo crear su directorio de
socket/perfil con los permisos restringidos. No se relajó el acceso a red ni a
carpetas personales para continuar esa prueba; escritorio/móvil quedan pendientes
de inspección visual. No se enviaron mensajes reales durante la validación.

## Prueba real de recepción — 2026-10-29

El usuario autorizó enviar un correo ficticio del código de confirmación a su
buzón. La prueba real detectó que el usuario IAM necesitaba `ses:SendTemplatedEmail`.
Con autorización específica se añadió esa acción a la política permanente,
conservando región, remitentes y recursos. El [PR 25 de infraestructura](https://github.com/hemia-labs/hemia-infra/pull/25)
registra la corrección y su prueba Terraform con mock AWS.

SES PROD está en sandbox y el destinatario de prueba está verificado. AWS denegó
además la identidad del destinatario; con aprobación separada se creó una política
temporal limitada a ese destinatario, remitente `auth@medsync.mx`, región de PROD
y caducidad de 30 minutos. El envío se hizo con el proveedor y las credenciales
runtime del backend, usando `medsync-prod-password-change-code` y el código
ficticio `059173`, sin escribir cuentas, contraseñas ni retos en la base de datos.

SES aceptó una sola prueba. Se abrió el mensaje recibido en el buzón Gmail del
destinatario y se verificaron logo, cabecera blanca, código conservando el cero,
vigencia de 10 minutos y aviso de que la contraseña no ha cambiado, con el diseño
aprobado de Figma. La política temporal `medsync-prod-email-test` se retiró tras
el envío; la consola confirmó su eliminación y el regreso a dos políticas
permanentes. No se pidió ni se habilitó acceso de producción SES: el envío general
a destinatarios no verificados sigue pendiente de resolver la salida de sandbox.
