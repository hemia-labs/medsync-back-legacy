---
"medsync-back": patch
---

Make keyed establishment creation idempotent within the account, preserving the original request fingerprint after edits. Expose read-only SIS CLUES attributes and exact current-version lookup, and reject a new versioned assignment when its catalog release is no longer current. Uses existing tables; no database migration or catalog import.
