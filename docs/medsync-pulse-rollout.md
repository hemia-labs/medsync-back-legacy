# MedSync Pulse: revision integrada P6

Esta entrega publica el estado local autorizado de Pulso junto con los cambios
conservados de agenda CO21, alcance Individual/Profesional UX20 y permisos de
plantillas. No cambia ni reconstruye lo refinado en otra ventana. El historial
SDD canonico permanece en `F:/HemiaAssistantGlobal/docs/dashboard-ux/phases/`;
este archivo es el runbook de entrega, no otra especificacion.

## Alcance revisable

- Dominio versionado, snapshot consistente, incidencias paginadas, permisos
  efectivos y aislamiento por negocio. Configuracion, frescura y cobertura
  independientes del estado operativo; sin puntuacion arbitraria.
- Cache acotada/single-flight, TTL/vencimientos e invalidacion postcommit.
- Historial agregado minimo, claims/leases SQL, retencion y metricas sanitizadas.
- Agenda CO21: revisiones, reintentos/idempotencia, reagendado atomico y auditoria;
  conserva citas historicas y contratos del frontend coordinado.
- UX20: alcance institucional autorizado en Individual/Profesional; Clinica y
  usuarios restringidos conservan sus limites. Correccion de permisos/estado de
  plantillas clinicas incluida tal como existe en el checkout revisado.

## El job de Pulso existe; no es un EVENT de MySQL

`src/jobs/businessPulse.job.js` inicia un timer Node cada60s, despues del inicio
DB exitoso de `src/index.js`, **solo si `PULSE_JOBS_ENABLED=true`**. Default apagado.
No requiere cron del sistema, `CREATE EVENT`, Redis, colas ni WebSockets.
`event_scheduler=ON` de MySQL no lo habilita.

La ventana diaria es `[18:00,18:05)` en la zona IANA general del negocio.
Procesa hasta25candidatos por tick, uno por vez; claims unicos y lease30s.
Persiste agregados sin pacientes/acciones. La lectura oculta capturas expiradas
a30dias y el job purga hasta100por tick. Sin job puede retrasarse la eliminacion
fisica; no se reconstruyen los dias perdidos ni se equiparan a cero.

La migracion `Scripts_/20261020_pulse_p2_up.sql` instala tabla/catalogo, no
concesiones ni activacion. Verificar destino/respaldo antes de cualquier DDL;
no ejecutar down para desactivar (elimina historial). Cuatro permisos efectivos
son necesarios: `pulse.view.business`, `dashboard.scope.all`,
`dashboard.operations`, `dashboard.clinical`; ser Administrador no los sustituye.
Las acciones/desgloses siguen requiriendo sus permisos de modulo.

## Preflight y activacion posterior

1. Identificar el destino y respaldar antes de migrar. Comprobar tabla,
   PRIMARY(id_business,local_date,cut_kind), idx_pulse_expiry y permisos efectivos.
2. Confirmar soporte IANA MySQL (por ejemplo CONVERT_TZ para UTC,
   America/Mexico_City y America/Tijuana), configuraciones generales validas,
   reloj y proceso disponible durante la ventana. No reemplazar zonas por
   offsets fijos ni ampliar permisos para hacer pasar el preflight.
3. Cerrar o resolver expresamente gates de operacion/rendimiento y autorizar el
   destino/negocios. La pausa de p95 no es una aprobacion del presupuesto.
4. Solo entonces establecer `PULSE_JOBS_ENABLED=true` en el entorno del proceso
   autorizado y reiniciarlo de forma controlada. No modificar configuracion de
   otros procesos ni activar otro worker/scheduler por duplicado.
5. Verificar una captura real a18h, ausencia de PHI y alertas/retencion.
   `PULSE_METRICS_LOG_ENABLED=true` es un control separado, opt-in; no activa el job.
   No declarar activo un proceso existente solo por leer un env de disco.

Para detener nuevas capturas: retirar el flag/reiniciar el proceso autorizado;
conservar tabla y grants. Registrar el retraso de purga fisica. El despliegue,
la activacion y las escrituras en destinos habituales no se realizan al abrir PR.

## Evidencia y pendientes

P5_CLOSE:16criterios integrados aprobados en QA sintetica (retornos2,
escritores5,accesibilidad/recursos4,operacion5), tres suites con dobles por
separado; build real del frontend actual. Las consultas de candidates/purge
del ensayo operativo llevan filtro QA exacto y reloj controlado, sin scheduler
global ni prueba de cluster. No equivalen a operacion desplegada.

Pendientes: p95 frio V2/OP02 y presupuestos completos **pausados por el usuario**;
writers legacy restantes, HTTPS equivalente/multiproceso, responsable operativo,
backup/restauracion/rollback de destino y validacion humana. Fuente frontend
con hallazgo de zoom CSS200% pendiente de comprobacion nativa, AT/dispositivos.
La matriz completa de aceptacion no esta cerrada. PR para revision; no listo
para despliegue ni prueba de capacidad productiva. No ampliar limites para
convertir un resultado pendiente en aprobado.
