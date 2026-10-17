# Profesional y Clinica: entrega del piloto

Fecha: 2026-10-14. Rama de integracion: `develop`.

## Alcance de esta entrega

Se conserva Profesional (un doctor con asistentes) y Clinica (expediente unificado y agenda por doctor). S14, practicas independientes con expedientes separados dentro de una licencia, queda descartado hasta una necesidad real y una nueva decision.

La entrega acumula las mejoras de recetas, historia clinica, alergias, tratamientos y consentimiento, agenda/configuracion por doctor, permisos por funcion, indicadores, captura inicial de recepcion, entrega al doctor y seguimiento. Incluye las correcciones S19 de reintentos/concurrencia de recetas, autorizacion de finalizacion y requisitos de firma congelados. Conserva Vue 2 y los patrones actuales; no requiere un nuevo gestor de estado ni un nuevo esquema de licencias.

Este archivo acompana al codigo en Git. El historial detallado de decisiones del workspace permanece en `F:\HemiaAssistantGlobal\docs`; no es parte de este repositorio ni se publica automaticamente en el portal documental.

## Comprobar SQL antes de ejecutar migraciones

Desde la raiz del backend, con dependencias instaladas y el entorno configurado mediante el cargador existente:

El motor declarado es Node 22; en un checkout nuevo instalar dependencias con `npm ci`. Para aplicar pendientes en otro entorno se requieren permisos SQL para las operaciones DDL/rutinas/triggers y los seeds correspondientes, ademas de un respaldo recuperable previo. La auditoria de abajo solo necesita lectura y visibilidad de metadatos/definiciones.

```sh
node scripts/qa/pending-migrations-readonly-audit.js
```

La auditoria usa una conexion, consultas de metadatos/lectura y conteos de candidatos. No ejecuta migraciones, no cambia permisos ni limpia citas. No muestra credenciales o registros de pacientes. `UP_TO_DATE` indica que no detecto pendientes de las migraciones incluidas; no equivale a una auditoria completa de toda la base.

El 2026-10-14 la base configurada devolvio `UP_TO_DATE`: seis tablas aditivas, 18 columnas agregadas, 19 indices declarados en migraciones, ocho relaciones, el trigger de alergias, cinco procedimientos de agenda y ocho permisos comprobados. Los conteos de configuraciones/permisos/backfills pendientes fueron cero. **No fue necesario aplicar SQL ni repetir seeds o limpieza de datos.** S19 no agrega esquema.

## Migraciones disponibles para otro entorno

Los siguientes comandos son una referencia de orden, no un lote que deba repetirse en una base actualizada. Ejecutar solo lo que la inspeccion del entorno determine pendiente. Cada runner usa el cargador de configuracion del backend y una conexion secuencial; no ejecutarlos simultaneamente.

| Orden | Cambio | Comando desde backend |
| --- | --- | --- |
| 1 | S10: permisos por rol y tenant | `node scripts/migrations/s10-tenant-role-permissions.js` |
| 2 | CO8: versiones/auditoria de consentimiento del plan | `node scripts/migrations/apply-co8-treatment-plan.js --apply` |
| 3 | CO9: vinculo del consentimiento del plan con documentos | `node scripts/migrations/apply-co9-treatment-consent-document.js --apply` |
| 4 | CD13: estado y eventos de alergias | `node scripts/migrations/apply-cd13-allergy-state.js --apply` |
| 5 | CO11: agenda y configuracion de recetas por doctor | `node scripts/migrations/co11-professional-agendas-prescription-config.js` |
| 6 | S16: revision e identidad historica | `node scripts/migrations/s16-history-integrity.js --apply` |
| 7 | S16: versiones/permisos de seguimiento | `node scripts/migrations/s16-tracing-safety.js --apply` |
| 8 | S17: familias y alcance de indicadores, intake | `node scripts/migrations/s17-dashboard-permissions.js --apply` |

Estas migraciones parten del esquema MedSync existente; no instalan una base vacia. S10 y CO11 ejecutan al invocarse, sin bandera `--apply`. CO11 reemplaza cinco procedimientos y puede crear configuraciones por doctor; S16/S17 incluyen datos de configuracion o backfills. No tratarlos como pruebas de solo lectura. La opcion historica `--clear-dummy-appointments` de CO11 no es necesaria para actualizar y no debe formar parte del despliegue normal.

Los insumos SQL estan incluidos en `scripts/migrations` y `scripts/migrations/sql`. Las cinco definiciones de procedimientos son sentencias para el runner JavaScript, sin `DEFINER` fijo ni delimitadores de cliente; no pegarlas como un lote de cliente MySQL. Los exports al directorio hermano `u575589445_orrico` son opcionales: un clon independiente no lo necesita. Los runners conservan respaldos DDL bajo `../_schema_backups`; esos archivos no sustituyen un respaldo/restauracion de datos.

El workflow actual de despliegue copia `src`, archivos de paquetes y configuracion operativa; **no copia `scripts`**. Para una migracion en otro entorno se necesita el checkout completo o distribuir expresamente los runners y sus SQL con dependencias. Un push a `develop` no ejecuta el workflow de produccion, que se activa con `main` o ejecucion manual.

## Verificacion y limites

- Antes de esta entrega, S19 verifico el recorrido Profesional con datos ficticios y SQL real, 25 peticiones HTTP y rollback de fixtures. Las firmas fueron ficticias, sin correos ni WhatsApp reales.
- En la revision de publicacion: 20 regresiones backend sin base persistente y la suite Super Admin con tablas temporales MySQL aprobadas; se conserva una conexion a la vez. La auditoria de migraciones fue de solo lectura.
- Frontend: 20 regresiones de componentes/servicios, ocho comprobaciones D2, lint y build de produccion local aprobados. El build uso una URL HTTPS sintetica, no una API productiva; los artefactos temporales estan ignorados. Se actualizaron cinco comprobaciones estaticas D2 al flujo de sesiones vigente, sin cambiar comportamiento de la aplicacion.
- Las 20 regresiones backend sin DB y las 20 frontend tambien aprobaron en Node v22.23.3, obtenido de forma temporal mediante npm exec para verificar el motor declarado. No se cambio Node global ni los lockfiles; el build local y la prueba MySQL temporal se ejecutaron con el Node v20.15.1 instalado.
- `s10-settings-http-regression.js` no se completo en esta revision porque requiere `S10_QA_PASSWORD` para cuentas desechables. Las suites de permisos y sesiones con fixtures aprobaron; no se equiparan a ese login HTTP.
- Siguen pendientes la verificacion visual desktop/movil, teclado, entrega real de firmas, controles del almacenamiento cloud y ensayo de restauracion aislada documentados en S19. Publicar codigo no cierra esos pendientes ni constituye un lanzamiento con pacientes reales.

## Actualizacion de seguridad PO9 (2026-10-14)

Esta actualizacion requiere **Node >=22.12 y <23** antes de `npm ci`/arranque (sanitize-html 2.18.1). Generacion/consulta de documentos y frontend deben publicarse coordinados para proteger tambien la impresion y los historicos sin reescribir originales firmados. No requiere SQL ni backfill.

El parser general admite 1 MiB, autenticacion 32 KiB. Cargas ampliadas se leen despues de sesion/CSRF/tenant: imagen clinica 16 MiB; perfiles/firmas/paciente legacy 4 MiB; plantillas 8 MiB; configuracion receta 10 MiB. Son limites del cuerpo con base64 incluido. La firma publica valida frecuencia y vigencia del enlace antes de leer hasta 4 MiB; la firma final revalida bajo transaccion. Se rechazan cuerpos comprimidos y se devuelve 413 para exceso de tamano. Ajustar el proxy de forma consistente; no restaurar el limite global de 90 MB.

Regresiones principales: `node scripts/qa/document-html-security-regression.js`, `node scripts/qa/request-body-security-regression.js`, `node scripts/qa/security-dependency-regression.js`. Auditoria runtime backend: 15 avisos -> 1 bajo AWS v2, mitigado con region validada, sin criticos/altos/moderados. Persisten avisos de herramientas de desarrollo y frontend legacy. No equivale a cierre global de seguridad: TLS, privacidad cloud y restauracion siguen pendientes. Reporte completo PO9 en el roadmap Platform operations del workspace.

## Actualizacion de odontograma CO15-CO17 (2026-10-16)

Publicar backend y frontend coordinados: el DAO v1 usa SQL parametrizado y transacciones para evitar el conflicto de collations de los procedimientos anteriores; no requiere DDL ni reemplazar procedimientos. El frontend incluye creacion, editor de diagnostico, historial y confirmaciones, con proteccion contra doble envio y respuestas tardias de otra visita.

Verificar el catalogo `cat_tooth` del entorno objetivo: se requieren 32 posiciones permanentes y 20 temporales. La reparacion del catalogo vacio se verifico en desarrollo; un push no modifica los catalogos de otros entornos. El helper `node scripts/qa/restore-odontogram-tooth-catalog.js` inspecciona sin escribir por defecto. En un entorno QA confirmado, `--apply` agrega solo posiciones faltantes y genera respaldo con SHA-256 bajo `_schema_backups` junto al checkout; aborta ante conflictos o referencias huerfanas. El ejecutable bloquea entornos productivos y no debe emplearse como migracion automatica de produccion.

`node scripts/qa/co15-odontogram-live.js` crea fixtures y prueba HTTP/MySQL; reservarlo para QA, no ejecutarlo como health check ni durante un despliegue. Las regresiones aisladas del frontend son `odontogram-flow-regression.cjs`, `odontogram-dialog-regression.cjs` y `odontogram-editor-regression.cjs`. Los reportes CO15/CO16/CO17 del workspace conservan la evidencia funcional y visual.

## Recuperacion

Para revertir codigo publicado, preparar commits de reversion coordinados de backend/frontend, conservando el historial de Git y los datos. No eliminar snapshots/eventos de documentos ni columnas con informacion historica para resolver un problema de interfaz. MySQL puede confirmar DDL implicitamente: si una migracion falla, inspeccionar el paso aplicado y el respaldo antes de reintentar; no asumir que un rollback transaccional deshizo todo el esquema.
