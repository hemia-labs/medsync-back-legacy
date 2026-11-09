# Contabo deployments

| Branch | GitHub environment | Workflow | VPS |
| --- | --- | --- | --- |
| main | prod | deploy.yml | 195.26.247.210 |
| develop | qa-registry | deploy-dev.yml | 185.187.235.117 |

Pushes to the matching branch deploy automatically after the required checks. Pull requests run checks. For a manual run, select the branch that matches the target environment.

## QA

QA deploys with Docker by digest. Use the [QA Docker runbook](platform-operations/qa-docker-registry.md) for registry and SSH credentials, the shared QA environment file, verification and rollback. The frontend is [test.medsync.mx](https://test.medsync.mx/) and the backend base URL is [api-test.medsync.mx](https://api-test.medsync.mx/).

## Production

Production deploys with PM2. Configure `ENV_FILE`, `VPS_APP_DIR`, `VPS_KNOWN_HOSTS`, `VPS_SSH_KEY` and `VPS_USER` in the `prod` environment. `VPS_PORT` defaults to 22 and `APP_PORT` to 3009. Verify the SSH host key against a trusted source, use a dedicated Actions SSH key and keep the environment file private. The server uses Node 22 via nvm and needs a database schema that passes `/readyz`.

Before merging to `main`, confirm the production configuration and schema for the incoming release. After the merge, check the Actions run and the [production readiness endpoint](https://api.medsync.mx/readyz).

The [production Docker runbook](platform-operations/prod-docker-registry.md) covers image publication, the separate cutover by digest and rollback.
