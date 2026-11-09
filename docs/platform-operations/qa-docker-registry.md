# MedSync QA con Docker y el registry privado de Hemia VPS DEV

El contenedor ejecuta un proceso Node 22 sin privilegios. La imagen incluye código y dependencias de producción. GitHub Actions construye y publica la imagen en `registry.hemia.cloud` cuando se actualiza `develop`. El host de QA activa la imagen por digest. MySQL, el proxy HTTPS y la configuración de QA viven fuera del contenedor.

## Publicar y activar

1. Crear el environment GitHub `qa-registry` para `develop`. Configurar la variable `REGISTRY_USERNAME` con la cuenta escritora y `REGISTRY_PASSWORD` como secreto del environment. El runner se conecta por HTTPS directo a `registry.hemia.cloud`, en Hemia VPS DEV. La ruta de la imagen es `registry.hemia.cloud/medsync/qa-backend`.
2. El flujo **Publish MedSync QA image to private registry** ejecuta las regresiones y publica para Linux amd64 en cada push a `develop`. El resumen muestra la referencia completa por digest. El disparo manual también está disponible cuando el workflow existe en la rama por defecto.
3. En el host amd64 de QA, instalar Docker Compose 2.30 o superior y curl. Configurar acceso de red al registry y autenticación con su cuenta lectora. Copiar `ops/qa` desde el commit publicado. Guardar el entorno de QA con permisos 0600 fuera del repo, en formato literal `KEY=valor` sin comillas envolventes. Configurar una dirección privada de MySQL alcanzable desde el contenedor y limitar el acceso a la red de QA. El `localhost` del contenedor solo alcanza al contenedor. Usar credenciales o un rol de QA para S3 y SES, orígenes HTTPS de QA y configuración de cookies apropiada.
4. Reservar `127.0.0.1:3010` para Docker. Configurar la confianza en el proxy según su dirección real y probar el flujo HTTPS y las cookies antes de mover la ruta de QA. Para el primer cambio, pausar los jobs del candidato o detener el proceso PM2 anterior antes de habilitar los jobs en Docker. El backend ejecuta jobs en proceso y usa estado local. El cambio normal recrea una instancia y puede interrumpir brevemente la API.
5. Activar el digest del resumen y verificar `/readyz` por HTTPS a través del proxy. La activación conserva las tres imágenes sanas más recientes en el estado del host, comprueba el digest a través del puerto local y restaura automáticamente el digest activo anterior si falla el candidato.

```bash
export MEDSYNC_QA_STATE_DIR=/srv/medsync-qa/state
export MEDSYNC_QA_ENV_FILE=/srv/medsync-qa/runtime.env
bash ops/qa/deploy.sh "registry.hemia.cloud/medsync/qa-backend@$digest"
bash ops/qa/deploy.sh rollback
```

Si el proceso muere sin ejecutar la limpieza, confirmar que no hay otro despliegue, quitar el directorio vacío `deploy.lock` y reactivar el primer digest del archivo `images`. Después de un rollback, verificar `/readyz` por HTTPS y revisar los logs. Aplicar migraciones compatibles con ambas imágenes para conservar las escrituras entre versiones. Si una migración impide ejecutar la imagen anterior, seguir el procedimiento MySQL.

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

Para el ensayo local se puede usar `MEDSYNC_QA_LOCAL_TEST=1` con IDs de imágenes construidas localmente. En QA se usa la referencia completa del registry privado por digest.
