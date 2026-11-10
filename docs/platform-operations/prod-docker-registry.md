# Despliegue de MedSync PROD por digest

El VPS de producción descarga desde `registry.hemia.cloud/medsync/prod-backend` con la cuenta lectora `medsync-prod-pull`. Docker guarda la credencial en `/srv/medsync-prod/docker`, accesible solo para root. El registry concede lectura por método HTTP y no limita los lectores por repositorio. La cuenta no pertenece al archivo de escritores. Si se regeneran los hashes del registry, reincorporar la entrada `medsync-prod-pull` desde su copia protegida en `/opt/hemia/registry/auth/medsync-prod-pull.htpasswd`.

El workflow manual **Build MedSync production image** ejecuta las regresiones en `main`, publica la imagen Linux amd64 y escribe su digest en el resumen. Configurar `PROD_REGISTRY_USERNAME` y `PROD_REGISTRY_PASSWORD` en el environment `prod` con una cuenta escritora. Conservar la credencial de escritura en CI. La imagen no contiene la configuración del servidor.

Instalar `ops/prod/deploy.sh` y `ops/prod/compose.yml` como root en `/srv/medsync-prod/ci`. Provisionar `/srv/medsync-prod/prod.env` como archivo regular propiedad de root con modo 600 y revisar que sus valores correspondan a producción. El contenedor usa UID/GID 1001, el mismo puerto 3009 de PM2 y los directorios compartidos de archivos temporales y logs. Instalar la lista de contraseñas en `/srv/medsync-prod/security` y configurar su ruta dentro del contenedor (`/app/config/security/registration-password-blocklist.json`) y su SHA-256 en `prod.env` al habilitar el registro.

```sh
sudo bash /srv/medsync-prod/ci/deploy.sh preflight sha256:<digest>
sudo bash /srv/medsync-prod/ci/deploy.sh deploy sha256:<digest>
sudo bash /srv/medsync-prod/ci/deploy.sh rollback
```

`preflight` comprueba la versión activa, valida Compose y descarga la imagen sin sustituir el proceso activo. El primer `deploy` requiere una ventana de cambio porque PM2 y Docker usan el mismo puerto. Antes de ese corte, coordinar la desactivación del despliegue automático de PM2 desde GitHub para que otro run no vuelva a ocupar el puerto.

Si el despliegue falla, el script intenta restaurar la versión anterior. Conserva el release de PM2 para el primer rollback y después conserva el digest anterior en el VPS. `rollback` puede restaurar esa versión aunque la activa falle en `/readyz`. Antes de guardar un cambio, el script comprueba la salud y el identificador de la versión que arrancó en el puerto local y por el proxy HTTPS. Las migraciones y escrituras de MySQL requieren su propio procedimiento de recuperación.

Para que Amazon SES entregue los avisos de rebotes y quejas al buzón de soporte, configura `EMAIL_SES_FEEDBACK_FORWARDING_ADDRESS=soporte@medsync.mx` en `.env.production`. Conserva el reenvío de retroalimentación habilitado en la identidad `medsync.mx`. Esta variable es opcional y se configura por separado de `EMAIL_REPLY_TO`, que recibe las respuestas de los usuarios. Verifica la entrega de los avisos con el simulador de SES.

Para versionar el backend, los tags de QA en el registry identifican imágenes de CI. Los tags Git y GitHub Releases pueden llevar versiones y notas de Changesets en un flujo separado. El paquete es privado y puede versionarse sin publicarlo en npm. Las imágenes permanecen en el registry, y el digest aprobado identifica qué artefacto se promueve a producción.
