# MedSync Platform: puente Hemia SSO

Destino confirmado: **https://master.medsync.mx**. Frontend independiente: [medsync-platform-front](https://github.com/hemia-labs/medsync-platform-front). Backend, sesiones, roles y auditoría siguen siendo MedSync.

## Configuración

Deshabilitado por defecto. Usar el loader/gestor de secretos existente; no guardar credenciales en Git. Las siguientes variables son nombres y placeholders, no valores para producción:

```dotenv
PLATFORM_SSO_ENABLED=false
PLATFORM_FRONTEND_URL=https://master.medsync.mx
PLATFORM_SSO_CALLBACK_URL=https://master.medsync.mx/api/platform-auth/callback
PLATFORM_SSO_ISSUER=https://ISSUER_HEMIA_CONFIRMADO
PLATFORM_SSO_CLIENT_ID=CLIENTE_MEDSYNC_PLATFORM
PLATFORM_SSO_CLIENT_SECRET=SECRETO_EN_GESTOR
PLATFORM_SSO_FLOW_KEY=32_BYTES_ALEATORIOS_CODIFICADOS_EN_BASE64
PLATFORM_SSO_IDENTITY_BINDINGS_JSON=[{"sub":"SUB_HEMIA","email":"CORREO_VERIFICADO","id_login":"ID_SUPER_ADMIN_EXISTENTE"}]
```

Crear un cliente confidencial propio de autorización code/PKCE S256, con `client_secret_post`, ID token RS256 y scopes `openid profile email`. No reutilizar credenciales Billing/Legal. Se usa `/oauth/authorize`, `/oauth/token`, `/.well-known/jwks.json` bajo el issuer; confirmar esos contratos al registrar el cliente.

Prerrequisitos: `AUTH_COOKIE_MODE=d2`, `BROWSER_AUTH_TRANSPORT=cookie`, `CSRF_ENABLED=true`, `CORS_CREDENTIALS=true`, `AUTH_COOKIE_SECURE=true`, `AUTH_COOKIE_SAMESITE=lax`, host-only sin `AUTH_COOKIE_DOMAIN`, Path `/`. `JWT_SECRET` debe tener al menos 32 caracteres. Agregar el origin del panel a `CORS_ALLOWED_ORIGINS` y `CSRF_ALLOWED_ORIGINS` sin sustituir origins vigentes. Configurar el trust proxy solo para la topología real.

Una cuenta queda vinculada por issuer/sub/correo verificado/id_login; además debe existir activa, desbloqueada y ser `super_admin`. No hay alta automática ni permisos por sufijo del correo. Los bindings deben tener sub e id_login únicos. La clave transitoria se genera con 32 bytes de un generador criptográfico y se guarda en secretos, separada del secreto JWT.

## Comportamiento

- `GET /api/platform-auth/config`: solo `{enabled}`; no expone configuración, cuentas ni secretos.
- `GET /api/platform-auth/login`: transacción cifrada AES-GCM en cookie HttpOnly por cinco minutos; PKCE/state/nonce y callback fijo.
- `GET /api/platform-auth/callback`: intercambio servidor, verificación JOSE y alta transaccional de sesión existente. Revoca sesiones/refresh previos como el login legacy, registra `PLATFORM_SSO_LOGIN` de forma estricta y emite únicamente cookie D2 local.
- Duración máxima 15 minutos o expiración del ID token, la menor. Sin refresh SSO. La UI debe volver al proveedor al expirar.
- `activePrincipal` revalida binding, issuer, rol, correo, bloqueo y sesión en cada request. Apagar el flag revoca efectivamente las sesiones SSO. Las sesiones legacy mantienen su política existente.
- Logout del panel cierra MedSync; no ejecuta logout global de Hemia. Revocación solo en el proveedor no se propaga inmediatamente: su latencia está acotada por la sesión corta; para revocación inmediata cerrar sesión local/quitar binding.
- No se copiaron Redis ni grants Hemia Access de Billing/Legal. No se afirma equivalencia con su autorización por producto. MedSync sigue autorizando localmente.

No se exponen los tokens del proveedor ni se imprimen códigos/claims. El sanitizador oculta la query de callback en morgan; configurar también el proxy para omitirla. El código de autorización se consume una sola vez por el proveedor; PKCE y el cookie vinculan el callback al navegador que inició el acceso.

## QA y activación

`node --test scripts/qa/platform-sso.test.js`: criptografía real y servidor HTTP, cuentas/SQL sintéticos, sin conexiones MySQL. Incluye rechazo de token, identidad, estado, bloqueo, rollback, flags y cookies. `node scripts/qa/s18-session-revocation-http-regression.js` comprueba compatibilidad D2/bearer y revocación. También ejecutar las regresiones de CSRF y autorización.

Pendiente en destino: registrar cliente, identificar sub/correo/id_login autorizados, configurar secretos/origins y validar login real/caducidad/revocación y operaciones con datos de aceptación. No se aplicó migración ni configuración de producción. No retirar el panel legacy antes de ese corte.

Rollback: desactivar `PLATFORM_SSO_ENABLED`, volver al release anterior si corresponde. No hay cambios de esquema que revertir.
