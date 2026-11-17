---
"medsync-back": patch
---

Answer professional profile view and edit permission denials with 403 `PERMISSION_DENIED` instead of 401 when the session is valid, so the client keeps the session. Self and administrator access, business isolation and authentication 401s are unchanged.
