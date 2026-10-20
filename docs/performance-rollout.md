# Rendimiento, paginacion e indices PO12-PO15

Los cambios reducen las consultas repetidas de Inicio/dashboard, evitan pedir una conexion fuera de transacciones clinicas y paginan pacientes, documentos, recetas y planes. Las imagenes usan buffers validados de hasta 5 MiB por defecto, sin temporales sincronos; `MAX_IMAGE_UPLOAD_BYTES` permite ajustar ese limite. Backend Node >=22.12 <23.

## Entrega coordinada

Publicar backend antes que frontend: este usa `/api/px/search-page`, `/api/business/dashboard/overview` y los contratos paginados. Las APIs anteriores conservan sus respuestas cuando no se solicita pagina. Los listados nuevos usan 10 documentos/recetas y 5 planes anteriores mas el plan activo. El contenido completo de cada documento/plan visible sigue disponible para firmas e impresion; no existe un limite total de bytes por pagina.

La publicacion a develop/PR no despliega. Los workflows actuales se ejecutan al integrar en main o mediante invocacion manual. No fusionar ni disparar un workflow como parte de la preparacion del PR.

## Indices MySQL

El 2026-10-19 se crearon y verificaron ocho indices de PO14 en el MySQL configurado del workspace. Una nueva conexion confirmo los ocho y cero pendientes. Esto no prueba que otra base ya los tenga, ni demuestra capacidad con cinco usuarios.

`Scripts_/20261019_po15_performance_indexes.sql` registra el DDL aplicado. No repetirlo sin inspeccionar: las instrucciones ADD INDEX fallan si el nombre ya existe. Usar el operador idempotente, con las dependencias y el entorno del checkout configurados por el cargador existente:

```sh
node scripts/ops/po15-apply-indexes.js --database NOMBRE_DE_BASE
# Revisar el JSON resultante y confirmar que corresponde al destino esperado.
node scripts/ops/po15-apply-indexes.js --database NOMBRE_DE_BASE --apply --inspection RUTA_INSPECCION.json
```

Por defecto solo inspecciona. La aplicacion requiere base explicita e inspeccion previa de la misma huella del destino/lista de candidatos. Usa una conexion y DDL secuencial `ALGORITHM=INPLACE, LOCK=NONE`, con espera de bloqueo de sesion de 5 segundos. No aplica COPY, borra indices ni continua tras un error.

Los SELECT para EXPLAIN viajan dentro del repo en `scripts/ops/po15-query-templates.json`. No requiere el directorio docs del workspace. En un checkout independiente guarda evidencias y respaldos de metadatos en `.local/po15/` (ignorado por Git); `--output-dir RUTA` permite elegir otro directorio. En el workspace mantiene `docs/platform-operations/evidence/PO15` y `_schema_backups`. Conservar los respaldos/diario en almacenamiento persistente antes de cambiar de checkout o contenedor. No son respaldos de los datos.

El operador compara equivalencias completas y visibles y verifica cada indice creado. Si una operacion queda fallida o sin confirmacion, inspeccionar la base y el diario antes de reintentar. El rollback generado esta comentado y solo enumera indices creados por esa invocacion; retirarlos requiere una intervencion explicita.

## Validacion y limites

```sh
node scripts/qa/po12-pool-home-regression.js
node scripts/qa/po12-patient-page-regression.js
node scripts/qa/po13-dashboard-overview-regression.js
node scripts/qa/po13-image-upload-regression.js
node scripts/qa/po14-list-paging-regression.js
node scripts/qa/po14-index-review-regression.js
node scripts/qa/po15-index-apply-regression.js
```

Son pruebas aisladas; `po14-list-paging-regression.js --http` agrega HTTP localhost con SQL simulado. No ejecutar pruebas live de otros modulos durante un despliegue. Las opciones `--record` de QA se usan para documentacion del workspace y no son necesarias para los checks anteriores.

PO14 verifico paginacion/permisos, lotes simulados de 1/3/5/10 usuarios y visual de cuatro vistas en escritorio/movil. EXPLAIN real de PO15 usa los nuevos indices en pacientes, planes, tratamientos y retencion; los planes de recetas mantienen ALL con tablas pequenas. Los costos del optimizador no son latencia. Faltan p95, errores, CPU/RSS y capacidad bajo carga; no aumentar pool/workers ni cambiar buffer pool sin medir.

Se mantienen los requisitos de Node22, API HTTPS, SES, documentos legales y gates S18/S19 del [runbook del piloto](professional-pilot-rollout.md).
