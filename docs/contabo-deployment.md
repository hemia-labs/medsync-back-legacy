# Contabo deployments

| Branch | GitHub environment | Workflow | VPS |
| --- | --- | --- | --- |
| main | prod-deploy | deploy-prod-docker.yml | 195.26.247.210 |
| develop | qa-registry | deploy-dev.yml | 185.187.235.117 |

Pull requests run checks. Pushes to `develop` deploy QA automatically. Production requires a published stable release and a manual deployment from `main`.

## QA

QA deploys with Docker by digest. Use the [QA Docker runbook](platform-operations/qa-docker-registry.md) for registry and SSH credentials, the shared QA environment file, verification and rollback. The frontend is [test.medsync.mx](https://test.medsync.mx/) and the backend base URL is [api-test.medsync.mx](https://api-test.medsync.mx/).

## Production

Production deploys with Docker by digest. Merging the Changesets version PR publishes the release image. To activate it, use **Deploy published MedSync release** with its stable tag.

Keep the production environment at `/srv/medsync/backend/shared/.env.production` as a regular file owned by `medsync-deploy` with mode `0600`. Keep a protected backup when updating it and restore the backup separately if a configuration change needs to be reverted.

Before deploying, confirm the production configuration and schema for the incoming release. After deployment, check the Actions run and the [production readiness endpoint](https://api.medsync.mx/readyz).

The [production Docker runbook](platform-operations/prod-docker-registry.md) covers image publication, deployment credentials and rollback.
