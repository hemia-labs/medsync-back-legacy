# Versiones del backend de MedSync

Agrega un Changeset con `npm run changeset` a los PR que deban aparecer en las notas. Elige `patch` para correcciones, `minor` para funcionalidad compatible y `major` para cambios que rompen compatibilidad. Describe qué cambió para quien usa el backend.

- **`develop`**: un push con Changesets pendientes publica una prerelease después de que el workflow de QA confirme en `/readyz` que el digest desplegado está activo y sano. El tag apunta al commit del push y usa el número de ejecución de ese workflow, por ejemplo `v0.0.2-rc.31`. Reintentar la misma ejecución conserva el tag. Los archivos de Changesets quedan en la rama hasta preparar la estable.
- **`main`**: cuando recibe Changesets, GitHub Actions abre o actualiza el PR **Release: versionar backend**. Ese PR actualiza `package.json`, `package-lock.json` y `CHANGELOG.md` y consume los Changesets incluidos. Al fusionarlo, Actions publica la versión estable, por ejemplo `v0.0.2`, con las notas de ese bloque del changelog. Después, fusiona `main` de vuelta a `develop` para que la siguiente prerelease use la versión estable vigente y no repita los Changesets ya publicados.

Mantén `CHANGELOG.md` generado por Changesets. La release estable usa el commit de `main` que introdujo esa versión en `package.json` y toma las notas del mismo commit. Los tags y releases existentes se conservan.

La GitHub App `hemia-ci` crea o actualiza `changeset-release/main` y abre el PR de versión hacia `main`. La instalación de la app debe incluir este repositorio. El workflow usa `RELEASE_APP_CLIENT_ID` y `RELEASE_APP_PRIVATE_KEY` de la organización para generar un token temporal limitado a este repositorio, con permisos de escritura en Contents y Pull requests.

GitHub Releases contiene las notas y los archivos fuente que GitHub genera. El flujo de versiones no adjunta imágenes, no publica en npm y no controla los despliegues de QA o producción.
