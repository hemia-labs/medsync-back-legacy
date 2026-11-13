---
"medsync-back": minor
---

Add NC4/L2 SIS catalog and descriptor modules for the NOM-024 preparation: a dependency-free XLSX reader, immutable and encapsulated catalog releases with manifest, content hash and verification evidence, an in-memory registry with resolve/validateRef, deterministic release windows and CLUES resolution, staging artifacts with relations and round-trip checks, per-guide descriptors for GIIS-B015-05-04 (113 fields) and GIIS-B016-05-04 (81 fields), and per-position diagnosis rules with strict civil dates. The catalog DDL (immutability triggers and a resumable installer) is tested only against a disposable MySQL. No routes, application DB connections or existing behavior change.
