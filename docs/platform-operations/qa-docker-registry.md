# MedSync QA con Docker y el registry privado de Hemia VPS DEV

El contenedor ejecuta un proceso Node 22 sin privilegios. La imagen incluye código y dependencias de producción. GitHub Actions construye y publica la imagen en `registry.hemia.cloud` cuando se actualiza `develop`. El host de QA activa la imagen por digest. MySQL, el proxy HTTPS y la configuración de QA viven fuera del contenedor.

## Publicación, despliegue y rollback

El workflow **Deploy MedSync QA to Hemia VPS DEV** ejecuta las regresiones en PRs a `develop`. En pushes a `develop`, construye la imagen Linux amd64, la publica en `registry.hemia.cloud/medsync/qa-backend` y activa el digest en Hemia VPS DEV. El último paso verifica el digest y `/readyz` desde fuera del VPS.

El environment `qa-registry` está restringido a `develop`. Usa `REGISTRY_USERNAME` y `REGISTRY_PASSWORD` para publicar, `QA_SSH_KEY` para solicitar una operación de QA y `QA_KNOWN_HOSTS` para verificar el servidor. La clave SSH está restringida a un comando en el host que acepta únicamente desplegar un digest del namespace de MedSync QA o revertir la última imagen. El host descarga con una credencial lectora y conserva su entorno en `/srv/medsync-qa/runtime.env` con permisos 0600. Antes del primer corte se normaliza el entorno de QA del servidor, `/srv/medsync/backend/shared/qa.env`, al formato literal que consume Compose. Los scripts de operación residen en `/srv/medsync-qa/ci`, propiedad de root.

Docker escucha en el puerto `3009` usando la red del host para conservar el acceso local a MySQL y el proxy existente. Ejecuta la aplicación como el usuario de QA y comparte sus archivos y logs persistentes. En el primer corte, CI descarga las dos imágenes antes de detener MedSync QA en PM2. Levanta la imagen inicial, despliega el digest nuevo, prueba volver al inicial y reactiva el nuevo. Si el corte falla, recupera PM2. Tras confirmar Docker, retira solo la entrada PM2 de MedSync QA y conserva su última release en disco.

Para revertir desde GitHub Actions, seleccionar `develop` y la operación `rollback` en el workflow. El host conserva los tres digests sanos más recientes y verifica la imagen restaurada por el puerto local y por HTTPS. Si un proceso termina abruptamente y deja el directorio vacío `deploy.lock`, comprobar primero que no hay un despliegue en curso. Aplicar migraciones compatibles con ambas imágenes para conservar las escrituras entre versiones. Si una migración impide ejecutar la imagen anterior, seguir el procedimiento MySQL.

## Recuperar MySQL

1. Usar archivos MySQL `[client]` distintos para origen y destino, con permisos 0600. Usar un esquema dedicado, tablas InnoDB, binlogs activos y un usuario con los permisos de lectura, rutinas y coordenadas que exige `mysqldump --source-data=2`. Evitar DDL durante el backup. Programar el backup diario y generar otro antes de migraciones de riesgo. Guardar el digest y la versión de esquema junto al ID del backup.
2. Copiar cada directorio completado y sus binlogs continuos a un bucket de backups cifrado fuera del host y separado del bucket de aplicación. Archivar los binlogs conforme se cierran o transmitirlos continuamente si el objetivo de pérdida de datos requiere una ventana menor. Verificar checksums y alarmar si falta un backup o un tramo de logs. Para una migración de riesgo, comprobar que el backup y su cadena de logs son accesibles antes de empezar.
3. Ante corrupción o migración incompatible, detener escrituras y jobs y conservar el estado actual. Preparar otro servidor MySQL aislado, de versión compatible, con `event_scheduler=OFF` y el esquema aún sin crear. Preparar las cuentas requeridas por los `DEFINER`. Restaurar allí el snapshot. El script compara el UUID del servidor, valida checksums y rechaza restaurar sobre un esquema existente.

```bash
bash ops/qa/mysql-recovery.sh backup /secure/qa-source.cnf medsync_qa /secure/backups
bash ops/qa/mysql-recovery.sh restore /secure/qa-recovery.cnf medsync_qa "$backup_directory"
```

Con un cliente `mysqlbinlog` compatible con la versión del servidor, leer archivo y posición inicial del comentario `CHANGE REPLICATION SOURCE TO` del dump. Identificar la posición anterior a la transacción o DDL dañino. Revisar los logs archivados en orden y aplicar los eventos solo en el destino aislado, usando una sola conexión. En una instancia compartida, inspeccionar también eventos entre esquemas antes de aplicar el filtro.

```bash
set -o pipefail
mysqlbinlog --verify-binlog-checksum --database=medsync_qa \
  --start-position="$start_position" --stop-position="$stop_position" \
  "${ordered_binlogs[@]}" |
  mysql --defaults-file=/secure/qa-recovery.cnf medsync_qa
```

Comprobar que la imagen elegida arranca contra la base recuperada. Verificar citas, documentos y sus adjuntos versionados. Conciliar escrituras válidas posteriores y revisar sesiones y enlaces antes de aprobar el cambio de conexión. Conservar la base original aislada hasta terminar la validación. La restauración lógica cubre MySQL. Los adjuntos requieren conservar las versiones correspondientes en S3.

## Retención

| Artefacto | Política inicial para QA |
| --- | --- |
| Imágenes del host | Activa y dos anteriores sanas. El script elimina las que salen del historial solo tras validar la nueva imagen. |
| Registry privado | Revisar semanalmente las etiquetas de más de 30 días y conservar como mínimo las últimas 10 versiones sanas. Proteger los digests desplegados, el historial de rollback y las versiones fijadas para recuperación. La limpieza del servidor queda a cargo del operador del registry después de verificar esas referencias y el mecanismo de borrado de su instalación. |
| MySQL y adjuntos | Mantener 30 días recuperables fuera del VPS. Conservar el último backup base anterior al inicio de la ventana y los binlogs consecutivos desde ese backup. Ampliar la retención si faltan backups verificados. Conservar los adjuntos y sus versiones durante la misma ventana. Ensayar una restauración cada mes. |
| Logs | Docker rota stdout y stderr con hasta tres archivos de 10 MB por contenedor. Si la aplicación escribe archivos en el volumen de logs, configurar su rotación en el host. |

En QA se usa la referencia completa del registry privado por digest.
