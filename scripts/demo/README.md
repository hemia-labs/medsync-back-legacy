# Cuenta Profesional de presentacion

`create-professional-showcase.js` prepara un tenant aislado: Consultorio Dental Alameda, una doctora titular y una asistente. Incluye 18 pacientes ficticios, agenda historica/actual/proxima, historias, recetas, planes, seguimientos e indicadores. Los textos visibles son naturales; las identidades no pertenecen a personas reales.

Ejecutar desde la raiz del backend con su entorno de desarrollo configurado:

```sh
# Ensayo completo: una conexion y rollback al terminar.
node scripts/demo/create-professional-showcase.js

# Crear definitivamente solo despues de revisar el ensayo.
node scripts/demo/create-professional-showcase.js --apply

# Login HTTP y lecturas de la cuenta nueva, sin imprimir claves/cookies.
node scripts/demo/verify-professional-showcase.js
```

No usar contra produccion. No modifica esquema ni limpia datos existentes; un tenant, slug o login ya existente aborta sin reemplazarlo. No reejecutar los seeds antiguos para actualizar esta cuenta. Las fechas se calculan desde el dia de ejecucion en `America/Mexico_City`; despues quedan fijas como actividad de ejemplo.

La cuenta de acceso se guarda en `.alameda-access.local`, ignorado por Git. Contiene contraseñas aleatorias independientes que nunca se imprimen en consola. No versionar ni pegar ese archivo en reportes. Si el commit pierde su respuesta, el archivo se conserva para recuperar el acceso y se debe verificar la BD antes de reintentar.

La doctora tiene un unico perfil profesional y acceso administrativo al consultorio. La asistente tiene capacidades acotadas; no puede emitir, firmar, finalizar historias ni ver finanzas. En Inicio/Dashboard, la doctora puede cambiar entre Mi actividad y Todo el consultorio para explorar ambos alcances.

Los correos usan `.example`, los pacientes no tienen telefonos utilizables y el telefono obligatorio de receta es `0000000000`. La pantalla de login exige telefono: los accesos son `0000001001` para la doctora y `0000001002` para la asistente, con sus respectivas claves del archivo local. No se envian correos ni WhatsApp durante la carga. Los consentimientos y firmas son ejemplos sinteticos para recorrer el producto; no corresponden a autorizaciones de personas.

Las escrituras clinicas pasan por los DAOs reales con SAVEPOINT dentro de la transaccion externa. Las fechas historicas se ajustan unicamente para los registros creados dentro del tenant nuevo. Se verifican tablas InnoDB, solapamientos de agenda, perfil unico, configuracion, Home y KPI antes del commit. El runner no sustituye una prueba visual en navegador.
