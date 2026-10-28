# Cambio de contraseña con sesión

El flujo de Configuración está separado de la recuperación pública desde el inicio de sesión.

1. `POST /api/auth/changePassword/sendCode` requiere sesión activa y CSRF. Valida la contraseña actual en el servidor, la política de la contraseña nueva y su confirmación. Solo después crea el reto y envía el OTP al correo registrado.
2. `POST /api/auth/changePassword/confirm` requiere la misma cuenta autenticada y el OTP. Si coincide y no expiró, actualiza la contraseña dentro de una transacción.

El reto se liga a `id_login`; la base guarda el HMAC del OTP, nunca el código en texto plano, además del hash pendiente de la contraseña nueva. Vence como máximo en 10 minutos aunque `PASSWORD_RESET_CODE_TTL_MINUTES` esté configurado con un valor mayor. Al confirmar, el registro cambia de `pending` a `used`, guarda `used_at` y borra el hash pendiente; por eso no puede reutilizarse. También se comprueba que el correo y la contraseña de origen no hayan cambiado durante el proceso. Los reenvíos revocan retos anteriores y los intentos fallidos se limitan y bloquean. El cambio conserva la sesión actual y revoca las demás.

La plantilla de cambio vive en `src/services/email/templates/passwordChangeCodeEmail.template.js` y se conecta desde `src/services/email/transactionalEmail.renderer.js`. SMTP y SES usan ese contenido local; SES lo envía como mensaje HTML y texto, así que no requiere publicar una plantilla adicional en AWS.

La tabla `auth_password_change_tokens` se instala con `scripts/migrations/apply-auth-password-change-tokens.js`.

Desde `medsync-back-legacy`, con la configuración de base de datos cargada, primero valida el destino y luego instala la tabla:

```sh
npm run migration:auth-password-change -- --expect-database hemia_assitant_legacy
npm run migration:auth-password-change -- --expect-database hemia_assitant_legacy --apply
```

En SES, configura el remitente y el configuration set de autenticación como para los demás correos transaccionales.
