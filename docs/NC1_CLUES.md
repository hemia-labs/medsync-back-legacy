# Establishment creation and CLUES catalog contract

Uses the existing NC1/NC4 tables. No new DDL, importer change or automatic catalog refresh.

## Creation and replay

`POST /api/identity/establishments` accepts an optional `Idempotency-Key` header. New clients must send one key per intended creation and retain the exact original body until the result is confirmed. Older clients without the header remain supported but do not have the replay guarantee.

Keys have 8–128 ASCII characters, start with a letter/digit, and contain only letters, digits, `.`, `_`, `:`, `-`. Invalid keys return 400 `IDEMPOTENCY_KEY_INVALID`. Scope is the authenticated business, not the CLUES, display name or actor. The body remains `{identity,expectedRevision:0}`; tenant/actor are taken from the session.

An existing transaction locks the business row. An opaque unit id is derived from a fixed namespace, business and key; the existing `request_hash` column stores the SHA-256 fingerprint of the original body, with object keys sorted recursively. Field omission differs from null; array order is significant. No normalization is applied to this fingerprint.

- Same key and body: 200, same `data.id`, current saved fields/revision, `data.replayed:true`; no write.
- Same key and different body: 409 `IDEMPOTENCY_KEY_REUSED`; no overwrite.
- A retry waits for an in-flight transaction. Rollback does not consume a key.
- All PATCH paths preserve the original fingerprint. Replay after editing or revalidation returns the current unit, never restores the original fields, and resolves the operation before checking the original catalog version.
- Session, operational-tenant, permission and CSRF checks still run on every request, including replay. Responses do not expose the key/fingerprint and use `Cache-Control: no-store`.

Client edits made after an uncertain creation are a separate draft. After resolving the original operation, save that draft only through explicit PATCH using the returned current revision. Reload/another-tab recovery is not provided by this contract; losing the key and issuing another creates another intent.

## Official data and exact lookup

Unit reads include read-only `catalogAttributes`: `clues`, `nombre_unidad`, `en_operacion`, `id_entidad_federativa`, `tipo_unidad`, `tip_abreviacion`, `sub_abreviacion`, `institucion`. These describe the exact stored release, even when superseded. Missing/manual/unresolvable references yield null. The catalog contains no address; none is inferred. `catalogChecks` for `cluesRef` includes `source.releaseId`, `sourceVersion`, `sourceUrl`, `sha256`, `validFrom`, `validityBasis`. Sending official attributes back in `identity` is rejected.

`GET /api/identity/catalogs/sis.establishments?exactCode=QATEST00001` looks up a CLUES in the effective current release. Do not combine `exactCode` with other query fields. It returns:

```json
{
  "status": 200,
  "data": {
    "available": true,
    "source": { "releaseId": "example", "sourceVersion": "example" },
    "item": {
      "ref": { "family": "sis.establishments", "releaseId": "example", "code": "QATEST00001" },
      "label": "Synthetic example",
      "attributes": { "clues": "QATEST00001", "nombre_unidad": "Synthetic example" },
      "check": { "result": "valid", "code": null }
    }
  }
}
```

The example abbreviates source/attributes. `available:false` or HTTP 503 means the source could not be checked, while `available:true,item:null` means exact absence in that release. A nonoperating entry is returned with `check.result:invalid`, `code:CLUES_NOT_OPERATING`; it must not be described as missing or as proof of an official closure. Existing text-search and `code+releaseId` resolution modes are unchanged.

## Explicit revalidation

Read the unit again before comparing to the exact current entry. After confirmation, PATCH only `{identity:{cluesRef},expectedRevision}`. A new/different versioned CLUES assignment must be current when written. Superseded release: 409 `CATALOG_RELEASE_CHANGED`; unavailable source: 503 `CATALOG_UNAVAILABLE`; invalid entry: existing field-level 400. Retaining a historical reference during unrelated editing remains supported.

The transaction holds a shared release-range lock through commit. A 409 requires another read/comparison and another confirmation; an uncertain network/5xx result requires reading what was saved before any further write. Checking alone never rewrites saved references.

## Verification

Run `node scripts/qa/nc1-clues-isolated.cjs mysql:8.0` or `mysql:8.4`. Docker port 33381 must be free. The runner creates and removes its own disposable container, never reads project environment files and uses synthetic data. It also runs the existing identity/catalog/DAO regressions. HTTP security boundaries are simulated; authenticated acceptance against shared test is separate.
