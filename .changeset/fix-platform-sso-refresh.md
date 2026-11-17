---
"medsync-back": patch
---

Fix Hemia SSO session creation to revoke refresh tokens using the existing last/revoked_at schema. Add isolated MySQL coverage for revocation, user isolation and transaction rollback.
