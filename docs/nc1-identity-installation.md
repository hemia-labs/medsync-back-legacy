# NC1 identity v1.1: installation and isolated verification

This additive change does not install catalog foreign keys or validate catalog candidates. No migration runs at application startup. Install tables **before** releasing the NC1 API; release the frontend after the API.

## Release order

1. Merge/release nc4-catalogs (PR #75), and follow its separately reviewed installation procedure.
2. Review the NC1 SQL plan, target database, parent schema and maintenance window. Back up schema through the normal operator process. Do not export patient data to QA.
3. From the exact reviewed NC1 artifact, run `node scripts/migrations/install-nc1-identity.js plan`. This opens no connection. Record its checksum in the deployment ticket.
4. With the existing application's environment loader configured by the operator, run `node scripts/migrations/install-nc1-identity.js apply TARGET_DATABASE REVIEWED_CHECKSUM OPERATOR_ID`. The target must equal configured `DB_NAME`; the checksum must match this artifact. Never put credentials on the command line or in tickets.
5. Require exit code 0 and the returned run ID. Inspect `nc1_identity_audit` for that run (`complete`, expected actor/database/checksum) and the five entries of `nc1_identity_steps`. A failed/missing run stops the deployment. The installer uses one connection and a database-specific advisory lock.
6. Deploy NC1 API, then Vue 2. Smoke-test with an authorized test account in the test environment. Production execution is a separate operator action, not authorized by this implementation.
7. Only after separate review: nc1-identity-catalog-fk. Do not infer catalog validity from a saved candidate.

## R11: parent and format integrity

`patient_identity` references `(id_business,id_person)` in `person`; `professional_identity` references `(id_business,id_doctor_professional_profile)` in the professional profile. Both are RESTRICT on update/delete. Parent indexes are additive unique composite indexes. Preflight requires InnoDB and matching `VARCHAR(50)`/`utf8mb4_unicode_ci`. Coordinate metadata locks/DDL duration with the operator; no parent data is rewritten. Code CHECKs require nonempty printable ASCII without spaces, and release IDs use the agreed ASCII pattern. The three-state shape CHECK still rejects partial nulls. Catalog FKs remain absent.

## Failure/restart and rollback

The CLI exits 1 with a JSON `nc1.install.failed` event on failure. Internally constructed validation/preflight/drift messages are printed; database errors expose only sanitized `code`/`sqlState` (and known connection error codes), never SQL, driver messages, stack, host, user or credentials. Unknown causes receive a generic message. Retain this stderr event in the operator ticket: failures before connection/preflight audit creation cannot have a database audit row. Do not connect merely to audit a rejected target/checksum. Once a run is created, its existing failed/complete audit remains authoritative.

MySQL DDL is not a multi-statement transaction. Audit and per-table fingerprints allow a controlled restart with the **same artifact**. Existing unknown tables, changed definitions/checksums, or altered parent index definitions abort; never silently adopt/repair them. A crash between CREATE and manifest insertion requires manual inspection and explicit remediation before retrying. Old R3 QA tables are not an upgrade target; recreate only disposable QA containers.

On application rollback, stop NC1 writers and restore the previous application release; preserve the additive tables and audit. Do not automatically drop identity data, history, indexes or FKs. Parent FKs can intentionally prevent deletion/reassignment by old code. Any schema reversal requires an independently reviewed plan after checking dependencies and retained data.

## Reproducible synthetic QA

With Docker and Node dependencies installed: `bash scripts/qa/nc1-identity.docker.sh mysql:8.0`, then the same with `mysql:8.4`. The script owns a disposable container, binds only loopback:33381, and removes it on exit. Fixture credentials are public synthetic values. Never point these tests at another DB. One test exercises the explicit installer API on a disposable database without the `nc1_qa_` prefix, checking audit/restart and rejection gates.

For authenticated component QA, start a disposable MySQL container with that same loopback port/fixture password, set `NC1_ISOLATED_QA=1` and `NC1_FRONT_ROOT` to the paired frontend checkout, then run `node scripts/qa/nc1-browser-server.js`. In the frontend run `node scripts/qa/nc1-authenticated.cjs`. Stop the fixture server and remove the container afterward.

The browser fixture uses actual auth controller/DAO, bcrypt, JWT/session cookies, CSRF, permissions, identity/patient/profile routes, and the actual Vue 2 forms. Its host navigation, login view, patient GET adapter and session stored procedure are synthetic; mail/S3 are disabled. It is **not** a test of the full deployed app shell or production SSO. Run that smoke check separately in staging before release. Screenshots contain synthetic data only.

`scripts/qa/fixtures/nc1-schema.json` contains CREATE TABLE definitions from the workspace versioned schema export (14 tables; no rows, DROP or credentials). The fixture adapts login first/last name columns and its session procedure for this isolated auth scenario. Legacy DAO tests disable unrelated legacy FKs because the schema is partial; the separate R11 installation test runs with FK enforcement enabled.
