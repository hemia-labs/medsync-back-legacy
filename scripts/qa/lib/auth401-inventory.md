# NC1 401 inventory

Run `node scripts/qa/nc1-auth-s1-s3-regression.js` and `node scripts/qa/auth401-inventory-regression.js` (both are in `qa:isolated`). No MySQL or external service is needed. Acorn is an exact, development-only dependency.

The scanner parses JavaScript rather than searching lines. It checks literal/enum 401 origins, authentication helper calls/references, statusCode assignments and HTTP status/serializer calls. A literal AUTH code must belong to the emitted object's data or root, or to the data argument of `unauthorized`. Duplicate keys and spreads are not assumed safe. Comments, unrelated objects and multiline formatting do not change this decision. Transparent `res.status(result.status).send(result)` forwarding preserves the same envelope; its origins are checked separately.

Aliases and unknown dynamic values are **not assumed compliant**. They require a reviewed exception. This deliberately favors a review request over attempting speculative data-flow resolution. It is not whole-program analysis and does not prove arbitrary runtime behavior, computed method names, code loaded outside `src`, proxies or external statuses. Keep the HTTP tests: a source inventory cannot by itself prove every serialized response.

`auth401-reviewed.json` pins each unresolved node by file, semantic AST hash, enclosing-function hash and exact occurrence count, with a readable snippet, scope and reason. The scanner checks stale/expanded counts itself. An added emitter on the same line or in another file is not covered. Changes to a reviewed function force its exceptions to be reviewed again, even if a helper call's text stays unchanged. Formatting/comments alone do not invalidate semantic fingerprints.

The reviewed inventory contains two different categories; neither is a blanket file exclusion:

- Auth controls and definitions: refresh/close/login/changePassword retain their agreed contract; session/theme mapping and Pulso propagation have HTTP coverage. Helper definitions/exports and numeric constants do not authorize their call sites.
- Existing dynamic boundaries: legacy controller catches call `HttpError(error.status, error.message)`; generic error handlers, CORS, validation, registration and domain serializers are recorded explicitly. These are **not certified authentication emitters**. New explicit 401 origins fail independently. Do not add authentication errors through a legacy serializer without testing its final envelope; some legacy helpers discard a thrown code.

To update an exception, inspect its route/callers and final envelope, add or retain appropriate HTTP coverage, then update only the reviewed node/context/count and explain why in the PR. There is intentionally no automatic accept/update command. Never regenerate all exceptions merely to make CI green.

`node scripts/qa/auth401-inventory-regression.js --legacy` runs the same syntax examples against the delivered scanner from `3ab30894` using a read-only git show. It intentionally fails on that revision (19/22 cases). Normal CI never uses this historical mode.
