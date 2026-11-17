# Payments SDK local

`hemia-payments-0.14.0.tgz` contiene el SDK de Billing con la aprobación de
PayPal y el historial de pagos, construido y validado desde el checkout local de Billing.
Es un artefacto portable referenciado mediante `file:vendor/...` y su integridad
está fijada en `package-lock.json`; no depende de `/tmp` ni de un paquete publicado.

La versión fuente de Billing se libera mediante su changeset minor. Cuando esa
versión se publique, se puede reemplazar el tarball por la dependencia oficial
después de validar el mismo contrato. No contiene credenciales.
