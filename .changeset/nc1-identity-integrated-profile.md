---
"medsync-back": minor
---

Simplify identity names to three plain values (given names, first and second surname); surname statuses are now derived instead of captured, so an empty surname is no longer a declaration. Save the professional profile and its identity atomically in one request (`identity` + `identity_expected_revision`), including profile creation, and return the identity with the profile. The professional display name is derived from the three names.
