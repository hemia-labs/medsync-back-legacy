# Despliegue de MedSync PROD por digest

El VPS de producción descarga desde `registry.hemia.cloud/medsync/prod-backend` con la cuenta lectora `medsync-prod-pull`. Docker guarda la credencial en `/srv/medsync-prod/docker`, accesible solo para root. El registry concede lectura por método HTTP y no limita los lectores por repositorio. La cuenta no pertenece al archivo de escritores. Si se regeneran los hashes del registry, reincorporar la entrada `medsync-prod-pull` desde su copia protegida en `/opt/hemia/registry/auth/medsync-prod-pull.htpasswd`.

El merge del PR de Changesets activa **MedSync backend releases**. El flujo ejecuta las regresiones, publica la imagen Linux amd64 del commit de versión y adjunta `medsync-image.json` a la release estable. Un reintento reutiliza la imagen del tag si su etiqueta OCI corresponde al mismo commit. Configura `PROD_REGISTRY_USERNAME` y `PROD_REGISTRY_PASSWORD` en el entorno `prod` con una cuenta escritora. La imagen no contiene la configuración del servidor.

Instala `ops/prod/deploy.sh`, `ops/prod/compose.yml` y `ops/prod/host-ci.sh` como root en `/srv/medsync-prod/ci`. El despliegue de GitHub usa una clave dedicada, autorizada con `restrict,command="/srv/medsync-prod/ci/host-ci.sh"`. Configura `PROD_DOCKER_SSH_KEY` y `PROD_DOCKER_KNOWN_HOSTS` en el entorno `prod-deploy`, restringido a `main`. El comando forzado solo acepta un digest y un commit y comprueba que la etiqueta OCI coincida.

PM2 y Docker leen `/srv/medsync/backend/shared/.env.production`, un archivo regular de `medsync-deploy` con modo `0600`. El script de Docker lee el archivo como ese usuario y le entrega a Compose una copia temporal privada. El contenedor usa UID/GID 1001, el mismo puerto 3009 de PM2 y los directorios compartidos de archivos temporales y logs. Antes de habilitar el registro, configurar en `.env.production` la ruta `/srv/medsync-prod/security/registration-password-blocklist.json` y su SHA-256. Docker monta ese directorio en la misma ruta y en solo lectura.

Para aprobar una activación, ejecuta **Deploy published MedSync release** desde `main` con el tag estable. El workflow verifica que el tag y el commit del manifiesto coincidan, activa el digest y comprueba que `/readyz` reporte la misma imagen. Para reintentar o volver a una release anterior que ya tenga manifiesto, ejecuta el mismo workflow con el tag correspondiente. Para recuperar una imagen anterior a este flujo, usa el procedimiento por SSH.

```sh
sudo bash /srv/medsync-prod/ci/deploy.sh preflight sha256:<digest>
sudo bash /srv/medsync-prod/ci/deploy.sh deploy sha256:<digest>
sudo bash /srv/medsync-prod/ci/deploy.sh rollback
```

`preflight` comprueba la versión activa, valida Compose y descarga la imagen sin sustituir el proceso activo. El primer `deploy` requiere una ventana de cambio porque PM2 y Docker usan el mismo puerto. Usa `deploy.sh rollback` para volver al release anterior, incluido PM2 cuando corresponda.

Si el despliegue falla, el script intenta restaurar la versión anterior. Conserva el release de PM2 para el primer rollback y después conserva el digest anterior en el VPS. `rollback` puede restaurar esa versión aunque la activa falle en `/readyz`. Antes de guardar un cambio, el script comprueba la salud y el identificador de la versión que arrancó en el puerto local y por el proxy HTTPS. Las migraciones y escrituras de MySQL requieren su propio procedimiento de recuperación.

Para que Amazon SES entregue los avisos de rebotes y quejas al buzón de soporte, configura `EMAIL_SES_FEEDBACK_FORWARDING_ADDRESS=soporte@medsync.mx` en `.env.production`. Conserva el reenvío de retroalimentación habilitado en la identidad `medsync.mx`. Esta variable es opcional y se configura por separado de `EMAIL_REPLY_TO`, que recibe las respuestas de los usuarios. Verifica la entrega de los avisos con el simulador de SES.

Para versionar el backend, los tags de QA en el registry identifican imágenes de CI. Los tags Git y GitHub Releases pueden llevar versiones y notas de Changesets en un flujo separado. El paquete es privado y puede versionarse sin publicarlo en npm. Las imágenes permanecen en el registry, y el digest aprobado identifica qué artefacto se promueve a producción.
