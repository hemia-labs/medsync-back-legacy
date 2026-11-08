# Registro y acceso por correo

## Correo de bienvenida al iniciar la prueba

La primera activación de la prueba Profesional registra `registration.trial_welcome` en `registration_outbox` dentro de la misma transacción, tanto al verificar el correo como al completar la recuperación de una cuenta pendiente. La clave por consultorio evita eventos duplicados y la cola existente no requiere otra migración. El proceso comprueba que la prueba sigue vigente y que el destinatario corresponde al correo verificado de la cuenta.

Configurar `EMAIL_REGISTRATION_WELCOME_TEMPLATE` con `medsync-dev-registration-welcome` o `medsync-prod-registration-welcome` según la cuenta SES, y `PUBLIC_APP_URL` con el origen HTTPS de MedSync. El proceso usa el remitente de autenticación y construye el enlace a `/login` en el servidor. La duración (`trialDurationLabel`) y el vencimiento (`trialEndsAtLabel`) se calculan con las fechas persistidas de la prueba. Con emisores que aún omiten la duración, la plantilla muestra «Prueba activa» y la fecha de vencimiento.

Para pruebas con SES en desarrollo se puede configurar `PUBLIC_APP_URL` con el origen HTTP local, por ejemplo `http://localhost:8080`. Los enlaces de bienvenida y firma aceptan HTTP únicamente para ese mismo origen loopback en desarrollo. Los mensajes siguen usando las plantillas publicadas en SES.

El proceso confirma el reclamo en MySQL antes de llamar a SES. `processed_at` registra el reclamo y no acredita la entrega. Si SES no confirma el resultado, el proceso registra `REGISTRATION_WELCOME_UNCONFIRMED` y evita un segundo intento automático. Las pruebas simulan SES y comprueban el reclamo concurrente y la activación tras recuperación, incluido el rollback.

El [workflow de Hemia Infra](https://github.com/hemia-labs/hemia-infra/actions/runs/42153789351) verificó el contenido publicado y el render de las seis plantillas MedSync en SES DEV y PROD. La bienvenida quedó configurada para la cuenta SES que usa el backend local.

## Confirmación de futuras versiones desde Cuenta y legal — 2026-11-05

Las cuentas registradas con Legal central pueden abrir «Revisar y confirmar documentos» cuando el servicio informa versiones pendientes. `GET /api/saas-legal/central/context` prepara el conjunto `registration` con sus versiones, acciones y HTML verificado por SHA-256. El contexto firmado se liga al usuario, consultorio y sesión autenticada, con un dominio HMAC distinto al registro. La pantalla muestra una casilla desmarcada por documento y adapta el texto a `accept`, `acknowledge` o `consent`; confirma el conjunto completo que exige el contrato de Legal. Cambiar de sesión/consultorio invalida respuestas y selecciones anteriores. El HTML se sanitiza antes de presentarlo.

`POST /api/saas-legal/central/accept` requiere autenticación vigente, CSRF/origen válido, un cuerpo exacto de hasta 8 KiB, el contexto y confirmaciones explícitas de todas las versiones, y un UUID v4 de idempotencia. El DAO revalida y bloquea al usuario en una transacción; la misma conexión consulta el origen central y guarda un evento `registration.legal_updated` en `registration_outbox`. La identidad procede del contexto autenticado. El worker existente entrega la evidencia fuera de la transacción y conserva el payload, la hora de confirmación y la clave en sus reintentos. Este cambio no requiere una nueva migración.

El primer envío debe realizarse dentro de la vigencia de la revisión. Un reintento idéntico de un evento ya guardado puede recuperar su resultado aunque la revisión haya vencido; un contexto de otra sesión, un payload distinto con la misma clave o una revisión vencida sin evento no autorizan nuevas confirmaciones. La comparación de un reintento usa valores de los campos, porque MySQL normaliza el orden de propiedades JSON. Una publicación posterior no sustituye las versiones firmadas que se mostraron al usuario. Si hay otro evento pendiente de ese usuario/consultorio, se devuelve `LEGAL_SYNC_PENDING`.

HTTP 202 significa confirmaciones guardadas y pendientes de sincronizar; el historial presenta un comprobante central únicamente después de la recepción confirmada por Legal. Tanto documentos como historial detectan eventos pendientes de registro y actualización. Ante un resultado de red desconocido la interfaz conserva el mismo cuerpo y clave para reintentar; una revisión vencida exige cargar documentos y marcar las casillas nuevamente. Las cuentas históricas con política local mantienen su flujo y sus comprobantes.

Pruebas reproducibles: `npm run qa:registration-http` incluye `account-legal-confirmation-mysql.js` con rutas, JWT, CSRF, transacciones y MySQL 8.4 reales sobre una base temporal sintética, además de las regresiones existentes. `node scripts/qa/central-legal-client-regression.cjs`, desde el frontend, verifica Vue/Vuetify, sanitización, casillas, reintentos, vencimiento, guardas y cambio de contexto con un servicio simulado. La revisión visual usa Chrome a 1440 y 390 px, incluido tema nocturno y confirmación en cola. Las pruebas no registran aceptaciones en Legal real ni modifican la base configurada.

Resultado: suite Docker completa aprobada con MySQL 8.4.13 y Node 22.23.4; cuatro grupos nuevos de integración y cinco grupos de interfaz aprobados. Lint de los componentes/servicio modificados y comprobación de espacios aprobados. La regresión de colores nocturnos quedó corregida y la suite de interfaz pasa 14/14 casos. La prueba distingue el encabezado azul de Cuenta y legal del aviso dorado de advertencia; reproduce la jerarquía del aviso para comprobar el color heredado del título y del botón Reintentar, además del icono y la acción principal. Se conserva el estilo existente. Esta validación es local y sintética, sin solicitudes de red, base de datos ni aceptaciones reales.


## Regresión HTTP y compatibilidad de planes — 2026-11-05

La prueba `s24-registration-http-mysql.js` ya verifica el flujo actual. Dos confirmaciones válidas concurrentes del mismo reto devuelven 200/200 con las mismas fechas de prueba, estado `trial`, plan `pro` y destino de preparación; no se espera `unavailable` ni se crea una reserva telefónica. Conserva las comprobaciones de CSRF/origen, idempotencia, aislamiento, bloqueo por intentos, rotación de refresh, logout, carreras de contraseña y retención.

El recorrido añadido utiliza los endpoints HTTP reales de registro, envío/validación de recuperación, restablecimiento, login, sesión y activación: registro pendiente → código de contacto vencido → recuperación → activación de una sola prueba de 15 días. Comprueba códigos de recuperación incorrectos/vencidos, rollback de contraseña/verificación/reto/activación ante un fallo SQL inducido, revocación de la sesión original, acceso con la nueva contraseña y rechazo del código ya consumido sin reiniciar fechas. Los únicos cambios de datos suceden en una base sintética aleatoria.

`isActivationConfirmed` es la regla compartida por la respuesta de activación y el marcador de sesión. Una suscripción `active` reconoce los planes locales `basic`, `pro` y `enterprise`, incluido el alias histórico `professional→pro`; exige consultorio activo, correo verificado y activación completada. Una prueba sigue siendo exclusivamente Profesional y debe estar vigente. Planes desconocidos, cuentas suspendidas, pruebas de otro plan y pruebas vencidas no quedan confirmados. `planId` devuelve el código canónico reconocido y la pantalla ya no presenta todas las cuentas pagadas como Profesional. No se modifica ningún plan o suscripción real al implementar esta compatibilidad.

Comando reproducible:

```sh
npm run qa:registration-http
```

Requiere Docker y las dependencias ya instaladas del backend. El ejecutor levanta MySQL 8.4 y Node 22 sin red ni puertos publicados, comparte únicamente un socket Unix, monta el código como solo lectura y guarda los datos en un volumen temporal en memoria. Ejecuta la regresión HTTP, la integración SQL de activación/recuperación/teléfono, las regresiones de recuperación del DAO y el catálogo de planes, y elimina contenedores/volumen al terminar. `registration-http-fixture.js` define el esquema mínimo sintético y un procedimiento de sesión que modela el contrato requerido por el DAO; esta prueba no verifica una copia del procedimiento SQL del servidor real. Legal, entrega de correo y catálogo se sustituyen por proveedores sintéticos; las rutas, controladores, DAO, validadores, cookies, JWT, CSRF, cifrado y transacciones MySQL son reales.

Validación: pasan los 15 grupos HTTP y las regresiones SQL/DAO/catálogo sobre MySQL 8.4.13 y Node 22.23.4. El error SQL deliberado del caso de rollback se registra como fallo esperado y la prueba verifica que la operación se revierte. No se contactó la base configurada, ni se enviaron correos o iniciaron pagos. La contratación con Billing quedó fuera de este cambio por indicación del usuario.

## Cuenta y legal: comprobantes centrales e historial local — 2026-11-05

`GET /api/saas-legal` y `/history` reconocen el evento de registro central de la cuenta autenticada en `registration_outbox`, ligado simultáneamente al usuario y al consultorio. Para esas cuentas, los documentos de registro se consultan en el conjunto `registration` de Legal central; las antiguas tarjetas locales `terms_conditions` y `privacy_notice` dejan de ser la política vigente del registro. No se comparan títulos ni se declaran equivalentes sus versiones o hashes. El contrato/licencia local y todos los comprobantes locales históricos se conservan; las cuentas sin un evento central de registro mantienen su flujo local anterior.

El backend utiliza las lecturas M2M `pending/evaluate` y `evidence/history`, con producto/aplicación, conjunto e idioma fijados por configuración y sujeto/organización derivados de la cuenta revalidada. Requiere que el cliente confidencial existente tenga autorizado el scope `legal.integration.acceptances.prepare`, separado del scope de escritura de evidencias. Se reutiliza el `MachineClient` público instalado con `@hemia/legal`, pues el SDK Legal 0.1.0 solo expone publicación y registro. Las peticiones no siguen redirecciones, tienen timeout y límite de respuesta. No se trasladan credenciales al navegador ni se usan los identificadores recibidos del navegador para elegir otra cuenta.

Las respuestas incluyen `central_available`, `central_sync_pending`, `pending_unknown` y, en el historial, `central_next_cursor`. La pantalla identifica el origen de cada documento/comprobante y carga páginas adicionales sin duplicar el historial local. Solo la respuesta de Legal confirma una aceptación central: una entrega pendiente de la cola se muestra como sincronización pendiente, sin presentarla como recibida ni solicitar otra aceptación. Si Legal falla, la pantalla conserva la información local y el aviso expone que los pendientes centrales son desconocidos. Una nueva versión realmente pendiente se informa como central y no puede aceptarse por el endpoint local; la confirmación posterior de conjuntos completos se implementa en el flujo descrito al inicio de este documento.

`GET /api/saas-legal/central/documents/:versionId` permite consultar el contenido de una versión del historial de ese sujeto/consultorio o del conjunto vigente. El backend obtiene la publicación por clave y versión exactas, verifica los UUID de documento/versión y SHA-256, y descarga HTML exclusivamente de los orígenes HTTPS autorizados. Si el texto histórico ya no está publicado, el comprobante y su hash siguen visibles: nunca se sustituye por el texto actual. Las aceptaciones locales mantienen sus versiones congeladas.

Validación sintética: pasan `account-legal-regression.js`, `saas-legal-regression.js`, la integración de registro/recuperación/teléfono en MySQL 8.4.13 temporal y la regresión de recuperación del DAO. Los nuevos casos del frontend comprueban errores parciales, paginación, lectura de versión exacta, sincronización y respuestas tardías tras cambiar de cuenta. La suite Vue completa tiene 13 de 14 casos aprobados; el caso restante compara colores anteriores del aviso oscuro y falla de igual forma con los componentes originales de Git (10 de 11 casos antiguos). Chrome verificó la pantalla y el comprobante a 1440 y 390 px con datos sintéticos, sin desbordamientos ni excepciones.

Tras la autorización específica del usuario, se intentaron las lecturas de historial y pendientes con una cuenta central existente. El primer intento encontró `ECONNREFUSED` porque el API local de Legal no estaba levantado. Por solicitud posterior se inició Legal en `127.0.0.1:3017`, con su configuración existente y los trabajadores de publicaciones y Event Bus pausados. `/health/live` y `/health/ready` devolvieron HTTP 200. No se ejecutaron migraciones ni seeds en Legal.

La instalación de Bun contenía dos instancias de `@nestjs/core` 11.2.1 con distintos contextos de dependencias, lo que impedía resolver `Reflector` al arrancar. El arranque local de prueba usa Node 22 con `--preserve-symlinks` y `NODE_PATH` apuntando al directorio transitivo de Bun; no se modificaron dependencias ni código de Legal. El proceso quedó levantado con PID 8442 y log restringido en `/private/tmp/medsync-legal-local/api.log`; el arranque está en `/private/tmp/medsync-legal-local-start.cjs`.

La lectura pública de documentos tardó 8,2 segundos y excedió el timeout original de ocho segundos. Las consultas de Cuenta y legal ahora tienen un timeout de 20 segundos; el registro conserva su timeout anterior. Con ese ajuste, el DAO real devolvió `central_available: true`, dos documentos centrales aceptados, cero pendientes centrales, `pending_unknown: false` y `central_sync_pending: false`. El historial mostró dos comprobantes centrales (un evento con dos documentos), y el documento local independiente siguió disponible. Las credenciales y el scope de lectura configurados funcionaron. No se registraron aceptaciones nuevas ni se cambiaron permisos. Volvieron a pasar las regresiones sintéticas legales y la integración MySQL de registro/activación/recuperación.

## Teléfono de contacto sin reserva de identidad — 2026-11-05

En el autorregistro, el teléfono opcional se conserva en `login.telephone` como dato de contacto. No acredita propiedad ni reserva el número; varios usuarios pueden indicar el mismo contacto. Verificar el correo, recuperar la contraseña, corregir el teléfono o actualizar posteriormente la cuenta no crea ni prolonga una identidad telefónica. Los límites del registro siguen aplicándose por IP y correo, sin bloquear registros por un teléfono de contacto compartido. El acceso del autorregistro es por correo; solo una identidad telefónica verificada puede habilitar acceso por teléfono para esas cuentas. El acceso telefónico histórico de cuentas ajenas al autorregistro conserva su comportamiento.

Antes de desplegar este cambio se debe aplicar S27 con los escritores detenidos. No se ejecuta al arrancar. El diagnóstico es de solo lectura:

```sh
node scripts/migrations/s27-registration-phone-contact.js
node scripts/migrations/s27-registration-phone-contact.js --apply --writers-stopped --expect-database NOMBRE_EXACTO
```

S27 respalda las dos definiciones de triggers en `.schema-backups`, reemplaza únicamente los triggers de identidad de `login` y libera identidades telefónicas sin verificar (`pending`, `reserved` o `legacy`) cuando pertenecen a un propietario de autorregistro identificado por `registration_account` y los creadores de usuario/consultorio. No cambia el teléfono de contacto, las identidades de correo ni las telefónicas verificadas. Las identidades históricas sin vínculo de autorregistro se conservan. Repetir la migración es idempotente; si se interrumpe durante DDL, mantener los escritores detenidos y repetir con un nuevo directorio de respaldo antes de reabrir escrituras. Los clientes de autorregistro que usaban un teléfono sin verificar deben ingresar con su correo.

La regresión MySQL de `registration-email-trial-mysql.js` instala los triggers reales y comprueba limpieza de estados antiguos, idempotencia, contactos repetidos, activación por correo y recuperación sin reserva, corrección hacia un número histórico, actualizaciones posteriores, continuidad del acceso histórico/verificado y por correo y rechazo de un correo duplicado. Validación del 2026-11-05: pasó en Docker con MySQL 8.4.13 y Node 22.23.4, sin red ni datos reales; pasó también `registration-recovery-regression.js`. Se verificó la eliminación de contenedores y volumen temporales. Esa validación aislada precedió a la aplicación autorizada descrita a continuación.

### S27 aplicada en la base configurada — 2026-11-05

Aplicada por solicitud explícita a `hemia_assitant_legacy`, MySQL 8.0.36. El diagnóstico inicial encontró una identidad telefónica `pending` sin verificar perteneciente a un autorregistro. Se utilizó una conexión con consultas secuenciales, bloqueo exclusivo de migración y doce guards temporales `BEFORE INSERT/UPDATE/DELETE` sobre `login`, `business`, `registration_account` y `auth_identity`. Durante el reemplazo de triggers y la limpieza, solo la conexión de migración pudo escribir en esas tablas. Todos los guards se retiraron al terminar; no quedaron bloqueos de mantenimiento.

Resultado: `alreadyApplied: true`, `releasedPhoneIdentities: 1`, `unverifiedPhoneIdentities: 0`. Las definiciones finales de ambos triggers coinciden con S27. Las huellas de todas las filas de `login`, `business` y `registration_account` permanecieron idénticas; las de `auth_identity` coinciden exactamente con el conjunto original menos la reserva liberada. Se conservan los 31 correos (28 históricos, uno pendiente y dos verificados), las 28 identidades telefónicas históricas y los tres registros de autorregistro. Una conexión nueva confirmó el diagnóstico y la ausencia de guards temporales.

El respaldo restringido y excluido de Git está en `.schema-backups/s27-2026-11-05T14-40-44-683Z/`: contiene las definiciones originales de triggers, la reserva eliminada y los informes de huellas antes/después. El directorio tiene permisos `0700` y los archivos `0600`. No se crearon cuentas de prueba, no se enviaron correos y no se desplegó código de aplicación como parte de esta migración.

## Recuperación antes de activar la cuenta — 2026-11-04

Completar la recuperación de contraseña también activa la prueba de un autorregistro pendiente cuyo correo acaba de verificarse. La recuperación y la confirmación del código de registro reutilizan `AccountActivationService.activateVerifiedEmail`, siempre dentro de la transacción del llamador. Contraseña, consumo del reto, verificación del correo, inicio de prueba y revocación de sesiones se confirman juntos; un fallo revierte todas esas escrituras. La notificación por correo se envía después del commit y no revierte una recuperación confirmada.

La activación exige propietario administrador de su propio consultorio activo, correo verificado e identidad vigente, estado `pending_activation`, ausencia de fechas de prueba previas y ausencia de una activación completada. Inicia una sola prueba `pro` de 15 días; el teléfono opcional sigue la política de contacto de S27. Recuperar cuentas activas, con prueba vigente o vencida, suspendidas o históricas no cambia su suscripción ni reinicia fechas. No se ejecuta un backfill de cuentas: una cuenta pendiente ya atascada puede completar nuevamente la recuperación.

Regresión ejecutable sin servicios: `node scripts/qa/registration-recovery-regression.js`, incluida en `qa:isolated`. Ejecuta el DAO real con dependencias sintéticas y comprueba activación en la misma transacción, rollback por fallo de activación o revocación, rechazo de códigos incorrectos/vencidos/no verificados/usados y fallo de notificación posterior al commit. `registration-email-trial-mysql.js` incluye además casos SQL de activación tras recuperación, duración exacta, rollback, conservación de suscripciones y prevención de una segunda prueba; requiere el MySQL temporal aislado descrito más abajo.

Validación completada el 2026-11-05 en Docker con MySQL 8.4.13 y Node 22.23.4: pasan `registration-email-trial-mysql.js` y `registration-recovery-regression.js`. Se comprobaron activación tras recuperación, duración exacta de 15 días, rollback, confirmaciones concurrentes, códigos incorrectos/vencidos, aislamiento de consultorios y ausencia de renovación o cambios en suscripciones existentes. Ambos contenedores se ejecutaron sin red ni puertos publicados, con socket Unix compartido, código de solo lectura y datos sintéticos en un volumen temporal en memoria. Se eliminaron contenedores y volumen al terminar y se verificó su ausencia. La integración SQL utiliza el servicio real de activación; el DAO de recuperación se comprueba por separado con dependencias sintéticas. No se enviaron correos ni se accedió a la base configurada.

## Documentos de registro en Hemia Legal

El registro obtiene el conjunto `registration` de la aplicación MedSync en Legal. Devuelve los documentos publicados, su HTML verificado con SHA-256, versión, acción (`accept`, `acknowledge` o `consent`) y un contexto firmado vinculado a la cookie del intento. El frontend presenta las confirmaciones por separado y envía ese contexto; un cambio de snapshot, versión, hash o acción descarta las confirmaciones anteriores. El HTML publicado no se modifica.

Un solo cliente confidencial `medsync-backend`, creado y conectado desde Console, tiene destinos separados para Legal y Billing. Cada token solicita una sola audiencia/recurso y los scopes correspondientes. La credencial se instala exclusivamente en el backend mediante `HEMIA_ID_URL`, `HEMIA_CLIENT_ID` y `HEMIA_CLIENT_SECRET`; nunca se incorpora a variables `VUE_APP_*`. `LEGAL_API_URL`, `LEGAL_APPLICATION_ID` y `LEGAL_DOCUMENT_ORIGINS` definen la consulta de documentos; el último contiene únicamente orígenes HTTPS autorizados de los archivos publicados. No se siguen redirecciones de descarga y se verifica el hash antes de mostrar contenido.

La creación de cuenta guarda, en su misma transacción MySQL, el evento de `registration_outbox` con identidad de cuenta/consultorio, snapshot, acciones, hashes, fecha original y UUID de idempotencia. No conserva correo, contraseña ni credenciales en la evidencia. El trabajador de Legal entrega esos eventos cada 15 segundos, conserva el comprobante `legal_evidence_id`, reintenta con la misma identidad/fecha/payload tras fallos y recupera leases vencidos. Los reintentos no aceptan versiones nuevas ni duplican comprobantes. La activación por correo y los 15 días de prueba mantienen su flujo independiente.

Antes de habilitar este código en otra instalación, aplicar explícitamente la migración aditiva S26; no se ejecuta al arrancar:

```sh
node scripts/migrations/s26-registration-legal-evidence.js
APP_ENV=development node scripts/migrations/s26-registration-legal-evidence.js --apply
```

S26 amplía la cola existente; no modifica documentos ni aceptaciones locales anteriores. El comando de aplicación está limitado al entorno de desarrollo; el despliegue de otro entorno requiere su revisión operativa explícita. La ausencia de configuración, columna de cola o publicaciones válidas cierra el registro, sin sustituir los documentos por una copia local. La pantalla e historial legales locales anteriores no se migran con este cambio: los nuevos comprobantes de registro se conservan en Legal y se vinculan desde la cola.

La prueba `bash scripts/qa/registration-legal.docker.sh` usa MySQL desechable y proveedores sintéticos: verifica atomicidad, rollback, hash, firma/propietario del contexto, reintentos, respuesta perdida, audiencia y comprobante idempotente. Las comprobaciones sobre servicios compartidos se limitan a consultas y tokens; no crean aceptaciones de prueba en Legal.

El correo es el identificador principal del registro, login y recuperación. Se normaliza quitando espacios exteriores y convirtiendo a minúsculas. El teléfono es opcional; cuando se proporciona se validan diez dígitos y, desde S27, se guarda solo como contacto del autorregistro. El servidor sigue aceptando el acceso antiguo por teléfono para clientes históricos.

El registro muestra correo y teléfono, nombre y consultorio, contraseña y confirmación en dos columnas (una en móvil). La confirmación se compara exactamente en el cliente y no se envía ni almacena. La contraseña permite entre 8 y 128 caracteres, conserva espacios y normalización NFC, y mantiene scrypt, la lista de contraseñas comprometidas y los límites de intentos. La verificación de correo y los controles de sesión e identidad siguen siendo obligatorios; una cuenta no necesita teléfono para completarlos.

## Migración S25 de instalaciones existentes

Estado: aplicada el 2026-10-29 en `hemia_assitant_legacy` (MySQL 8.0.36). Los 30 usuarios conservan los nombres y todos sus datos anteriores; las identidades no cambiaron. El diagnóstico final devuelve `alreadyApplied: true`.

Antes de publicar código que acepte cuentas sin teléfono, ejecutar el diagnóstico de solo lectura:

```sh
node scripts/migrations/s25-registration-email-login.js
```

S25 permite omitir el teléfono en los triggers de identidad y renombra `auth_password_reset_tokens.phone_normalized` a `identifier_normalized VARCHAR(254)` para la recuperación por correo. Revoca los códigos pendientes durante el cambio, conserva el historial y no elimina cuentas ni reservas. Las definiciones de los triggers están congeladas dentro de S25.

Para aplicarla, detener primero todos los escritores de cuentas y recuperación, respaldar la base y ejecutar contra el nombre exacto de la base acordada:

```sh
node scripts/migrations/s25-registration-email-login.js --apply --expect-database NOMBRE_EXACTO --writers-stopped
```

El script respalda las definiciones previas en `.schema-backups/email-login-*`. MySQL confirma DDL automáticamente: mantener los escritores detenidos hasta que el diagnóstico indique `alreadyApplied: true`. Si la creación de un trigger falla, el script intenta restaurar su definición original; no reiniciar escritores si la migración termina con error. Arrancar después el backend actualizado y publicar el frontend. No ejecutar esta migración automáticamente durante el arranque.

Validación histórica sin cuentas reales: `registration-email-regression` (retirado) y `s24-password-regression`. La primera prueba validadores reales, identidad, bloqueo de propietario, recuperación ligada al correo completo y confirmación de correo sin teléfono con consultas simuladas. La segunda ejecuta scrypt real y la compatibilidad bcrypt. La integración SQL requiere una base aislada; la base remota no se modifica como parte de estas pruebas.

Comprobación adicional: `d2-refresh-cookie-runtime-regression.js validate` mantiene un fallo previo en “D2 refresh returns tokenless JSON”. Se reprodujo cargando las versiones de `HEAD` de los módulos modificados, sin alterar archivos. Ese contrato de respuesta de refresh queda fuera de este cambio. Las pruebas específicas de registro, contraseña, identidad, límites y navegación sí pasan; el navegador se comprobó a 1440, 390 y 320 px con respuestas simuladas.

## Corrección del flujo de recuperación

La API usa `email` en solicitud, validación y restablecimiento. Los nombres históricos `phone`/`telephone` solo se aceptan como alias si contienen un correo válido; un número de teléfono ya no inicia una recuperación. El formulario y registro comparten la misma función de política: 8–128 caracteres Unicode, NFC, máximo 512 bytes, sin exigir letras ni números. El servidor mantiene scrypt y la lista de contraseñas comprometidas; una recuperación de cuenta bcrypt la actualiza a scrypt. La confirmación es obligatoria en la API.

Cada operación bloquea primero la cuenta/identidad y después el último reto. La revocación y emisión del nuevo código son atómicas. Validación e intentos usan una transacción y transiciones condicionadas al estado anterior; un código usado/revocado/bloqueado no puede volver a verificarse. El cambio de contraseña consume el reto y revoca sesiones, refresh y otros retos en la misma transacción. Un correo cambiado o reservado por otra cuenta invalida el acceso al reto anterior.

Una cuenta pendiente puede solicitar recuperación por su correo aunque aún no lo haya verificado, siempre que la reserva siga perteneciendo a esa cuenta (incluso si venció sin ser reclamada). La prueba del código y el cambio de contraseña verifican ese correo dentro de la transacción. No se reasignan reservas de otra cuenta.

S25 contiene sus propias definiciones de triggers, sin importar S24. Además renombra `phone_normalized` a `identifier_normalized VARCHAR(254)` y revoca los retos `pending`/`verified` existentes durante la transición. Conserva su historial y no modifica contraseñas ni contactos; conserva el nombre completo de cada cuenta. Publicar el nuevo backend únicamente después de aplicar S25; este requisito ya se cumplió en la base configurada. La migración requiere todos los escritores detenidos y respaldo previo.

Prueba histórica del DAO con datos y consultas simulados: `password-recovery-regression` (retirado). Incluye verificación, consumo y reenvío concurrentes, conteo exacto de intentos, expiración, rollback, correo cambiado y recuperación de cuenta pendiente. No demuestra el comportamiento de bloqueos del motor MySQL; esa integración requiere una base de pruebas aislada con S25.

## Nombre y apellidos separados (S25 aplicada)

S25 agrega `login.first_name` y `login.last_name` como columnas de texto de hasta 500 caracteres. Se conserva `login.name` como nombre completo de compatibilidad con procedimientos, documentos y clientes existentes. La nueva captura valida nombre y apellidos no vacíos y un máximo conjunto de 200 caracteres. Registro y administración envían `first_name`/`last_name`; los clientes antiguos pueden seguir enviando `name` como texto completo no estructurado.

El backfill copia el `name` existente exactamente a `first_name` y deja `last_name` vacío. No divide por espacios ni presupone cuántos nombres o apellidos tiene una persona. Los registros antiguos se completan explícitamente desde edición de usuarios. La comprobación inicial bloquea la aplicación si hay nombres existentes de más de 500 caracteres, evitando truncarlos.

Dos triggers `BEFORE INSERT/UPDATE` de S25 sincronizan el nombre completo cuando cambian los campos separados. Una escritura antigua que cambie únicamente `name` conserva ese texto como nombre no estructurado y deja apellidos vacíos; una escritura antigua que reenvía el mismo nombre completo conserva la separación existente. Las reglas de identidad `AFTER` siguen independientes. S25 respalda también la definición de `login`, y conserva los controles de destino exacto y escritores detenidos. Se aplicó en la base configurada el 2026-10-29.

La sesión y los endpoints de usuarios exponen ambos campos. Alta, edición y listado de personal los presentan por separado, y los cambios de rol/contacto que omiten nombres conservan los valores existentes. El nombre completo anterior sigue disponible como `name`.

Pruebas históricas sin base, posteriormente retiradas: `user-names-regression` (validador y DAO reales con consultas simuladas) y `s25-migration-regression` (DDL y backfill simulados). Los triggers se validaron también con MySQL real aislado, según la comprobación siguiente.


## Validación MySQL aislada — 2026-10-28

Se ejecutó `scripts/qa/s25-isolated-mysql.js` contra MySQL Community 8.0.44 descargado en una carpeta temporal. El servidor arrancó con `--no-defaults`, `--skip-networking` y `--mysqlx=OFF`: puerto MySQL 0, acceso exclusivamente por socket Unix. La prueba exige `S25_QA_ISOLATED=1`, un socket bajo `/private/tmp/medsync-s25-*`, directorio de datos temporal coincidente y `@@skip_networking=1` antes de crear una base aleatoria `s25_qa_*`. No carga `.env`, la conexión configurada, volcados ni proveedores de correo. La base sintética se elimina al terminar; la instancia temporal se apagó después de la validación.

El esquema anterior a S25 está definido explícitamente en `scripts/qa/s25-isolated-schema.js`; representa las tablas y columnas utilizadas por estos flujos. Las definiciones S24, S25, los documentos legales, el aprovisionamiento, validadores, cifrado y DAO ejecutados son los del repositorio. No se verificó una copia completa del esquema real ni su versión exacta 8.0.36. El correo usa un doble local y las solicitudes HTTP de recuperación se atienden mediante un adaptador de pruebas con los validadores y DAO reales; esta suite no comprueba entrega SES, CSRF, rutas/controladores completos ni la interfaz del navegador.

Comprobaciones aprobadas:

- S25 aplica el DDL y los cuatro triggers, conserva el índice de recuperación al renombrar el identificador, revoca retos pendientes/verificados y mantiene el historial usado. Una segunda aplicación no cambia nada. Escrituras antiguas de `name` y nuevas de nombre/apellidos sincronizan correctamente.
- Los nombres sintéticos existentes se conservan exactamente: compuestos, espacios iniciales/finales e internos, acentos, caracteres chinos, apóstrofos, monónimos y 500 caracteres. No se infieren apellidos. Se conserva también el texto después de una edición ajena al nombre.
- El servicio real de registro crea nombre/apellidos, correo de más de 32 caracteres y teléfono vacío; admite ocho letras, rechaza siete, permite reintentar sin duplicar y revierte el registro con identidad duplicada.
- El DAO real de usuarios crea y edita con controles de licencia y aislamiento de consultorio; mantiene apellidos en ediciones parciales y rechaza nombres inválidos y otro consultorio.
- La recuperación HTTP con SQL real valida correo y confirmación, cambia la contraseña con scrypt, mantiene nombres, invalida sesiones/refresh y consume el código. Se probaron correo inexistente, cinco intentos fallidos, bloqueo, caducidad y revocación cuando falla el envío.
- Con dos conexiones reales InnoDB, reenvíos concurrentes dejan un reto pendiente y validación/restablecimiento simultáneos tienen un solo ganador. Una cuenta bcrypt se recupera por correo y migra a scrypt sin alterar nombre/apellidos.

La prueba detectó que `userNames` recortaba el nombre antiguo en ediciones parciales. Se corrigió para devolver exactamente los valores existentes cuando se omiten los nombres o se reenvía el mismo nombre completo; se agregó regresión específica. Después pasaron también `user-names-regression`, `s25-migration-regression`, `password-recovery-regression`, `registration-email-regression`, comprobación de sintaxis y `git diff --check`.

La validación aislada precedió a la aplicación autorizada el 2026-10-29.


## Retiro de QA — 2026-10-29

Por solicitud del usuario se retiraron los seis scripts temporales de validación de registro, recuperación, nombres y S25 y sus entradas del ejecutor de regresiones. Las referencias anteriores documentan pruebas ya realizadas; esos scripts ya no forman parte del repositorio. Se mantienen las pruebas preexistentes, sus ajustes de compatibilidad con el nuevo esquema y el resultado histórico de la validación aislada.


## Aplicación a la base configurada — 2026-10-29

Aplicada únicamente S25, que agrupa los cambios de esta tarea. El preflight sobre `hemia_assitant_legacy`, MySQL 8.0.36, indicó `ready: true`, dos triggers S24 existentes y ningún campo separado de nombres. Había 30 usuarios, con nombre máximo de 33 caracteres.

Se usó una conexión con consultas secuenciales y un bloqueo exclusivo de migración. Antes de modificar el esquema se instalaron seis guards temporales `BEFORE INSERT/UPDATE/DELETE` sobre `login` y `auth_password_reset_tokens`, que rechazaban escrituras de cualquier otra conexión durante el cambio. Se retiraron todos al terminar. No se alteró el modo global del servidor ni se crearon usuarios de prueba o enviaron correos.

El respaldo de las definiciones anteriores y los informes de verificación están en `.schema-backups/s25-2026-10-29T06-03-44.171Z/`, excluido de Git y con permisos restringidos. Incluye `email-login-schema.json`, `verification-before.json` y `verification-after.json`; no es un volcado completo de datos. Los informes guardan huellas de verificación, no nombres ni credenciales.

Resultado: `alreadyApplied: true`, `first_name`/`last_name` creados, identificador de recuperación migrado y cuatro triggers definitivos presentes. Se compararon huellas de todos los campos anteriores de cada usuario y de toda la tabla de identidades: sin cambios. Los 30 nombres completos se copiaron exactamente a `first_name`, dejando `last_name` vacío. No quedan retos de recuperación pendientes/verificados después de la revocación prevista por S25. Una comprobación independiente de solo lectura confirmó el estado final.

## Continuidad del correo en el frontend — 2026-10-29

La pantalla `AccountActivation.vue` solicita automáticamente el primer código después de consultar la cuenta y confirmar la sesión, únicamente si el correo sigue sin verificar. Crear la cuenta no dispara un correo de bienvenida adicional. El usuario confirma seis dígitos; el servidor conserva la autoridad sobre intentos, caducidad, estado de verificación y destino posterior. Desde el cambio de activación por correo descrito abajo, confirmar el código también activa una prueba Profesional de 15 días, sin contratación comercial.

La pestaña conserva en `sessionStorage` solo la referencia del reto y las fechas de caducidad/reenvío, separadas por cuenta y correo. Nunca guarda el código escrito ni credenciales. Recargar recupera el reto vigente y el tiempo de espera, sin repetir automáticamente el envío. Un envío con resultado desconocido tampoco se repite al recargar: se puede solicitar otro de forma manual tras la espera. Un cambio de correo descarta la referencia anterior; una confirmación correcta o una consulta que ya indica correo verificado elimina la referencia guardada. Si el navegador bloquea el almacenamiento, la verificación sigue funcionando, pero no puede recuperar esa referencia después de recargar.

Se abreviaron los mensajes del paso de verificación y se distingue el estado «Enviando código…» del de confirmación. Comprobaciones aprobadas: plantilla Vue compilada, métodos reales con dobles de servicios, regresión de registro existente, ESLint y revisión de cambios. El navegador real se comprobó a 1440 y 390 px con todas las respuestas de API simuladas: envío inicial único, recarga sin duplicar, código escrito no persistido, confirmación al paso 3, sin desbordamientos ni excepciones. No se enviaron correos reales ni se escribieron datos en la base. Los scripts de comprobación nuevos se mantuvieron fuera del repositorio.


## Plantilla SES de registro — 2026-10-29

El diseño de correo aprobado (cabecera blanca, logo oficial MedSync, código y
vigencia) se administra en `hemia-infra`. Las plantillas son
`medsync-dev-registration-contact-code-v1` y
`medsync-prod-registration-contact-code-v1`. El logo público versionado usa
`https://cdn.medsync.mx/email/projects/medsync/logos/medsync-v1.png`, compartido
por ambas plantillas. No contiene datos de usuarios ni del consultorio.

Se actualizó la copia operativa DEV `scripts/ops/s24-registration-email-template.json`
para evitar volver a publicar el diseño anterior. Fuente principal y publicación:
`hemia-infra/docs/MEDSYNC-REGISTRATION-EMAIL.md`, PR #21. Las variables siguen siendo
`code`, `ttlMinutes`, `html.code`, `html.ttlMinutes`; sin cambios de API, tablas o
códigos de verificación. Publicar SES no cambia el proveedor SMTP configurado ni
reinicia el backend. No se envían correos reales durante la verificación de plantillas.

Publicación completada: [hemia-infra PR #21](https://github.com/hemia-labs/hemia-infra/pull/21),
integrado en `main`, commit `0b37f3826cc3c5e9d8d3623e7b82688c9b96a2a4`.
[Actions 40896564942](https://github.com/hemia-labs/hemia-infra/actions/runs/40896564942)
confirmó cuenta, carga/comparación HTTPS del logo, contenido SES y render en PROD
(`379492770798`) y DEV (`554324881931`). Se conservaron respaldos de plantillas y
renders sintéticos en los artefactos de Actions, con retención de 14 días. El logo
se sirve en PNG con caché inmutable anual; futuras imágenes deben versionarse con
una clave nueva. No se cambió el proveedor SMTP actual ni se enviaron mensajes.


## Activación por correo y prueba de 15 días — 2026-10-29

El flujo vigente es: registro → correo con código → confirmación → cuenta operativa con prueba Profesional de 15 días. La sesión previa a la confirmación sigue limitada por `pending_activation`; no permite operar con pacientes ni configurar el consultorio. No se solicita contratación, precio ni confirmación de un proveedor comercial para activar la prueba.

La pantalla de verificación solicita el código automáticamente al entrar después del registro o de un login correcto de una cuenta no verificada. Un nuevo login descarta la referencia local anterior y solicita otro código; se mantienen el intervalo mínimo de reenvío de 60 segundos y los límites por cuenta, destino e IP. Recargar la misma sesión reutiliza la referencia vigente, sin repetir el correo ni guardar el código. Una referencia vencida sin espera pendiente permite solicitar otro automáticamente. El envío depende de abrir esa pantalla en el frontend; `POST /auth/register` y el login por sí solos no envían el correo.

`POST /api/account/contact-verifications/confirm` guarda en la misma transacción la identidad verificada, el consumo del reto, `business.subscription_status=trial`, `plan=pro`, inicio y fin separados por exactamente 15 días y `registration_account.activation_completed_at`. La prueba empieza al confirmar, no al registrarse. Una confirmación repetida válida del mismo reto consumido devuelve el estado actual sin reiniciar fechas. Si falla cualquier escritura, también se revierten el consumo del código y la verificación. Códigos erróneos o vencidos no activan la cuenta; se mantienen los cinco intentos y diez minutos de vigencia.

El estado de activación y la sesión reconocen tanto una prueba vigente como una suscripción activa. La respuesta de activación incluye `trialStartsAt` y `trialEndsAt`. Después de confirmar, el frontend vuelve a consultar la sesión y dirige al resumen de preparación o al inicio según los datos del servidor. La bienvenida reconoce el estado `trial`. Si no se puede consultar la preparación, ofrece reintentar sin requerir contratación. El login correcto descarta la referencia local del reto de esa cuenta antes de abrir la verificación; la respuesta de sesión conserva su contrato actual.

Al vencer la prueba, los controles operativos existentes restringen la cuenta y conservan sus datos. Reconfirmar el código no renueva la prueba. Las cuentas `legacy` y las suscripciones existentes no se convierten en prueba. No hay backfill automático de cuentas previamente verificadas que todavía estén pendientes de activación.

La activación de autorregistro sigue ahora `REGISTRATION_IDENTITY_ENABLED`; el antiguo `REGISTRATION_ACTIVATION_ENABLED` deja de condicionar este flujo. Antes de desplegar se requiere el esquema existente de S24 de contacto y `registration_account` (`s24-registration-activation`). No se añade DDL ni se modifican cuentas reales durante la implementación.

Validación: `scripts/qa/registration-email-trial-mysql.js` usa exclusivamente una base sintética aleatoria en un MySQL temporal sin red, seleccionado mediante `REGISTRATION_QA_ISOLATED=1` y `REGISTRATION_QA_SOCKET=/private/tmp/medsync-.../mysql.sock`. Comprueba códigos incorrectos/vencidos, fallo de correo, rollback, aislamiento de consultorios, confirmaciones concurrentes, duración exacta, bienvenida, caducidad y ausencia de reinicio, incluso con el antiguo flag comercial desactivado. Elimina la base sintética al terminar. También pasan las 76 comprobaciones HTTP existentes de aislamiento de cuentas pendientes, la regresión de registro del frontend, scrypt y ESLint de los archivos Vue/JS modificados.


La interfaz se comprobó en Chrome a 1440 y 390 px con respuestas de API sintéticas: envío inicial, recarga sin duplicar ni persistir el código escrito, logout/login pendiente con nuevo envío, confirmación con actualización del estado de prueba, cero llamadas a contratación y ningún desbordamiento ni excepción. La entrega real SMTP/SES y el despliegue no se ejecutaron.

La prueba histórica `d2-session-endpoint.js validate` deja sin simular la consulta de `activePrincipal` y falla en tres casos autenticados antes y después del cambio. Se reprodujo sin acceder a la base configurada. Con un doble explícito de `activePrincipal`, sus ocho comprobaciones pasan sobre los controladores actuales; se conserva el contrato sin exponer identificadores de sesión nuevos.


## Análisis de planes públicos, Billing y Legal — 2026-10-29

Decisión de producto solicitada: mostrar planes en el registro, conservar 15 días sin tarjeta y ofrecer dentro de la aplicación los días restantes y «Elegir plan». La visualización no inicia una suscripción ni cambia el plan del consultorio. La contratación es una operación posterior, con autoridad de Billing y aceptación legal central.

### Catálogo comprobado

Una consulta GET sin credenciales a `https://billing.hemia.cloud/api/v1/billing/catalog/plans?product_code=medsync` confirmó el catálogo publicado: Básico (`medsync_basic`) 499.00 MXN/mes, Profesional (`medsync_pro`) 999.00 y Clínica (`medsync_clinic`) 1299.00. Los límites publicados son respectivamente 1 profesional/1 auxiliar, 1/3 y 3/8. El catálogo devuelve importes decimales como texto, códigos de precio y mapa de funcionalidades; no expone IVA, versión, trial ni promociones y sus descripciones están vacías. No afirmar «IVA incluido» o «más IVA» sin resolver el contrato. El usuario confirmó después que los tres importes ya incluyen IVA; la presentación actual los etiqueta de esa forma.

La API pública ya existe en Billing (`apps/api/src/modules/catalog/controllers/billing-catalog-public.controller.ts`), filtra planes y precios activos de versiones publicadas y anuncia caché de 60 segundos. No necesita SSO, SDK ni cambios de Billing para la consulta básica. Balanz obtiene su catálogo autenticado mediante `@hemia/payments` y representa precios/períodos/funciones desde ese contrato; no se debe copiar su integración NestJS a Express ni sus componentes React a Vue.

El catálogo local `src/config/saasPlans.js` conserva precios distintos (499/799/1499), etiquetas de IVA y promociones de fundador. No usarlo como fuente comercial nueva. Los códigos internos son `basic/pro/enterprise`; la correspondencia futura con Billing debe ser explícita: `medsync_basic→basic`, `medsync_pro→pro`, `medsync_clinic→enterprise`. No cambiar el plan o los límites de un cliente por el mero hecho de consultar o seleccionar una tarjeta.

Durante el análisis se corrigió un error del cambio anterior: la prueba guardaba `professional`, código ajeno al catálogo local de límites. Ahora guarda `pro`; el catálogo y las capacidades del dashboard reconocen también el alias anterior para compatibilidad sin migrar datos. La comprobación MySQL aislada valida límites de Profesional, capacidades y continuidad de los 15 días.

### Integración mínima de visualización en MedSync

1. Reutilizar `commercialAdapter` para consultar el catálogo público desde el backend, con producto fijo, tiempo de espera, caché corta, validación de DTO y respuesta de indisponibilidad honesta. Crear una lectura pública para el registro que no dependa de sesión, correo verificado, documentos de contratación ni disponibilidad del proveedor de pagos. La caída de Billing no debe impedir registrarse o verificar el correo.
2. Añadir tarjetas Vue compartidas para registro y vista de planes; importes desde Billing, moneda/período explícitos y etiquetas de funciones que correspondan a los códigos reales. Resolver el tratamiento de IVA antes de mostrar el precio final. No anunciar promociones o funciones que no estén en el catálogo vigente.
3. Exponer en el estado autenticado del consultorio la fecha final de prueba y el cálculo de días restantes basado en hora del servidor. Mostrar el aviso con «Elegir plan» para la persona autorizada; permitir consultar planes y contratar también cuando la prueba ya venció. La consulta y el botón no renuevan la prueba ni activan una suscripción.
4. Mantener los términos y privacidad del registro y la prueba sin tarjeta. No mostrar controles que prometan realizar un pago mientras la integración privada no esté lista.

### Contratación y Legal central

Legal permite consumidores con usuarios locales; no obliga a migrar a SSO. Mostrar planes no necesita aceptación de contratación. Para pagar se requiere configurar el sistema/cliente MedSync y producto permitido, URLs de retorno, clientes OAuth M2M y callback técnico de contexto. El backend debe derivar usuario, consultorio y sesión de su autenticación, comprobar autoridad para contratar y mapear los UUID que exige el contrato externo.

Legal necesita inventario administrativo de solo lectura de emisor, aplicación, documentos, versiones publicadas, reglas vigentes y registro de integración con `documentIds` explícitos. El contrato actual admite entre 1 y 100 documentos; no asumir tres documentos fijos ni usar documentos QA. Los endpoints externos preparan aceptación, registran confirmaciones de versiones/hash y permiten a Billing validar evidencia ligada al producto, comprador y consultorio. Las aceptaciones MySQL actuales de MedSync no equivalen automáticamente a esa evidencia central.

Brecha comprobada: Balanz exige MFA al contratar; Legal registra actualmente el método fijo `external_local_mfa`. La contraseña y el código de verificación inicial de correo de MedSync no deben convertirse silenciosamente en esa evidencia. Antes de habilitar checkout se necesita MFA real o ampliar el contrato para representar/verificar el método de autenticación que corresponda. Esto no bloquea el catálogo ni el trial gratuito.

Los pagos requieren confirmar conexión/proveedor/precios y permisos privados, idempotencia, retornos sin otorgar acceso desde parámetros del navegador y sincronización duradera del estado confirmado por Billing. Definir explícitamente si una compra durante la prueba cobra de inmediato o comienza al vencer los 15 días; no cobrar ni prometer días conservados sin implementar esa regla. La proyección local actual debe reconocer el plan comprado y no exigir siempre `pro` para todos los futuros planes de pago.

Esta revisión no publicó planes/documentos, no cambió Billing/Legal ni ejecutó migraciones o pagos. El catálogo público se verificó mediante GET; la configuración privada de MedSync y el inventario legal no se han comprobado. La corrección del código de plan de prueba quedó aplicada y probada en local. La implementación posterior de tarjetas y aviso se detalla a continuación; el checkout sigue pendiente.


## Visualización implementada con IVA incluido — 2026-10-29

El usuario confirmó que 499/999/1299 MXN ya incluyen IVA. `commercialAdapter` consulta exclusivamente el catálogo público de producto `medsync`; valida campos y conserva los importes como texto decimal, sin usar precios/promociones del catálogo local. Añade `taxBehavior=inclusive`, `trialDays=15` y `checkoutAvailable=false` como contrato de presentación de MedSync. Los impuestos aún no proceden del contrato público de Billing: si cambian sus reglas comerciales, habrá que actualizar esa metadata y conviene incorporarla en Billing como fuente común.

La lectura pública `GET /api/registration/plans` devuelve `{available,offers,...}` y no requiere sesión, disponibilidad de registro, entrega de correo ni base de datos. El adaptador usa timeout de cinco segundos, rechaza redirecciones, limita tamaño de respuesta, comparte consultas concurrentes y conserva respuestas válidas durante 60 segundos. Ante fallo devuelve catálogo no disponible durante diez segundos, sin filtrar detalles de red ni sustituir precios con valores locales. El registro y la confirmación de correo siguen independientes de esa lectura.

El formulario Vue muestra tarjetas compactas antes de los consentimientos y del botón de creación, con precios, moneda, periodicidad, IVA incluido y límites publicados. «Comparar todos los beneficios» expande únicamente las funciones presentes y activas en el catálogo. Los códigos no reconocidos se omiten; no se deducen prestaciones de nombres o del precio. No se guarda una selección de tarjeta como plan contratado.

El layout de usuarios autenticados incluye `TrialNotice`: informa los días restantes y ofrece «Elegir plan» a administradores del consultorio. Abre el mismo catálogo en un diálogo y mantiene disponible la consulta cuando vence la prueba. No presenta un botón de pago operativo. Los usuarios auxiliares pueden ver el estado de prueba sin controles de contratación. La respuesta de sesión publica `trialEndsAt`, `trialDaysRemaining` y `serverNow`; el aviso usa la referencia horaria del servidor, actualiza la cuenta cada minuto y cierra su diálogo al cambiar el contexto del consultorio. La información visual no otorga permisos ni cambia el control operativo del backend.

El catálogo informa que el registro no cobra y que los pagos aún no están habilitados. Las aceptaciones de registro permanecen locales; no se creó evidencia central ni se simula MFA. Para habilitar contratación continúan pendientes el inventario/configuración de Legal, conexión privada de Billing, método real de autenticación y sincronización de suscripciones confirmadas descritos en el análisis anterior.

Comprobaciones: `scripts/qa/registration-plans-regression.js` valida producto fijo, dinero decimal, IVA, caché/concurrencia, fallo de red/respuesta inválida, checkout bloqueado, HTTP público sin dependencias de registro y proyección de días en sesión. Se añadió al ejecutor de regresiones aisladas. En frontend, `scripts/qa/registration-plans-regression.cjs` compila las tres plantillas y comprueba métodos reales de dinero, periodicidad, beneficios, errores, contexto, roles y días basados en hora del servidor. Pasan además la regresión de registro existente, ESLint de archivos modificados y comprobación de diferencias. Chrome a 1440 y 390 px verificó las tarjetas/IVA del registro, fallo de catálogo sin bloquear creación, aviso de días, diálogo durante y después de la prueba, ausencia de llamadas a checkout y ausencia de desbordamientos/excepciones, con API sintética. El adaptador se comprobó también mediante un GET al catálogo público real. No se desplegó código ni se ejecutaron pagos, publicaciones legales, migraciones o cambios en cuentas reales.
