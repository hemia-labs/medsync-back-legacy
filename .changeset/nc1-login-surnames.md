---
"medsync-back": minor
---

Users and registration accept separate surnames (`first_surname`, `second_surname`) next to `first_name`; `last_name` and `name` are derived and at least one surname is required. Adds the additive, reversible `nc1-login-surnames` migration (two nullable `login` columns, backup on apply and revert). Before the migration the application keeps working with `last_name` only; existing accounts are never split.
