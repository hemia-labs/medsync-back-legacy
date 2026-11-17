# Plantilla inicial de historia clínica

Prerrequisito de datos para una instalación nueva. La consulta de formatos ya resuelve primero el formato propio del consultorio y después el formato del sistema. No crea datos en una lectura. Si ambas tablas están vacías, el cliente bloquea la primera historia porque no puede verificar el formato.

## Comprobar e instalar

Usar el cargador de entorno habitual del backend y la misma base de la API. No pasar contraseñas por argumentos ni registrar el entorno.

```sh
npm run migration:history-base
# Solo lectura; ready:false devuelve código 2.
npm run migration:history-base -- --apply --expect-database BASE_EXACTA --expect-hostname HOST_MYSQL_EXACTO --backup-directory /ruta/privada/_repo_backups/history-base-FECHA
npm run migration:history-base
```

Ejecutar en el aprovisionamiento antes de habilitar el servicio a usuarios; conservar la comprobación `ready:true` como evidencia de entrega. `--apply` exige el nombre real de la base y hostname de MySQL, no el nombre DNS del cliente. La instalación inserta únicamente la plantilla base canónica y su versión 1, en una transacción y bajo bloqueo de aplicación. Guarda previamente un manifiesto del estado vacío. No requiere DDL, parada de escritores, importación de pacientes ni configuración por cada consultorio.

Una plantilla del sistema activa y utilizable se conserva exactamente; no se actualiza al cambiar el código base. Las plantillas propias y snapshots históricos no se modifican. Una plantilla del sistema desactivada, eliminada o sin versión requiere revisión explícita: el script no la reactiva ni sustituye. Ante error de inserción se revierte la pareja completa. Puede repetirse y ejecutarse concurrentemente sin duplicarla.

## Verificación y recuperación

`npm run qa:history-base` verifica los controles sin red. `npm run qa:history-base-mysql` crea y elimina su propio contenedor MySQL 8.4 local, reproduce la ausencia, prueba rollback/concurrencia/reentrada y ejercita los DAO reales de resolución y snapshot, conservando formatos propios.

Después de instalar, abrir un consultorio sin formato personalizado: debe mostrar Historia clínica base, permitir crear un borrador y conservarlo al recargar. No implica autorización para emitir, firmar o finalizar sin los requisitos clínicos habituales.

No eliminar automáticamente la versión al revertir código: las historias nuevas pueden referenciarla. El backend anterior ya es compatible con estos datos. Si la instalación falla, la transacción revierte todo. Una retirada posterior de una versión usada requiere un lote específico que preserve referencias e historia; no utilizar DELETE ni restaurar la base completa como recuperación habitual.
