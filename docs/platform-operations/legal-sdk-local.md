# Validar el registro con el SDK de Legal

MedSync instala `@hemia/legal` desde npm con la versión exacta indicada en el manifiesto y el lockfile. El SDK consulta documentos y entrega la evidencia. MedSync valida las confirmaciones y mantiene la cola de reintentos.

Desde la raíz del backend, con Node 22 y Docker:

```sh
npm ci
npm run qa:registration-legal
```

La prueba usa MySQL desechable y respuestas sintéticas de los servicios externos.

El registro pide a Legal el conjunto vigente en cada carga. MedSync descarga en paralelo los HTML de los orígenes permitidos y verifica el SHA-256 de cada archivo antes de firmar el contexto del intento. Hemia Legal reutiliza la misma resolución de las publicaciones para calcular el snapshot y devolver sus archivos.
