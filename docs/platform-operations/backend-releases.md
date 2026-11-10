# Versiones del backend de MedSync

Agrega un Changeset con `npm run changeset` a los PR que deban aparecer en las notas. Elige `patch` para correcciones, `minor` para funcionalidad compatible y `major` para cambios que rompen compatibilidad. Describe qué cambió para quien usa el backend.

- **`develop`**: un push con Changesets pendientes publica una prerelease después de que el workflow de QA confirme en `/readyz` que el digest desplegado está activo y sano. El tag apunta al commit del push y usa el número de ejecución de ese workflow, por ejemplo `v0.0.2-rc.31`. Reintentar la misma ejecución conserva el tag. Los archivos de Changesets quedan en la rama hasta preparar la estable.
- **`main`**: al integrar cambios funcionales, GitHub Actions abre o actualiza el PR **Release: versionar backend**. Ese PR actualiza `package.json`, `package-lock.json` y `CHANGELOG.md` y consume los Changesets incluidos. Consérvalo abierto hasta aprobar la versión. Al fusionarlo, Actions valida el commit de versión, publica su imagen Docker y crea la release estable con el digest. Después de publicar la versión, vuelve a integrar `main` en `develop` para que QA use la base estable y no repita los Changesets consumidos.

Mantén `CHANGELOG.md` generado por Changesets. La release estable usa el commit de `main` que introdujo esa versión en `package.json` y toma las notas del mismo commit. Los tags y releases existentes se conservan.

La GitHub App `hemia-ci` crea o actualiza `changeset-release/main` y abre el PR de versión hacia `main`. La instalación de la app debe incluir este repositorio. El workflow usa `RELEASE_APP_CLIENT_ID` y `RELEASE_APP_PRIVATE_KEY` de la organización para generar un token temporal limitado a este repositorio, con permisos de escritura en Contents y Pull requests.

Las imágenes permanecen en el registry. Cada nueva release estable adjunta `medsync-image.json` con el tag, SHA de Git y referencia de imagen por digest. El responsable activa esa versión ejecutando **Deploy published MedSync release** desde `main` con el tag exacto. Consulta el [procedimiento de producción](prod-docker-registry.md).
