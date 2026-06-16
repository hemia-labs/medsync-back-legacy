# Configuracion segura de sesiones

El cierre de sesiones del modulo Super Admin requiere que el backend valide la
sesion activa por `id_login + id_session` en cada request autenticado.

## Variables requeridas

```txt
REQUIRE_ACTIVE_SESSION=true
JWT_EXPIRES_IN=3600
```

`JWT_EXPIRES_IN=3600` mantiene una experiencia comoda para flujos medicos largos
sin depender de expiraciones agresivas de 5 a 15 minutos. La invalidacion
inmediata viene de `REQUIRE_ACTIVE_SESSION=true`.

## Desarrollo en Windows

PowerShell:

```powershell
$env:REQUIRE_ACTIVE_SESSION="true"
$env:JWT_EXPIRES_IN="3600"
npm run dev
```

CMD:

```bat
set REQUIRE_ACTIVE_SESSION=true
set JWT_EXPIRES_IN=3600
npm run dev
```

## Produccion

En ambientes productivos, `REQUIRE_ACTIVE_SESSION` debe ser `true`. Si el backend
arranca con `NODE_ENV=production`, `APP_ENV=production` o
`ENVIRONMENT=production` y la variable no esta habilitada, el proceso debe fallar
al iniciar.

No registrar ni publicar `JWT_SECRET`, tokens, refresh tokens, contrasenas,
hashes ni otros secretos.
