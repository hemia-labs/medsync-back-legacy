---
"medsync-back": patch
---

Answer permission denials in documents and prescriptions with 403 instead of 401 when the session is valid, with stable codes (`PERMISSION_DENIED`, `BUSINESS_CONTEXT_REQUIRED`, `BUSINESS_NOT_ACTIVE`). A 401 now only comes from authentication, so the client no longer ends a valid session or discards a capture when a user lacks a permission.
