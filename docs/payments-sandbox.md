# Checkout MedSync con Billing local

MedSync Express usa `@hemia/payments@0.14.0` desde el tarball local versionado y
`@hemia/auth@1.1.0` con su entrada Node. No utiliza el adaptador Nest ni guarda
operaciones financieras locales. Las credenciales PayPal y los IDs de planes se
administran en Billing; MedSync sólo recibe el catálogo comercial y los recibos
centrales mediante OAuth de servicio.

El catálogo público y el privado conservan `name`, `description`, `prices` y
`featureDetails` del SDK, además del mapa `features` para los consumidores
existentes. La comparación usa los nombres descriptivos publicados; si Billing
devuelve el propio código como nombre del beneficio, la interfaz lo traduce al
español. Disponibilidad y cantidades siempre proceden del catálogo. No se
asigna un plan destacado por su código.

## Flujo de alta

1. Crear la cuenta y aceptar los documentos de registro existentes.
2. Verificar el correo con el flujo actual.
3. Elegir un plan y contratar, o continuar gratis durante la prueba de 15 días.
4. Los documentos se precargan mientras se consultan los planes. Se leen dentro
   de un modal; las versiones exactas aceptadas en el registro no repiten casilla.
   Un documento nuevo o modificado sí requiere aceptación o acuse explícito.
5. «Continuar con el pago» conserva la clave del intento, confirma la
   contratación y crea el checkout. «Pagar con PayPal» abre la ventana de
   aprobación del mismo contrato; el enlace original queda como alternativa.
6. La pantalla recibe snapshots por el canal persistente del backend después
   del webhook. No consulta pagos por intervalos ni al cerrar o aprobar PayPal.
   La carga inicial y recuperación manual leen la copia local del mismo
   contrato; la URL de retorno nunca confirma ni crea una contratación.

El trial sigue comenzando al verificar el correo. Continuar gratis no lo
reinicia, no cambia sus fechas ni depende de que Billing esté disponible.
La elección se integra al alta mediante la pantalla `/cuenta/planes` y mantiene
los destinos de preparación/inicio determinados por el estado del servidor.
También se puede continuar con la prueba tras regresar del proveedor con un
intento pendiente; esa salida no cancela, verifica ni elimina la contratación.

Al volver a `/cuenta/planes`, antes de preparar otro consentimiento o enviar un
checkout, el frontend consulta `subscriptions.current`. Si Billing señala un
`pendingCheckoutAttemptId`, lee ese intento con el comprador de la sesión y
valida consultorio, producto, plan, precio y suscripción. Una entrada genérica o
la misma oferta retoma la clave y aprobación originales mediante reemplazo de
la URL; no genera otra clave, aceptación ni contrato. Una oferta distinta
requiere abrir explícitamente la solicitud existente. Un intento de otro
comprador, inconsistente, abandonado o terminado nunca se adopta.

Esta recuperación también cubre un duplicado rechazado y el conflicto entre
pestañas después de enviar un checkout: se vuelve al original sin reintentar,
verificar ni cancelar operaciones. El rechazo de Billing a un segundo contrato
pendiente se conserva; no se reactiva el duplicado ni se falsea un estado listo.

La confirmación de pago exige `license.billing.checkoutConfirmation`, además de
suscripción y licencia actuales activas, vinculadas al intento, plan, precio y
comprador del consultorio. Una suscripción activa sin prueba del cobro inicial
permanece pendiente de confirmación; no se interpreta como un pago fallido.
`status: ready` sólo indica que existe un recibo de checkout; no concede acceso.
MedSync proyecta la licencia verificada en `business` y el frontend vuelve a
consultar su sesión. El botón para continuar exige tanto la confirmación de
Billing como plan local correcto, licencia aplicada y operación autorizada.
Un fallo al guardar o refrescar deja la confirmación de acceso pendiente; se
recupera consultando el mismo intento, sin iniciar otra compra. La pantalla de
éxito muestra el importe realmente pagado y el precio recurrente del comprobante,
sin reconstruirlos desde el catálogo. Sólo muestra una próxima renovación si es
futura, coincide con la suscripción actual y no hay cancelación pendiente.

Antes de la aprobación se identifica el plan solicitado sin afirmar un cobro.
Una preparación pendiente conserva la misma solicitud y permite consultar
manualmente; no usa espera progresiva ni reenvía una creación automáticamente.

Checkout usa `/api/payments/subscription/events`: D2 mediante cookies y legacy
mediante streaming fetch con Authorization. El payload contiene la copia local
validada y sólo se publica tras el commit del webhook. Las revisiones anteriores,
repetidas, de otro producto o consultorio no sustituyen los datos vigentes.
El canal se cierra al cambiar identidad/ruta, vencer la credencial o confirmar
el acceso; renovar la credencial reabre el canal sin consultar pagos. El endpoint
antiguo de avisos vacíos por intento permanece por compatibilidad, pero esta
pantalla ya no lo utiliza ni hace GETs por cada aviso.

El transporte actual entrega eventos dentro de un proceso de API. Antes de
desplegar varios workers/instancias se requiere pub/sub compartido para mantener
esa actualización en vivo entre procesos. Sin eventos disponibles se hace una
lectura inicial, y queda la acción explícita «Actualizar estado»; no se degrada a
consultas periódicas. La licencia y el correo siguen siendo persistentes y no
dependen de mantener abierta esta conexión.

La espera posterior muestra un estado estable, sin animación indefinida, y deja
continuar a MedSync. Si se vuelve sin terminar la contratación, ofrece volver a
PayPal conservando la misma solicitud. «Actualizar estado» no crea ni verifica
pagos; las operaciones de recuperación quedan bajo un desplegable excepcional.
La ventana de contratación inicial no ofrece ni ejecuta una verificación financiera; su aprobación
sólo inicia la espera del webhook.

## Historial de pagos del consultorio

`GET /api/payments/history` consulta el ledger de Billing mediante
`client.payments.list`. Exige una sesión nativa vigente de administrador y deriva
el consultorio de esa sesión. El navegador sólo puede enviar un `cursor` opaco;
no puede escoger organización, producto, suscripción, proveedor ni tamaño de página.
Se reutiliza el permiso de servicio `billing.subscriptions.manage` ya concedido a
MedSync. Esta consulta no acepta contratos, verifica PayPal, captura ni reintenta pagos.

La respuesta es `{items,nextCursor}` con hasta 25 pagos de todas las suscripciones
del consultorio para el producto `medsync`. Incluye contratación inicial,
renovaciones y prorrateos registrados por Billing, sin depender del plan vigente
ni de `license.billing.checkoutConfirmation`. Sólo admite pagos realizados
(`paid`, `partially_refunded`, `refunded`, `reversed`), nunca intentos pendientes
o fallidos. Los importes son cadenas decimales del ledger y no se reconstruyen
desde el precio recurrente, catálogo ni cotización del cambio.

Cada fila conserva fecha pagada o fecha de registro cuando `paidAt` es nulo,
moneda, descripción, estado y referencia de la transacción/captura PayPal.
`refundedAmount`, cuando existe, procede del ledger de reembolsos confirmados.
La referencia no es una URL de aprobación ni una factura fiscal. No se inventan
PDF/CFDI: el comprobante PayPal se consulta en la cuenta del comprador.
Los errores del historial no ocultan la suscripción ni afirman ausencia de pagos.
La interfaz consulta otra página explícitamente y refresca la primera al recibir
una revisión nueva del snapshot; no programa polling ni mutaciones financieras.

Verificación local del 17 de noviembre de 2026: SDK 0.14.0 y preflight de servicios
correctos; 84 pruebas backend y regresiones frontend de historial, facturación,
cancelación, contratación y cambio de plan aprobadas. La interfaz autenticada
mostró cuatro registros existentes de PayPal: contratación, prorrateo y dos
pagos devueltos, con fechas, importes y referencias. La comprobación sólo leyó
registros; no autorizó ni creó pagos.

## Cambio de plan autogestionado

Desde Plan y facturación se abre `/cuenta/cambiar-plan` con el plan y precio
elegidos. El catálogo, la suscripción de origen y la cotización proceden de
Billing. MedSync no calcula prorrateos ni decide fechas: muestra `amountDueNow`,
`recurringAmount`, moneda, `effectiveAt` y `nextBillingAt` de la cotización.
Un downgrade programado conserva el plan vigente hasta la fecha informada.

- `GET /api/payments/subscription/plan-change-quote` recibe
  `expectedSubscriptionId`, `targetPlanCode` y `targetPlanPriceCode`. Contrasta
  la suscripción actual con el consultorio de la sesión y devuelve la
  cotización del SDK, sin modificar pagos.
- `POST /api/payments/subscription/change-plan` recibe únicamente
  `idempotencyKey`, `expectedSubscriptionId`, `planCode`, `planPriceCode`,
  `expectedAmountDueNow` y `legalAcceptanceId`. El máximo aceptado es una
  cadena decimal; Billing revalida el importe antes de preparar el cambio.
  El servidor fija comprador, `operation: change_plan` y URLs de retorno.
- `POST /api/payments/checkout-attempts/:id/confirm` recibe `{}`. Lee el
  intento vinculado al comprador, exige la operación correcta y los IDs
  originales, llama a `attempts.confirm`, aplica el snapshot validado y relee
  el mismo recibo. Este endpoint puede capturar una orden ya aprobada como
  continuación de la autorización del comprador o recuperación manual.
- `POST /api/payments/checkout-attempts/:id/cancel` recibe `{}`. Descarta
  únicamente una preparación de cambio de plan del mismo comprador. No cancela
  la suscripción ni la renovación: cambios efectivos, programados o con una
  aprobación de diferencia pendiente requieren conservar/reconciliar el cambio.
  `cancelled:true` exige releer el recibo cancelado y la suscripción sin otro
  pendiente activo. `cancelled:false` puede incluir una URL segura para restaurar
  el acuerdo anterior en PayPal; no permite iniciar otra revisión todavía.

Todas las mutaciones conservan administrador, membresía nativa, correo
verificado, Origin y CSRF de sesión. El cambio usa un UUID durable conocido
antes de aceptar condiciones o crear el intento. Se conserva el cuerpo
inmutable ante una respuesta incierta; únicamente un 404 de la misma clave
permite tratarla como nueva. Salir con X o Atrás antes de autorizar descarta
la preparación y devuelve la selección de plan. Una respuesta incierta conserva
el mismo ID y se recupera con lecturas canónicas; nunca se presupone cancelada.
Un 404 comprobado y una suscripción sin pendiente permiten salir de una revisión
que nunca llegó a crear un intento, sin enviar otra cancelación.
La comparación permite elegir otra vez incluso con un borrador anterior;
antes de abrir la nueva revisión confirma su descarte, también para la misma
oferta. Cambios autorizados o programados mantienen su solicitud protegida.
Los estados `effective` y `failed` no bloquean una revisión nueva válida.

PayPal puede exigir aprobar primero el acuerdo recurrente y después una orden
por la diferencia del periodo. La pantalla sólo ofrece el enlace canónico
para `approve_subscription` o `approve_payment`; `none`, `scheduled` y
`effective` no vuelven a enviar al proveedor. El parámetro `result=approved`
no prueba que haya una autorización ni un pago. Las consultas ordinarias y
los eventos SSE sin un retorno correlacionado no ejecutan confirmaciones,
verificaciones, capturas ni cancelaciones.

En la revisión, «Continuar con PayPal» usa el gráfico completo oficial alojado
en `paypalobjects.com`. El mismo clic acepta las condiciones seleccionadas,
prepara el intento y continúa al enlace canónico de autorización, si existe.
El botón permanece deshabilitado sin consentimiento o durante la preparación.
Si Billing responde todavía en preparación, ese clic conserva únicamente en
memoria la intención de continuar: la lectura del mismo recibo al recibir una
revisión nueva puede abrir el enlace cuando esté listo. Se consume una vez y
se descarta al salir, recargar, cambiar de identidad o recibir un error; no se
restaura desde la URL ni ejecuta confirmaciones financieras.
No se crea una nueva sesión de suscripción PayPal para revisar el acuerdo
existente; se conserva la redirección de Billing.

Antes de abrir PayPal se registra en `sessionStorage` comprador/sesión,
intento, checkout, suscripción, oferta, acción y hash SHA-256 del enlace; no
se guarda la URL ni sus tokens. Al volver aprobado se relee el recibo y se
comprueba que corresponda a esa salida. La misma etapa y URL (o URL nula
durante la recuperación del prorrateo) permiten continuar automáticamente
con `attempts.confirm`. El marcador se consume antes del POST, por lo que
una recarga o un resultado incierto no lo repiten automáticamente. Billing
verifica la aprobación real, importe y moneda y conserva la idempotencia
de la captura. El navegador no concede acceso a partir del marcador.

Si la etapa ya avanzó, se consume el retorno anterior sin confirmar la
aprobación siguiente. Antes de abrir otra autorización se limpia el resultado
anterior de la URL. Cancelación, otro comprador/sesión, URL distinta o ausencia
del marcador no causan confirmación automática. El regreso cancelado de una
aprobación inicial registrada puede descartar esa preparación; no descarta una
etapa que ya requiere aprobar el prorrateo. Sin almacenamiento disponible
o tras un fallo, queda recuperación manual sobre el mismo intento; la consulta
de estado sólo lee. Ya no se exige «Ya autoricé en PayPal» en el flujo normal.
La restauración se distingue mediante `cancellationRequested` y el enlace
canónico del recibo. Su marcador usa `cancel_change` y al volver invoca
`cancel`, nunca `confirm`. Sólo al confirmar el descarte se abre la nueva
revisión con los códigos elegidos; no se guardan URLs o tokens de restauración.

El estado efectivo exige el recibo `change_plan` y un snapshot con organización,
producto, suscripción, plan y precio objetivo coincidentes, además de licencia
activa. La sesión debe refrescarse con el nuevo plan antes de afirmar que sus
funciones están disponibles. Al confirmar ese acceso, la vista vuelve
automáticamente a Inicio (`/inicio`) mediante `router.replace`, una sola vez.
Un cambio programado confirmado también vuelve al consultorio sin conceder
el plan futuro antes de su fecha. La espera de licencia, los errores y una
sesión desactualizada mantienen la pantalla de recuperación. No se reutiliza
la prueba del pago de alta, que puede seguir identificando el plan original.
Si ya hubo autorización se conserva el intento; el regreso de sesión mantiene la operación
`change_plan` tanto en D2 como en legacy.

## Acceso pagado, renovaciones y bajas

La migración `payments-license-projection.js` agrega a `business`:
`billing_snapshot` (JSON), `billing_revision` (DECIMAL exacto) y
`billing_access_until` (DATETIME). No almacena secretos ni datos PayPal.
El snapshot completo viene del SDK y contiene producto, organización,
suscripción, licencia, revisión y fecha central de confirmación.

Una transacción bloquea el negocio, valida el producto/organización y aplica
sólo revisiones mayores. Incluso antes del primer pago se conserva la última
revisión observada en el JSON, para que una activación antigua no supere una
baja más reciente. `billing_revision` permanece en cero hasta el primer acceso
pagado válido; observar una licencia ausente, pendiente, vencida o desconocida
no consume la prueba ni cambia sus fechas. Las cuentas pendientes de verificar
correo tampoco obtienen acceso por recibir un snapshot.

Después del primer acceso pagado ese marcador nunca vuelve a cero. Las bajas
restringen la cuenta sin restaurar la prueba. Los flags administrativos `active`
y `status`, las fechas históricas del trial, los usuarios y sus roles se
conservan. Los endpoints administrativos locales rechazan cambios de plan,
estado comercial, ampliación de prueba y overrides de cuotas de estas cuentas;
su fuente comercial pasa a ser Billing.

Los códigos explícitos son `medsync_basic → basic`, `medsync_pro → pro` y
`medsync_clinic → enterprise`. Un código desconocido no concede acceso.
Las cuotas salen de `professionals.included`, `users.auxiliary.included` y
`branches.included`; una cuota ausente o inválida equivale a cero, no a ilimitado.
Los overrides locales no amplían una licencia de Billing. Los controles de
plantillas, documentos avanzados y dashboard usan sus flags centrales y
conservan los permisos de rol. El catálogo actual no define una capacidad
central de plantillas de documentos premium: esa función permanece denegada
para licencias de Billing hasta definirla explícitamente en el catálogo.
Los usuarios existentes no se eliminan si una bajada reduce la cuota; se
impiden ampliaciones por encima de sus límites mediante los controles existentes.

La actualización automática procede del webhook de Billing. Se mantienen
consultas manuales explícitas de administración; autenticar o refrescar la
sesión no consulta Billing y no hay job de conciliación periódica en MedSync.
Una copia sólo permite acceso hasta el menor de `validUntil` y
`confirmedAt + 24 horas`, usando `snapshotAccess` del SDK. Leer o reenviar la
misma revisión no renueva esa fecha. Las guardas y sesiones deniegan operación
pagada tras su vencimiento; no se amplía la vigencia desde el navegador.
Billing ya renueva la entrega firmada cada seis horas desde su outbox, con
snapshot y revisión nuevos calculados desde su base de datos, sin consultar
PayPal. Ese worker y el receptor deben seguir activos para conservar la
frescura de la copia de 24 horas entre renovaciones mensuales.

Una cancelación programada mantiene los beneficios mientras la licencia siga
vigente; al hacerse efectiva, la revisión nueva restringe el acceso. Las
renovaciones, cambios de plan y el período de gracia se aplican según la licencia
central; MedSync no calcula cobros ni inventa extensiones comerciales.

## Correo de bienvenida al plan contratado

Billing incluye opcionalmente `license.billing.checkoutConfirmation` en el
snapshot autenticado del SDK, con el pago inicial confirmado, comprador,
contrato, importe efectivamente pagado, moneda, precio recurrente y periodicidad.
El SDK 0.12 conserva este grupo; no requiere otra versión. Una suscripción
`active` o licencia en gracia, sin esa prueba de cobro, no genera correo.
Billing no sustituye un pago inicial reembolsado/reversado por una renovación,
ni usa cobros de complementos, cambios de plan o renovaciones programadas como
una nueva contratación. La confirmación solo existe cuando dispone de evidencia
del primer ciclo y de la misma conexión PayPal; no hay backfill por inferencia.

MedSync guarda `payments_welcome_outbox` dentro de la misma transacción que
proyecta la licencia. Su clave primaria es `subscription_id`, por lo que
reenvíos del webhook, revisiones nuevas, consultas, renovaciones y reinicios
conservan un único evento por contrato. No se deduplica por revisión ni por
el identificador de cada mensualidad. El payload comercial se conserva; no se
consulta el catálogo actual para reconstruir importes. Cuando Billing no tiene
un nombre de plan congelado se usa la etiqueta canónica local del SKU conocido.

Un job cada 15 segundos usa la plantilla de bienvenida ya publicada en SES:
`EMAIL_REGISTRATION_WELCOME_TEMPLATE`. El mensaje interno es
`subscription-welcome`, con el remitente y Configuration Set de autenticación.
Conserva la bienvenida a la prueba como un flujo separado. Antes de enviar,
revalida que el comprador siga siendo administrador activo de ese consultorio,
con correo verificado, y que la licencia y el contrato sigan vigentes. No toma
destinatario, importes, producto ni estado de la URL o el navegador.

La verificación del correo inicia la prueba y deja su bienvenida en cola, pero
no la envía mientras el usuario elige plan. «Continuar gratis» confirma
`trialWelcome: true` al reconocer la bienvenida; salir desde un checkout pendiente
envía `trialWelcome: false` y consume ese evento sin mandar un correo de prueba.
La confirmación de un plan pagado usa exclusivamente su outbox de contratación.
Un reconocimiento sin el campo conserva el comportamiento anterior. Las fechas
de la prueba no se reinician ni se modifican con esta elección.

El remitente local QA usa una copia `medsync-dev-*` en la cuenta AWS de QA,
distinta de la cuenta DEV. Publicar sólo DEV/PROD no sincroniza esa copia.
El workflow `terraform-medsync-email-qa.yml`, scope `welcome`, publica únicamente
la bienvenida QA, verifica igualdad con la fuente y renderiza ejemplos públicos
de prueba y plan pagado sin enviar correos ni modificar Terraform/DNS. Conserva
la plantilla anterior y los renders en un artefacto por siete días.

La fecha y el aviso de renovación solo se incluyen si Billing los confirma,
siguen siendo futuros y no hay cancelación pendiente/programada. El importe
pagado puede diferir del precio recurrente. El enlace `/login` se construye
desde `PUBLIC_APP_URL`; los valores HTML se escapan en el proveedor SES.

El worker bloquea y reclama el evento en MySQL **antes** de llamar a SES.
`claimed_at`, `sent_at` y `error_code` permiten consultar su resultado sin
guardar direcciones, secretos o respuestas del proveedor en la cola. SES no
ofrece clave de idempotencia para SendEmail: la garantía es como máximo un
intento de envío por suscripción, no entrega exactamente una vez. Una caída
después de reclamar o una respuesta de SES no confirmada deja el evento
sin reenvío automático (`EMAIL_DELIVERY_UNCONFIRMED`, o reclamado sin `sent_at`).
Reenviarlo sin comprobar el proveedor podría duplicar un correo ya entregado.
Si SES o su configuración no están listos, el job no reclama eventos.

La migración es aditiva y el arranque con Payments exige las columnas y la
clave única. Antes de desplegar en cada ambiente:

```bash
node scripts/migrations/payments-welcome-outbox.js --expect-database=<base>
node scripts/migrations/payments-welcome-outbox.js --expect-database=<base> --apply
```

La tabla se creó y verificó únicamente en desarrollo local. No se migró ni
desplegó MedSync/Billing en producción. Las plantillas de `hemia-infra` sí
están publicadas en SES DEV/PROD; eso no despliega estos procesos.

Validación: `npm run qa:payments`,
`node scripts/qa/ses-email-provider-regression.js` y
`node scripts/qa/payments-welcome-mysql.js --local`. La última usa una conexión,
tablas TEMPORARY y datos sintéticos: verifica unicidad, workers concurrentes,
rollback de licencia/cola y destinatario verificado, con un emisor falso.
Las pruebas no crean compras, aceptaciones ni envíos reales.

## Identidad y consentimiento

`organizationId`, `userId` y `sessionId` se derivan de los UUID nativos
`id_business`, `id_login` e `id_session`, tras validar sesión, negocio y rol
administrador vigentes en SQL. Son identidades del consumidor MedSync, no IDs de
Access. El cliente de servicio sólo está autorizado para el producto `medsync`.

Para el callback de Legal, `membershipId` es UUIDv5 del par business/login ya
validado: `medsync-membership:<business>:<login>`, namespace `uuid.URL`. Esa
referencia representa la asociación nativa y no crea una membresía de Access.
La preparación/aceptación exige la sesión exacta vigente; la validación de una
contratación vuelve a comprobar asociación, rol, correo y estado actuales.

El consentimiento de registro no sustituye la aceptación de contratación.
Payments prepara una solicitud central nueva sin aceptar por el usuario. MedSync
descarga sus documentos únicamente desde los orígenes HTTPS configurados, sin
redirecciones ni credenciales, limita su tamaño y comprueba SHA-256 antes de
enviarlos al navegador. El modal aplica además la lista HTML permitida existente.
Para omitir una casilla se exige recibo central del mismo usuario/consultorio,
documento, versión y hash, o la evidencia COMMIT del registro local mientras
se entrega su outbox. Esta última debe coincidir con el actor, consultorio,
evento, versión, hash y acción del descriptor vigente de registro; no inventa
un recibo central ni sustituye la aceptación del checkout. Si no se puede
comprobar, se pide la aceptación actual.
El clic explícito en «Continuar con el pago» crea una nueva evidencia de contratación
con la sesión verificada; no reutiliza el evidenceId del registro como acceptanceId.
`/api/payments/legal/context` usa firma OAuth e introspección del SDK, con
`legal.consumer_context.read`, cliente Legal permitido y audiencia `medsync-api`.
No acepta una cookie de navegador como autenticación de servicio.

Las mutaciones de navegador exigen Cookie D2, Origin exacto y CSRF de sesión.
El navegador no elige organización, usuario, proveedor, importe ni URLs de
retorno. El servidor fija `/cuenta/planes?attempt_id=<uuid>&result=...` sobre el
origen configurado. Los GET no crean, verifican ni reintentan pagos.
Consultar la licencia puede actualizar su copia local desde Billing; la query
del navegador nunca se interpreta como evidencia de pago.

## Intentos y recuperación

El UUID `idempotencyKey` se conoce antes del primer POST y también es el ID
central del intento. La pantalla lo conserva en la URL para recuperar un
resultado perdido o retomar tras iniciar sesión. Reintentar un intento existente
usa su configuración congelada por Billing y no el formulario que esté abierto.

Si la creación nunca alcanzó Billing y la consulta devuelve 404, la reconstrucción
se realiza sólo por acción explícita, conservando la misma clave de checkout.
Una selección/aceptación diferente no puede sobrescribir un intento que aparezca
concurrentemente: Billing responde con conflicto y se vuelve a consultar.
La preparación de documentos tiene su propia clave y puede renovarse si caduca.

## Configuración local

El backend utiliza `PAYMENTS_CONNECTION` (ejemplo en `.env.example`) y el par
`HEMIA_CLIENT_ID`/`HEMIA_CLIENT_SECRET` existente. El clientId del JSON debe
coincidir con ese par. Los secretos nunca se copian a `VUE_APP_*`, URL ni estado
persistente del navegador.

Destinos locales:

| Servicio | URL |
| --- | --- |
| MedSync web | `http://localhost:8080` |
| MedSync API | `http://localhost:3009` |
| Billing API | `http://localhost:3015/api/v1` |
| Legal | `http://localhost:3017` |
| Identity | `http://localhost:4000` |

El túnel de desarrollo `billing.khr0x.com` dirige al Billing local en
`http://localhost:3015`. Se verificó el 11 de noviembre de 2026 leyendo la
configuración efectiva de `cloudflared` y comprobando que una petición pública
incrementó el contador del túnel local. El webhook Sandbox registrado es
`https://billing.khr0x.com/api/v1/billing/webhooks/paypal/58c30936-29bd-4748-b12d-b8217716764c`.
La app Sandbox autenticó correctamente y sus dos planes remotos están activos,
con precios coincidentes de 499 y 999 MXN mensuales. Estas comprobaciones no
crearon compras ni aceptaciones. Mantener el túnel y los servicios locales
encendidos durante la prueba; los retornos del comprador abren MedSync local.

La política de desarrollo del cliente `medsync-backend` permite únicamente el
producto `medsync`, organizaciones nativas de ese producto, recibos no
compartidos y retorno a `http://localhost:8080`. Sus destinos OAuth incluyen
catálogo, crear/leer checkout, leer licencia y administrar suscripciones de Billing.
Legal tiene un destino hacia el callback de MedSync y Billing tiene rol de
validador en la fuente legal MedSync. Se conservaron los documentos publicados,
las reglas y el document set de registro `collector_attested`.

El receptor de licencias de desarrollo está habilitado en Billing con URL
`http://localhost:3009/api/payments/webhooks/license`, recurso
`http://localhost:3009`, audiencia `medsync-api` y cliente de servicio
`billing-legal-service`. Su destino OAuth permite `billing.webhooks.deliver`.
GET prueba disponibilidad con `productCode=medsync`; POST recibe el snapshot.
Ambos exigen firma/JWKS, introspección activa y `x-billing-timestamp` dentro de
cinco minutos mediante el SDK; una cookie no sustituye ese token.
Billing reintenta entregas, por lo que pueden repetirse y llegar fuera de orden.

El JSON local habilita HTTP loopback únicamente fuera de producción. Antes de
producción se deben publicar los destinos del entorno, usar HTTPS y probar la
configuración correspondiente; el JSON local no se reutiliza en producción.

## Arranque y comprobaciones

Usar Node 22.12 o posterior de la línea 22, según `engines` del backend.

```bash
# Backend MedSync
npm ci --ignore-scripts
# Antes de desplegar el código nuevo, con el nombre exacto de la base destino:
node scripts/migrations/payments-license-projection.js --expect-database=<base>
node scripts/migrations/payments-license-projection.js --expect-database=<base> --apply
npm run dev:d2

# Frontend MedSync, en su checkout y otra terminal
npm run serve:d2 -- --port 8080

# Billing, en su checkout
bun run dev:stack

# Legal, en su checkout
bun run dev:api
```

La instalación local existente de Legal tenía enlaces aislados duplicados de
Nest. Se repararon sus dependencias generadas mediante instalación hoisted sin
cambiar su lockfile ni fuentes; el directorio anterior de enlaces de API quedó
respaldado en `/private/tmp`. Esto no cambia el contrato del SDK MedSync.

Desde el backend MedSync:

```bash
npm run qa:payments
npm run qa:payments-local
# SQL real sólo en desarrollo local; tabla TEMPORARY que oculta business:
node scripts/qa/payments-license-mysql.js --local
```

El segundo comando verifica servicios, compatibilidad, catálogo y scopes
OAuth reales de desarrollo. No prepara documentos, acepta contratos ni crea,
verifica o reintenta pagos. El SDK y sus pruebas HTTP con dobles cubren el flujo
sin dinero ni llamadas financieras reales.
La prueba SQL usa una sola conexión y sólo datos sintéticos en una tabla temporal;
verifica revisiones mayores de 2^53, literales DECIMAL, orden y rollback atómico.
La migración ya se aplicó y verificó en desarrollo local. El arranque de MedSync
exige estas columnas cuando `PAYMENTS_CONNECTION` está configurado.

La recepción de webhooks desde PayPal requiere la URL pública HTTPS registrada
en la misma app Sandbox. `localhost` no es alcanzable por PayPal. El retorno
manual permite comprobar el estado central, pero no sustituye probar la entrega
del webhook antes de utilizar renovaciones y notificaciones en un despliegue.

## Prueba manual Sandbox

Con una cuenta administradora de correo verificado, abrir `/cuenta/planes`.
Seleccionar Básico o Profesional y abrir los documentos en sus modales. Las
versiones aceptadas en el registro deben aparecer reconocidas; sólo se marcan
los documentos nuevos o modificados. Pulsar «Continuar con PayPal» reserva la
ventana en ese mismo clic, acepta las condiciones y prepara el mismo intento.
Cuando el recibo está listo, la ventana continúa a PayPal sin otro clic ni
redirección de la pestaña principal. Usar una
cuenta compradora Sandbox distinta de la comerciante.
Al volver, esperar la confirmación automática: antes del cobro debe mostrarse la
espera y después el plan activo, importe efectivamente pagado y acceso habilitado.
Comprobar que recibo, suscripción, licencia y comprador coincidan.
Comprobar además que la sesión de MedSync diga `billingManaged: true`, estado
activo, plan local esperado y `billingAccessUntil` futuro, sin mostrar la opción
de continuar gratis. Con un error de sincronización, consultar el mismo intento
debe recuperar el acceso sin volver a aprobar el pago.

Probar también cancelar el regreso, interrumpir red, recargar con `attempt_id`
y reingresar tras expirar la sesión. Ninguno de esos eventos activa un pago
por la query ni crea automáticamente una segunda contratación.

En Sandbox, cancelar desde Billing y revisar la entrega de la nueva revisión a
MedSync; probar tanto cancelación al final del período como baja efectiva.
Las pruebas automáticas cubren estos estados con snapshots sintéticos y no
cambian licencias reales para producirlos.

No se realizó una compra ni aceptación legal real durante la implementación.

## Cancelar la renovación desde MedSync

En `/admin?section=plan-billing`, un administrador del consultorio puede pulsar
«Cancelar renovación». Se consulta de nuevo la suscripción y licencia antes de
abrir el diálogo de Vuetify. El diálogo identifica el consultorio, muestra la
fecha y hora de fin de acceso (Ciudad de México) y explica el flujo: confirmar,
seguir usando el periodo pagado y terminar el acceso al vencer ese periodo.
Cerrar el diálogo o conservar el plan no envía una cancelación.

`POST /api/payments/subscription/cancel` requiere la sesión nativa vigente,
rol `admin`, Origin permitido y CSRF de sesión. Acepta exclusivamente
`idempotencyKey`, `expectedSubscriptionId` y `expectedPeriodEnd`; el actor y el
consultorio se obtienen de la sesión y la membresía vigente en MySQL.
Antes de mutar, sincroniza el snapshot central, comprueba suscripción, fecha y
licencia pagada vigente. Un periodo o suscripción distintos requieren consultar
y confirmar de nuevo. Las pruebas gratuitas y las licencias sin periodo pagado
confirmado no muestran la acción de cancelación.

Se usa `@hemia/payments` `subscriptions.cancel`, cuya cancelación detiene
las renovaciones y conserva el contrato pagado hasta su vencimiento. No se pide
una baja inmediata ni se solicita un reembolso. Un intento central existente se
consulta sin generar otra mutación. El servidor vuelve a sincronizar y persistir
la licencia después de cancelar; un fallo de persistencia no se presenta como
éxito. Los GET nunca envían una cancelación.

Billing puede devolver `subscription.status=cancelled` con
`cancelAtPeriodEnd=true` y licencia activa: MedSync mantiene su estado comercial
operativo mientras la licencia autorice el acceso. El límite efectivo es el
menor entre el periodo pagado, la licencia central y la vigencia de la copia
verificada (24 horas). No se reinicia la prueba, no se añaden extensiones locales
y se respetan suspensiones y revocaciones. El vencimiento se comprueba en los
guards existentes; no depende de que el usuario deje abierta esta pantalla.

La interfaz distingue «Pendiente de confirmación» de «Cancelación programada» y
muestra la fecha disponible. Ante resultado incierto exige «Consultar estado»
antes de permitir otro envío explícito; no reintenta automáticamente un POST.
El UUID del intento se conserva en memoria y, si está disponible, sessionStorage
por usuario, sesión, consultorio y suscripción para recuperar el mismo intento
al recargar. El servidor central conserva la deduplicación y rechaza otro
intento incompatible. Durante el envío se bloquean dobles clics, el cierre del
diálogo y la navegación entre secciones. Cambiar realmente de autorización
invalida los resultados pendientes; abrir el menú de usuario o rehidratar la
misma sesión no consulta ni cancela nada.

Validación: `npm run qa:payments`; en el frontend,
`node scripts/qa/plan-cancellation-regression.cjs`,
`node scripts/qa/plan-billing-regression.cjs`,
`node scripts/qa/payments-checkout-regression.cjs` y
`node scripts/qa/settings-session-stability-regression.cjs`.
La validación usa servicios simulados, sin cancelar una suscripción real.
Para la aceptación de integración en Sandbox: contratar y pagar con una cuenta
de prueba, cancelar desde MedSync, verificar el estado central y el webhook,
comprobar acceso y funciones antes del vencimiento y denegación después,
incluyendo una respuesta del proveedor que deje el intento pendiente.

## Devolución total: actualización de Plan y facturación por webhook

`license.billing.refundConfirmation` acredita una devolución total del pago del
periodo vigente, con licencia revocada e inactiva y suscripción cancelada sin
renovación. Billing verifica pago, organización, producto, periodo, importe
completo (también devoluciones parciales acumuladas) y cada webhook de proveedor
verificado/procesado. La prueba contiene `status: completed`,
`type: full_current_period`, `organizationId`, `productCode`, `subscriptionId`,
`paymentId`, `refundId` (referencia del proveedor), `amount`, `currency` y
`refundedAt`. Una cancelación programada, suspensión, devolución parcial o de
otro periodo no representa esta confirmación. El webhook posterior de cancelación
puede cambiar `validUntil` y conserva la prueba si pago y periodo siguen siendo
los mismos.

`GET /api/payments/subscription/events` abre un único canal SSE autenticado para
administradores, con Origin/Referer permitido y aislamiento por consultorio.
Envía primero el snapshot local guardado y luego eventos `snapshot` con revisión
exacta. Sólo la recepción del webhook verificado dispara nuevos envíos: primero
se confirma la proyección local; si una reconciliación se adelantó, se envía el
snapshot local vigente en lugar de la entrega antigua. Un fallo de persistencia
no publica datos. El envío no hace consultas a Billing. La autorización de sesión
y membresía se comprueba antes de cada envío.

La pantalla aplica el payload directamente: muestra «Sin plan» y «Devolución
total confirmada», oculta precios/renovaciones/comprobantes que ya no describen
un acceso activo y restringe las funciones del consultorio. No recarga ni hace
GETs periódicos o GETs de conciliación por evento. Las lecturas iniciales y las
consultas manuales existentes siguen disponibles. Los administradores conservan
acceso a Plan y facturación con el consultorio restringido.

D2 utiliza EventSource con cookies; legacy usa un fetch de streaming con el
Authorization existente. Ambos cierran al cambiar identidad/permisos, desmontar
la vista o vencer la credencial. La renovación de la credencial reabre sólo el
canal; no vuelve a consultar catálogo/suscripción/licencia. EventSource puede
reconectar tras una interrupción de transporte; no hay fallback de polling.
Hay comentarios keepalive cada 15 segundos sin consultas de estado ni datos.

Límite actual: el hub es local al proceso (máximo cuatro conexiones por
consultorio y doscientas globales). Para varias instancias se requiere pub/sub
compartido o afinidad que garantice que webhook y canal lleguen al mismo proceso.
Las pruebas usan devoluciones sintéticas; no ejecutan devoluciones financieras.

### Recuperación local de condiciones y selección por URL (2026-11-13)

Si catálogo y suscripción responden pero `/api/payments/legal/prepare` devuelve
`BILLING_UNAVAILABLE`, comprobar también la API Legal configurada, no sólo
Billing. En desarrollo local Legal escucha en `3017`; si está detenida, iniciar
su API con los comandos del repositorio Legal y sus credenciales existentes.
No se debe aceptar documentación ni crear un checkout para probar esta lectura.

La carga del catálogo y la preparación de condiciones son independientes para
conservar el plan/precio válido indicado en la URL. Un fallo de condiciones
mantiene visible el plan seleccionado y su importe del servicio, permite volver
a cargar condiciones y bloquea el pago mientras no estén disponibles. Un código
de plan/precio ajeno al catálogo continúa rechazándose.

La preparación real volvió a responder 200 tras arrancar Legal. Su
`/health/ready` todavía detecta una dependencia Redis no disponible; el destino
Redis de Vault no respondió y el servidor alternativo de desarrollo rechazó la
autenticación. No se sustituyeron secretos, no se desactivaron controles ni se
aceptaron contratos/pagos para esta verificación. Debe corregirse esa dependencia
antes de considerar toda la instancia Legal saludable.

## Ventana de PayPal y confirmación por webhook

El recibo del intento incorpora opcionalmente `paypalApproval` con
`kind: subscription`, el identificador real PayPal, su `clientId` público y
`environment`. Billing obtiene esos datos de la suscripción y la conexión
fijadas al intento, nunca del navegador. El `subscriptionId` principal del
recibo sigue siendo el UUID interno: no se utiliza como identificador PayPal.
El SDK Node valida y conserva esta proyección; no expone secretos de conexión.

El frontend usa el SDK web PayPal v6 para aprobar la suscripción que Billing ya
creó. Cancelar, cerrar, fallar o reabrir la ventana conserva `attempt_id`,
suscripción y enlace; no envía otra creación. Si falta el SDK, la sesión no es
elegible o el navegador impide abrirla, se ofrece continuar mediante el mismo
`checkoutUrl`. Los intentos antiguos y operaciones no compatibles conservan la
redirección. No se fuerza una ventana de suscripciones sobre órdenes o revisiones.

`onApprove` sólo muestra la espera de confirmación. No verifica, captura ni
concede acceso y no inicia consultas de estado. La pantalla permanece suscrita
a `/api/payments/subscription/events`, aplica snapshots comprometidos con
revisión creciente y exige la prueba `checkoutConfirmation` del comprador y
contrato exactos. Después de esa prueba se rehidrata la sesión local. El endpoint
`GET /api/payments/subscription/snapshot` permite carga inicial o recuperación
manual desde la copia local validada, sin consultar Billing ni PayPal.
La preparación que responde `202 processing` encola un nuevo webhook en la
misma transacción que guarda el recibo `ready`; un rollback revierte ambos.
Mientras el intento siga pendiente, cada revisión nueva del webhook puede
recuperar una vez los identificadores de ese mismo intento, con una sola
lectura simultánea. No verifica pagos, no crea otra contratación y no programa
consultas sucesivas. La señal de preparación no concede acceso: la activación
sigue exigiendo la prueba de pago del contrato y comprador exactos.
Una suscripción pendiente puede existir sin licencia: ese snapshot prepara la
ventana pero no habilita funciones. Si una revisión posterior cancela, vence o
suspende ese mismo contrato, se retiran las acciones de pago y se ignoran los
callbacks anteriores; un recibo antiguo no puede reabrir esas acciones ni
sustituir esa revisión.

### Legal local recuperado (2026-11-13)

El fallo Redis descrito en la recuperación anterior quedó resuelto. Legal usa
una instancia dedicada y autenticada en loopback, con la contraseña y base
existentes de Vault; no se modificó el secreto central ni el Redis compartido.
`REDIS_LOCAL_TRANSPORT` sólo permite development/test y loopback, manteniendo
la configuración original de Vault cuando está desactivado. En el repositorio
Legal, `bun run dev:redis` inicia o valida esa instancia antes de `bun run dev:api`.

Tras recompilar y reiniciar la API, live, ready y event-bus devolvieron 200.
`npm run qa:payments-local` pasó contra los servicios reales con catálogo,
compatibilidad y callback legal, y reportó cero compras y cero aceptaciones.
La comprobación de la ventana con aprobación del comprador y webhook de pago
en Sandbox queda para la prueba manual; no se inició ningún cobro.

Se retiraron el polling de preparación del frontend, la conciliación periódica
de licencias del backend y las conciliaciones implícitas en la autenticación.
El reloj de interfaz, los keepalive SSE y la renovación del canal no consultan
pagos. Siguen disponibles las consultas manuales explícitas de administración.
La caducidad y revocación de la licencia local siguen restringiendo el acceso;
si el webhook no llega, la ventana no puede suplir su confirmación.

El SDK ampliado se instala desde el tarball versionado bajo `vendor/`, sin
publicar un paquete npm ni depender de una ruta temporal del equipo. No hay
nuevas credenciales ni migraciones. La prueba integral con comprador Sandbox
y webhook real sigue siendo una comprobación manual financiera separada.

## Checkout con un solo clic y recuperación de confirmación (2026-11-18)

Esta sección sustituye las indicaciones anteriores de segundo gesto,
redirección de contratación inicial y espera exclusivamente por webhook.
Registro y contratación dentro de la app usan `AccountPlans`: el botón oficial
«Continuar con PayPal» reserva una ventana antes de cualquier `await`, mediante
el mismo helper que usa el cambio de plan. El recibo `ready` navega esa ventana
con el enlace del intento, incluso sin metadatos del SDK. Una preparación
asíncrona conserva la ventana hasta que un snapshot recupera el mismo recibo.
Los intentos existentes con metadatos conservan la sesión popup del SDK v6.
Cerrar/cancelar conserva el intento; bloquear ventanas no acepta condiciones
ni crea una contratación. Recargar nunca abre una ventana automáticamente.

El retorno de la ventana se valida por origen, ventana e intento. Al aprobar,
al abrir un intento y al actualizar manualmente, se concilia mediante
`GET /api/payments/license` y se lee el snapshot local comprometido. Tras una
aprobación hay hasta seis recuperaciones adicionales espaciadas, sin concurrencia;
terminan al confirmar acceso, cerrar el contrato, expirar sesión o salir de la
vista. Son lecturas de Billing: no llaman a `verify`, no capturan y no recrean
pagos. Una aprobación/query nunca sustituye `checkoutConfirmation` del comprador,
contrato, plan y precio exactos, ni la rehidratación de la sesión pagada.

La conciliación publica sólo después del commit y utiliza la revisión local
más reciente si ganó una entrega concurrente. Cada heartbeat SSE de suscripción
recupera el snapshot local cada 15 segundos, con autorización vigente, para
cubrir un webhook recibido por otro worker. Esa recuperación no consulta Billing
ni PayPal. El historial de pagos por sí solo no concede acceso.

Validación: 86 pruebas del backend, regresiones Vue de checkout, SDK, ventana,
cambio de plan, facturación, historial y webhooks, lint del componente y build
production con configuración sintética. Las pruebas no producen compras reales.
La validación de QA con PayPal Sandbox y el despliegue en test.medsync siguen
siendo verificaciones del ambiente; estos cambios no los ejecutan.

## Recuperación del correo de activación (2026-11-18)

Los rechazos explícitos de SES (HTTP 4xx, excepto timeout 408) y los errores
locales de configuración previos a SendEmail ya no se confunden con una
aceptación incierta. El proveedor devuelve `retryable: true` sólo en esos
casos. El worker marca `EMAIL_DELIVERY_RETRYABLE` y permite reclamar el
evento después de un minuto, sin bloquear los otros correos pendientes.
Al reclamar de nuevo vuelve a validar comprador, correo, plan y contrato.
La entrega exitosa consume el evento; errores de red, timeout, HTTP 5xx,
respuesta sin MessageId o excepción desconocida conservan la protección
contra reenvíos de resultado incierto. No cambian el esquema ni los pagos.

Los eventos antiguos `EMAIL_DELIVERY_UNCONFIRMED` no se reabren: sus datos
no distinguen un rechazo de un correo que pudo aceptarse. Se requiere
comprobar el resultado en SES antes de decidir un reenvío.

Validación: 88 pruebas de pagos y 19 comprobaciones del proveedor SES,
incluyendo rechazo, espera, recuperación, concurrencia y ausencia de
reenvío tras resultados inciertos. No se enviaron correos reales.
El diagnóstico de test.medsync no se completó: SSH agotó el tiempo de
espera y la cuenta MySQL configurada respondió `ER_DBACCESS_DENIED_ERROR`
al consultar el esquema QA en una transacción de sólo lectura. La
configuración local usa correo deshabilitado y no acredita el estado de QA.
