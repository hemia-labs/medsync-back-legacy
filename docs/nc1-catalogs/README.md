# NC1 catalogs / NC4 versioned sources

This batch connects identity to the existing NC4 tables. It does not add DDL, import on startup, contact a source during a clinical request, or transmit to DGIS. All downloads and database tests for this delivery were local. Test and production catalogs were not changed.

## Reviewed sources

`sources-reviewed-20261117.json` contains URLs, raw-file SHA-256, source labels, download timestamps, CSV members, mappings, entry counts and staged content hashes. It contains no catalog entries or patient data. Keep original downloads and staged bundles outside the repository in controlled storage; never bundle them into the application image.

- SIS: country (225), birth federal entity (35, including excluded sentinels), affiliations (13), personnel types (30), operating SIS establishments (15,358). Numeric Excel codes remain literal strings; no invented zero padding. Personnel codes 31–34 were absent in the published source and are not invented.
- INEGI: states (32), municipalities (2,478), localities without bajas (296,643). Preserve 2/5/9 characters. Every municipality and locality in the reviewed files has its parent. Birth entity remains SIS, residence remains INEGI.
- SEPOMEX: 31,862 distinct postal codes were parsed and exercised privately. The downloaded file contains restrictions on commercial use/redistribution: **do not install this dataset in a shared environment or distribute it until reuse conditions are resolved**. The generic reader and manual/unverified fallback are ready.
- RENAPO nationality: no verifiable official download located. Do not replace it with ISO or the country catalog. It remains unavailable/unverified.

INEGI uses the downloaded member name as `sourceVersion` and `download_date` as the effective boundary (America/Mexico_City). This is not an invented publication/effectivity date. Review any new download again: these URLs are mutable.

## API and stored references

`GET /api/identity/catalogs/:family` uses the existing authentication and tenant-operational middleware and requires a business context. It exposes public reference data only; existing patient/professional/establishment write permissions are unchanged. No-store responses, literal substring search, at most 30 results, bounded offset. Parameters: `q`, optional 2-digit municipality parent or 5-digit locality parent, `offset`. Exact reference check: `code` and `releaseId`.

A selected reference is `{family, releaseId, code}`. Manual capture omits `releaseId` and stays unverified. An official verified release is usable only in its effective window. A missing source never certifies a reference. A known release with a missing code, mismatched family, sentinel or nonoperating CLUES rejects the write with 400 and field information, within the existing identity/profile transaction. The source/date change does not rewrite an old reference or a closed history. Read quality reports expose `catalogChecks`; editable payloads strip that metadata.

CAT-O2: a residence edit is checked against the merged residence. An officially resolved country other than Mexico (142 in the reviewed SIS country source) cannot coexist with INEGI state/municipality/locality. Missing/manual countries remain unverified and an absent country is never filled in. Unrelated historical edits remain possible; contradictory historical combinations receive a quality issue and never an aggregate verified state. The frontend identifies the country field and preserves the draft. CAT-O1 official CLUES attributes stays assigned to the separate NC1-CLUES-UX redesign, not completed by this API.

## Controlled staging and installation

1. Review the exact downloaded file and hash against the source inventory. Keep a private backup of existing releases/entries and the target database's NC4 schema before a shared installation. This PR creates no schema; if the NC4 tables/triggers are absent, stop and handle that dependency separately.
2. XLSX: use `node scripts/nc4/stage-catalog.js --file <file> --family <family> --release-id <immutable-id> --source-url <url> --source-version <label> --valid-from <reviewed-date> --validity-basis download_date --out <private-directory>`. Preserve the download timestamp on the input file; if reproduced on another date, use a new release ID and reviewed validity boundary.
3. INEGI ZIP: use `node scripts/nc4/stage-geographic.js --file <zip> --member <exact-member> --family <family> --release-id <immutable-id> --source-url <url> --source-version <member-label> --downloaded-at <ISO-time> --out <private-directory>`. Do not extract/ship the unrelated KML/DBF files. The reader validates only the contractual CSV prefix because the official coordinate suffix contains unescaped quotation marks.
4. Audit without opening a database: `node scripts/nc4/install-catalog.js --dir <private-directory> --release <id> --source-sha256 <reviewed-raw-sha>`. Only the reviewed numeric-cell warning may be acknowledged with `--ack-numeric-codes`; every other staging issue blocks import.
5. After review and a scheduled test window: the same command plus `--apply --verify --database <exact-configured-test-database>`. It uses the existing env loader (never print secrets), one connection, a per-family lock and a transaction. Repeat with identical immutable metadata/content is a no-op; changed metadata/content under an existing ID is rejected. No implicit overwrite, delete or partial bulk install.
6. Order: backend -> approved source imports -> frontend -> authenticated test on a new synthetic patient, own/admin professional identity and establishment. Coordinate with the separate B session before using shared test. Do not install SEPOMEX yet. No production promotion is part of this batch.

## Actualización semanal de CLUES

El sincronizador consulta la fuente oficial DGIS para `sis.establishments` cada **sábado a las 23:00, hora de Ciudad de México**. Una consulta sin novedades conserva la versión vigente. Una actualización válida publica la nueva versión con su procedencia. Las referencias ya capturadas conservan su versión. Si falla el contenido o el número de unidades cae más de un 10 % respecto de la edición anterior, el archivo pasa a revisión. Si aún no hay ediciones instaladas, se usa como referencia la primera carga revisada de 15,358 establecimientos. Es un umbral operativo que permite comprobar con DGIS una baja excepcional.

### Habilitar en un ambiente

Tras desplegar el backend que contiene `src/jobs/syncClues.js`, ejecuta estos comandos **en el host Linux del ambiente autorizado**, desde una copia de los archivos `ops/nc4` de esa revisión. La instancia `qa` usa el proyecto Docker Compose `medsync-qa` y el servicio `api`. Para producción, la instancia `prod` selecciona `medsync-prod` en su propio host. El proceso se ejecuta con el usuario y las variables de la API del ambiente.

```sh
sudo install -D -m 0755 ops/nc4/sync-clues.sh /usr/local/lib/medsync/sync-clues.sh
sudo install -m 0644 ops/nc4/medsync-clues@.service ops/nc4/medsync-clues@.timer /etc/systemd/system/
sudo systemctl daemon-reload
systemd-analyze calendar 'Sat *-*-* 23:00:00 America/Mexico_City'
sudo systemctl enable --now medsync-clues@qa.timer
systemctl list-timers medsync-clues@qa.timer --all
```

El temporizador persistente recupera una ejecución programada perdida mientras el host estuvo apagado. Una comprobación manual autorizada sigue la misma ruta y puede instalar una publicación válida (`sudo systemctl start medsync-clues@qa.service`). El código temporal 75 reintenta una sola vez, cinco minutos después. Un error de contenido o configuración termina la ejecución y deja disponible el último catálogo válido.

### Consultar resultados

```sh
journalctl -u medsync-clues@qa.service -n 30 --no-pager
systemctl show medsync-clues@qa.service -p Result -p ExecMainStatus
```

El registro del servicio muestra la comprobación y su resultado, incluida una descarga sin cambios o una incidencia. Para ver la última versión instalada, consulta la base del mismo ambiente:

```sql
SELECT release_id, source_url, source_version, downloaded_at, sha256, entry_count, verified_at
FROM sis_catalog_release
WHERE family = 'sis.establishments' AND status = 'verified'
ORDER BY valid_from DESC, release_id DESC
LIMIT 1;
```

Para suspender futuras ejecuciones, usa `sudo systemctl disable --now medsync-clues@qa.timer`. El catálogo publicado y sus referencias permanecen disponibles.

## Recovery

Keep references and releases; never delete or rewrite a verified release. For a reviewed bad-source incident, use the existing NC4 `verified -> retired` transition with operator/change identity and timestamp, after checking the exact release ID and impact. Retirement is one way and preserves the historical version; a replacement uses a new ID. No automatic reactivation of an older release. NC4 rejects two verified releases of a family with the same validFrom, including a retired one: a replacement needs a later reviewed boundary (for example a new download date), and retiring the newest release without a replacement leaves the family unavailable (unverified) instead of reviving the previous one. Frontend can revert to its prior version (reference DTO unchanged), and backend can revert without dropping catalog data. Source absence remains unverified rather than preventing capture.

## Verification

- `node --test scripts/qa/nc1-catalogs.test.js`: 11 groups including HTTP envelope, tenant denial before lookup, safe search, stale/missing/synthetic sources, sentinels, transaction and hierarchy.
- `npm run qa:isolated`: 52 suites. The 401 inventory changes only exact fingerprints of the edited serializing contexts; no file-wide exception.
- `NC1_ISOLATED_QA=1 NC1_ISOLATED_PORT=<disposable-port> node --test scripts/qa/nc1-identity-integrated-mysql.test.js`: actual patient, professional and establishment saves; revision, tenant, 400/403/409 rollback. Never point it at a shared database.
- `NC1_CATALOG_QA_ISOLATED=1 NC1_CATALOG_QA_PORT=<disposable-port> node scripts/qa/nc1-catalogs-mysql.js [--staged-dir <private-reviewed-bundles>]`: creates NC4 fixtures only in the prescribed disposable local database. Source hash/idempotence/immutability/overlap rollback and optional nine-source audit. The source fixture uses the official branch strictly to exercise it in an isolated synthetic test; it is not a deployable catalog.

Base `b14709f`: the extended real-MySQL test fails because the selected official reference remains unverified; after adapting only that expectation, it also fails because an invalid code is accepted. The base harness received the new importer solely to seed its fixture; its identity product code remained unchanged. This establishes a product contrast, not a missing-module failure.
