# Seguimiento de seguridad: permisos clinicos y cuotas de autenticacion

Esta entrega parte de main `ad7cfc1`, que incluye PR #40 y la correccion de activacion
PM2. No modifica scripts de despliegue, datos, schema, grants ni secretos.

## Correcciones

- La proyeccion clinica de `GET /api/px/get/:id` exige `clinical_history.view` y
  `clinical_history.view_sensitive`, con permiso habilitado en catalogo. Sin ambos,
  conserva la ficha administrativa. Las tres lecturas de historia formal comparten
  la misma regla, incluyendo el contexto transaccional de cada consulta.
- Con identidad S24 habilitada, las variantes local y +52 del mismo telefono
  comparten cuota y limpieza tras login exitoso. No se modifican cuerpos, hashes
  de retos existentes o lookup legacy.
- Un bloqueo vigente sobrevive al vencimiento de la ventana de conteo. Rechazar
  una solicitud no prolonga el bloqueo.
- Dependencias compatibles: nodemailer 10.1.1 -> 10.2.1, body-parser 1.20.8 -> 1.20.9
  y follow-redirects 1.16.0 -> 1.16.2. AWS SDK v2 sigue como deuda separada.

## Verificacion

`npm run qa:isolated`: 21 scripts PASS con Node 22.22.0 sobre esta base. Incluye
PO18 (HTTP real con identidad/SQL sinteticos, permisos y catalogo, normalizacion de
identidad y relojes), parsers, TLS SMTP loopback, historias, recetas, archivos y
activacion/rollback con comandos simulados. Sin DB, AWS o correos reales.

Los nuevos casos cubren denegacion sin cada permiso, respuesta administrativa,
acceso autorizado, aislamiento tenant, variantes +52, modo legacy, limpieza al
exito y bloqueo completo de 15/30 minutos en el limite exacto. El fixture S16
conserva sus aserciones y agrega el caso sin permiso sensible.

Validar roles/grants y login/recuperacion en destino antes de entregar. Los limites
continuan en memoria por proceso: esta entrega no los vuelve distribuidos.
Las pruebas de PR se ejecutan en CI; el job productivo solo corre en main.

## Estado de los reportes anteriores

Atendidos en main por PR #40 y sus correcciones posteriores: #13-#31, #34 y
#36-#39 (24 reportes, incluidos #27 duplicado de #21 y #37 duplicado de #23).
La observacion adicional de #29 se corrigio en `8ffdca5` y fue validada en la
[revision](https://github.com/hemia-labs/medsync-back-legacy/pull/40#issuecomment-6425066097).
Para #17 se conserva la [evidencia de PM2 y readiness](https://github.com/hemia-labs/medsync-back-legacy/pull/40#issuecomment-6425589592)
publicada por el mantenedor tras `ad7cfc1`; no se repitio acceso al VPS en esta entrega.

Permanecen pendientes:

- #32: politica efectiva S3/ACL/CDN y prueba con objeto sintetico de staging.
- #33: proveedor/template SES desplegado y render real sin envio del titulo escapado.
- #35: ya deniega cierre ajeno cuando requiere reautenticacion, pero falta el flujo
  completo de step-up verificable para autorizar la accion despues.

Cerrar los reportes atendidos distingue correccion integrada de validacion de todos
los flujos en produccion. Esta PR agrega el cierre de la via legacy de lectura de
datos sensibles; no atribuye ese cambio adicional a la version anterior.

## Reversion

Revertir los commits de esta entrega y reinstalar con el lockfile correspondiente;
no hay migracion que revertir. Revertir las correcciones restaura los defectos.
