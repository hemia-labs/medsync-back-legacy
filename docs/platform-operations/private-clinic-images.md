# Logos y firmas privados de MedSync

Preparación local; sin despliegue al VPS ni SES. No requiere migración SQL.

## Contrato y almacenamiento

- `S3_PRIVATE_BUCKET=medsync-prod`, `AWS_REGION=us-east-2` y las credenciales
  existentes del backend. Nunca versionar archivos de entorno con credenciales.
- Logos nuevos: `consultorios/{id_business}/logos/{uuid}-{sha256}.png` (también
  JPEG y WebP). Firma profesional: `consultorios/{id_business}/profesionales/{id_login}/firmas/{uuid}-{sha256}.png`.
- `business.logo_url` y `doctor_professional_profile.signature_image` guardan
  la clave estable. Cada reemplazo utiliza un nombre nuevo.
- `GET /api/business/current` expone `logoKey` y `logoUrl` temporal. Las
  respuestas de perfil profesional conservan `signature_image` como clave y
  agregan `signature_url` y `signature_digest` para presentación y recuperación
  de un guardado cuya respuesta se perdió. No guardar esos enlaces en DB.
- URLs de lectura firmadas por 300 segundos, sin caché persistente. La UI
  renueva las previsualizaciones cada cuatro minutos y permite actualizarlas.
- `PUT /api/business/current/logo { image: dataURL }` y `DELETE` de esa misma
  ruta requieren sesión, CSRF, tenant operativo y administración del consultorio.
  El tenant y actor vienen de la sesión. PNG/JPEG/WebP hasta 5 MB para logo;
  firma profesional PNG validado bajo el límite existente de firmas (2 MB).
- El guardado de perfil mantiene las autorizaciones y bloqueo del consultorio.
  Solo acepta firma capturada, vacía o exactamente la referencia ya almacenada;
  nunca una clave arbitraria de otro perfil.

## Conservación y errores

La emisión de recetas y documentos incorpora los bytes de la firma a la
instantánea clínica existente. Cambiar o eliminar la firma del perfil no cambia
los documentos emitidos. Los logos para impresión y enlaces públicos de firma
se resuelven como imagen embebida tras validar el contexto correspondiente.
El correo omite logos privados: las imágenes públicas de correo pertenecen al CDN.

Se elimina el objeto anterior solo después del commit de la nueva referencia.
Si la escritura falla antes del commit se limpia la carga nueva; si el resultado
del commit es desconocido se registra la recuperación para verificar DB antes de
borrar. Un fallo al eliminar queda en el diario privado existente. El versionado
S3 conserva versiones anteriores y la regla de infraestructura las expira después
de 30 días sin ser actuales; no elimina archivos actuales.

Las firmas históricas en base64 y logos externos existentes siguen siendo
compatibles. No se migran masivamente, ni se cambian en esta entrega las cargas
legacy de fotos/radiografías, firmas de pacientes o imágenes de plantillas.

## Validación local

`node scripts/qa/private-images-regression.js`: SQL y AWS simulados, aislamiento
por tenant, firmas de URLs, bytes de instantáneas, reemplazo/eliminación, rollback,
commit desconocido, rechazo de referencias falsas y permisos de administrador.
El frontend tiene una prueba aislada de los componentes reales, con servicios
simulados, en escritorio y móvil. Antes del despliegue debe verificarse el flujo
con el backend y base de pruebas configurados; no probar con datos clínicos reales.

Revertir a código antiguo después de guardar claves privadas requiere un plan de
compatibilidad: el código anterior trataría las claves como URLs o base64.
