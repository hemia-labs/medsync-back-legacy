# medsync-back

## 0.1.0

### Minor Changes

- b32cae9: Move MedSync terms and privacy acceptance to Hemia Legal for existing and newly registered accounts. Serve the effective central versions on the public legal routes and provide a lightweight notice endpoint. Retire local terms and privacy writes while preserving historical evidence and the local clinic license workflow.
- 8fb2e77: Discover account legal document sets and verify representative sessions for organization evidence.
- 4130371: Simplify identity names to three plain values (given names, first and second surname); surname statuses are now derived instead of captured, so an empty surname is no longer a declaration. Save the professional profile and its identity atomically in one request (`identity` + `identity_expected_revision`), including profile creation, and return the identity with the profile. The professional display name is derived from the three names.
- a7d60b8: Add tenant-scoped patient, professional and establishment identity v1.1 with explicit additive installation, revision checks and transactional legacy compatibility. Install NC1 tables before deploying this API; catalog foreign keys remain a separate migration.
- 2a46e13: Users and registration accept separate surnames (`first_surname`, `second_surname`) next to `first_name`; `last_name` and `name` are derived and at least one surname is required. Adds the additive, reversible `nc1-login-surnames` migration (two nullable `login` columns, backup on apply and revert). Before the migration the application keeps working with `last_name` only; existing accounts are never split.
- ff6cd30: Add NC4/L2 SIS catalog and descriptor modules for the NOM-024 preparation: a dependency-free XLSX reader, immutable and encapsulated catalog releases with manifest, content hash and verification evidence, an in-memory registry with resolve/validateRef, deterministic release windows and CLUES resolution, staging artifacts with relations and round-trip checks, per-guide descriptors for GIIS-B015-05-04 (113 fields) and GIIS-B016-05-04 (81 fields), and per-position diagnosis rules with strict civil dates. The catalog DDL (immutability triggers and a resumable installer) is tested only against a disposable MySQL. No routes, application DB connections or existing behavior change.

### Patch Changes

- b961d30: Use Hemia Legal as the sole source for current account documents and pending notices, while preserving local license receipts.
- 4b99c16: Review and record only pending central legal documents for authenticated accounts while preserving the full confirmation flow for registration.
- 543a24b: Fix Hemia SSO session creation to revoke refresh tokens using the existing last/revoked_at schema. Add isolated MySQL coverage for revocation, user isolation and transaction rollback.
- bca2073: Read account document versions through the authenticated Hemia Legal integration.
- 3ab3089: NC1-AUTH-S1-S3: authentication 401s on protected/business routes carry an `AUTH_*` code in `data.code` (`awaitHandlerFactory`, permission/role/body middleware defenses, the whole Pulso chain with the root `code` kept for compatibility); a valid session without business answers `403 BUSINESS_CONTEXT_REQUIRED` (Continuidad, Pulso, dashboard) and a denied `admin.config` on the current business answers `403 PERMISSION_DENIED`. Adds an isolated inventory regression of 401 emitters with an explicit allowlist for `auth/*` controls.
- 46ab708: Guarda y devuelve el contacto de emergencia principal del paciente (patient_emergency_contacts) dentro del guardado administrativo, con baja lógica y aislamiento por consultorio.
- 53b65a2: Answer permission denials in documents and prescriptions with 403 instead of 401 when the session is valid, with stable codes (`PERMISSION_DENIED`, `BUSINESS_CONTEXT_REQUIRED`, `BUSINESS_NOT_ACTIVE`). A 401 now only comes from authentication, so the client no longer ends a valid session or discards a capture when a user lacks a permission.
- 4bcc0e5: Answer professional profile view and edit permission denials with 403 `PERMISSION_DENIED` instead of 401 when the session is valid, so the client keeps the session. Self and administrator access, business isolation and authentication 401s are unchanged.
- e441cb1: Allow an environment-specific central registration document set while preserving the MedSync API key and existing default. This lets production and test use separate Legal integrations without replacing published documents or test sets.
- 68199fd: Allow reading the documents and prescriptions of an archived patient, and answer 409 or 404 instead of 401 when a document or prescription cannot be created for a patient.

## 0.0.3

### Patch Changes

- 643fd59: Permite que Amazon SES envíe los avisos de rebotes y quejas a un buzón de soporte configurado, separado de la dirección de respuesta.

## 0.0.2

### Patch Changes

- 9c07ea9: Agrega el versionado del backend con Changesets y las notas de cada release en GitHub.
