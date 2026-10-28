# CO25 A0-A5: agenda integrity and continuity

Appointments enforce clinic-clock transitions, explicit cancellation reasons, revision checks and idempotent writes. Manual bookings can be linked to a patient through a dedicated audited operation. Minimal registration recovers an uncertain result without creating a second patient; authorized navigation preserves the draft in memory. Follow-ups reserve one appointment under concurrent requests.

CSRF uses stable valid cookies and a single bounded recovery that preserves the original request, identity and permissions. Full application acceptance also fixed the patient-creation permission getter, unauthorized clinical-context requests, document-read denials returning 401 instead of 403, and date selection during initial loading.

## Integration

Integrate the paired backend before frontend. No new CO25 database migration. Prerequisites are the existing CO21 revision/audit/receipt schema and patient-code counter/unique index; the existing migration scripts have read-only preflight modes. Do not apply migrations automatically on startup or grant additional permissions to make a workflow pass.

## Validation

- [Full application acceptance](co25-a5-results.json): 16 scenarios, six permission profiles, two tenants, real bcrypt login, SQL sessions/JWT, HTTPS cookies and CSRF. Zero JS errors or HTTP 5xx. Synthetic data only.
- Backend: 24 isolated scripts, CO14 regression; current-main Pulse regression checked for release.
- Frontend: 10 targeted scripts (CO21 14/14, A4 14 groups, A3 8, clinical context 4, CO14, S18, history/template access, CSRF), lint and complete build.
- [CSRF browser coverage](co25-csrf-results.json): 19 scenarios with actual Axios/cookies and synthetic identity/persistence.

Run backend `npm run qa:isolated` and `node scripts/qa/co14-follow-up-regression.js`. Frontend examples: `node scripts/qa/co21-agenda-regression.cjs`, `node scripts/qa/co25-a4-regression.cjs`, `node scripts/qa/co25-a5-context-regression.cjs`, and `node scripts/qa/co25-csrf-browser.cjs`.

The integrated `node scripts/qa/co25-a5-browser.cjs` is workspace QA: it requires both repositories with their workspace names, the schema-only snapshot, dependencies and the private MySQL binary described in the fixture. It creates a marked disposable database, disables external sends/jobs and never loads habitual env files. Its build runner is included in the frontend repository. It is not a production smoke test.

## Limits

Desktop and mobile browser emulation; physical devices, assistive technology and destination deployment validation remain separate. Return drafts and uncertain-operation keys are in memory, not durable across reload/closure. Clinical history still depends on document/prescription permissions for its editable context. Historical inconsistencies, broader follow-up windows, unknown birth dates and blocks B-F are outside this delivery. No deployment or merge is implied.
