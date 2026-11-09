# Versiones del backend de MedSync

Agrega un Changeset con `npm run changeset` a los PR que deban aparecer en las notas. Elige `patch` para correcciones, `minor` para funcionalidad compatible y `major` para cambios que rompen compatibilidad. Describe qué cambió para quien usa el backend.

- **`develop`**: un push con Changesets pendientes publica una prerelease, por ejemplo `v0.0.2-rc.17`, con las notas que calcula Changesets. El tag apunta al commit del push y usa el número de la ejecución, de modo que reintentar la misma ejecución conserva el tag. El cálculo es temporal: los archivos de Changesets quedan en la rama hasta preparar la estable.
- **`main`**: cuando recibe Changesets, GitHub Actions abre o actualiza el PR **Release: versionar backend**. Ese PR actualiza `package.json`, `package-lock.json` y `CHANGELOG.md` y consume los Changesets incluidos. Al fusionarlo, Actions publica la versión estable, por ejemplo `v0.0.2`, con las notas de ese bloque del changelog. Después, fusiona `main` de vuelta a `develop` para que la siguiente prerelease use la versión estable vigente y no repita los Changesets ya publicados.

Mantén `CHANGELOG.md` generado por Changesets. La release estable usa el commit de `main` que introdujo esa versión en `package.json` y toma las notas del mismo commit. Los tags y releases existentes se conservan.

Para el PR automático, habilita **Allow GitHub Actions to create and approve pull requests** en la configuración de Actions del repositorio, o configura `CHANGESETS_TOKEN` con permisos de escritura en Contents y Pull requests. Con el token predeterminado, GitHub puede pedir que se apruebe la ejecución del CI del PR automático.

GitHub Releases contiene las notas y los archivos fuente que GitHub genera. El flujo de versiones no adjunta imágenes, no publica en npm y no controla los despliegues de QA o producción.
