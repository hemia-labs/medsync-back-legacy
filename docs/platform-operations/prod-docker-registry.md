# Despliegue de MedSync PROD por digest

El VPS de producción descarga desde `registry.hemia.cloud/medsync/prod-backend` con la cuenta lectora `medsync-prod-pull`. Docker guarda la credencial en `/srv/medsync-prod/docker`, accesible solo para root. El registry concede lectura por método HTTP y no limita los lectores por repositorio. La cuenta no pertenece al archivo de escritores. Si se regeneran los hashes del registry, reincorporar la entrada `medsync-prod-pull` desde su copia protegida en `/opt/hemia/registry/auth/medsync-prod-pull.htpasswd`.

El workflow manual **Build MedSync production image** ejecuta las regresiones en `main`, publica la imagen Linux amd64 y escribe su digest en el resumen. Configurar `PROD_REGISTRY_USERNAME` y `PROD_REGISTRY_PASSWORD` en el environment `prod` con una cuenta escritora. Conservar la credencial de escritura en CI. La imagen no contiene la configuración del servidor.

Instalar `ops/prod/deploy.sh` y `ops/prod/compose.yml` como root en `/srv/medsync-prod/ci`. PM2 y Docker leen `/srv/medsync/backend/shared/.env.production`, un archivo regular de `medsync-deploy` con modo `0600`. El script de Docker lee el archivo como ese usuario y le entrega a Compose una copia temporal privada. El contenedor usa UID/GID 1001, el mismo puerto 3009 de PM2 y los directorios compartidos de archivos temporales y logs. Antes de habilitar el registro, configurar en `.env.production` la ruta `/srv/medsync-prod/security/registration-password-blocklist.json` y su SHA-256. Docker monta ese directorio en la misma ruta y en solo lectura.

```sh
sudo bash /srv/medsync-prod/ci/deploy.sh preflight sha256:<digest>
sudo bash /srv/medsync-prod/ci/deploy.sh deploy sha256:<digest>
sudo bash /srv/medsync-prod/ci/deploy.sh rollback
```

`preflight` comprueba la versión activa, valida Compose y descarga la imagen sin sustituir el proceso activo. El primer `deploy` requiere una ventana de cambio porque PM2 y Docker usan el mismo puerto. El workflow de PM2 solo despliega por ejecución manual. Tras el corte, usar `deploy.sh rollback` para volver a PM2 si corresponde.

Si el despliegue falla, el script intenta restaurar la versión anterior. Conserva el release de PM2 para el primer rollback y después conserva el digest anterior en el VPS. `rollback` puede restaurar esa versión aunque la activa falle en `/readyz`. Antes de guardar un cambio, el script comprueba la salud y el identificador de la versión que arrancó en el puerto local y por el proxy HTTPS. Las migraciones y escrituras de MySQL requieren su propio procedimiento de recuperación.

Para versionar el backend, los tags de QA en el registry identifican imágenes de CI. Los tags Git y GitHub Releases pueden llevar versiones y notas de Changesets en un flujo separado. El paquete es privado y puede versionarse sin publicarlo en npm. Las imágenes permanecen en el registry, y el digest aprobado identifica qué artefacto se promueve a producción.
