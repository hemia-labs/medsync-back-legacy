---
"medsync-back": patch
---

NC1-AUTH-S1-S3: authentication 401s on protected/business routes carry an `AUTH_*` code in `data.code` (`awaitHandlerFactory`, permission/role/body middleware defenses, the whole Pulso chain with the root `code` kept for compatibility); a valid session without business answers `403 BUSINESS_CONTEXT_REQUIRED` (Continuidad, Pulso, dashboard) and a denied `admin.config` on the current business answers `403 PERMISSION_DENIED`. Adds an isolated inventory regression of 401 emitters with an explicit allowlist for `auth/*` controls.
