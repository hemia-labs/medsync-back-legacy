# Contabo deployments

Medsync backend QA uses [the Docker workflow](platform-operations/qa-docker-registry.md). The PM2 instructions below describe the legacy QA deployment and the existing production flow.

Both repositories use these destinations:

| Branch | GitHub environment | Workflow | VPS |
| --- | --- | --- | --- |
| main | prod | deploy.yml | 195.26.247.210 |
| develop | dev | deploy-dev.yml | 185.187.235.117 |

Pushes to the matching branch deploy automatically after required checks. Manual runs are allowed only on that same branch. Pull requests never deploy. Merge the workflow changes separately into main and develop; publishing only on main does not install the workflow on develop. The dev workflow also exists on the default branch so GitHub can expose its manual trigger.

## GitHub setup

The dev job declares environment: dev. Store DEV_* connection secrets in Settings > Environments > dev; These connection secrets may also be repository secrets. GitHub makes repository secrets available to the job and environment secrets override same-named repository secrets. Restrict the dev environment to the develop branch. Production retains its prod environment and secret names; configure it separately before migration.

The destination IP is explicit in each workflow. The old VPS_HOST secret is no longer read. Existing production secret names are retained; verify their values for the new VPS. Dev reads only DEV_* secrets, with no fallback to production names. Never copy the production database credentials, signing keys, external service credentials or API URL into dev.

| Production secret | Development secret |
| --- | --- |
| `APP_PORT` | `DEV_APP_PORT` |
| `VPS_APP_DIR` | `DEV_VPS_APP_DIR` |
| `VPS_KNOWN_HOSTS` | `DEV_VPS_KNOWN_HOSTS` |
| `VPS_PORT` | `DEV_VPS_PORT` |
| `VPS_SSH_KEY` | `DEV_VPS_SSH_KEY` |
| `VPS_USER` | `DEV_VPS_USER` |

VPS_PORT/DEV_VPS_PORT default to 22. APP_PORT/DEV_APP_PORT default to 3009. Other listed secrets are required. For dev, DEV_VPS_USER is medsync-deploy and DEV_VPS_APP_DIR is /srv/medsync/backend. This account has no sudo/docker/lxd membership. Production credentials remain to be configured separately. Use dedicated GitHub Actions SSH keys, separate from personal login keys. Install each public key in the corresponding server account; put its private key in the corresponding GitHub secret. These workflows expect deployment keys without a passphrase; restrict and rotate them as deployment credentials. Never put private keys in the repository.

VPS_KNOWN_HOSTS/DEV_VPS_KNOWN_HOSTS must contain the new server public host keys, verified through the Contabo console or another trusted channel. Do not blindly trust ssh-keyscan output. Production uses the `ENV_FILE` secret. Before deploying QA, provision `/srv/medsync/backend/shared/qa.env` on the QA VPS as `medsync-deploy` with mode `600`. The QA release links this file as `.env`. Keep NODE_ENV=production on both internet-facing servers for runtime security, with separate databases, secrets, HTTPS CORS origins and cookies. NODE_ENV does not select the Git branch. Configure the backend PORT to match APP_PORT (default 3009). The release script requires Node 22 via nvm, PM2, and a database/schema that passes /readyz.

## Activation and verification

1. Populate DEV_* secrets in the dev environment and/or repository for dev, or the prod environment secrets for production, and verify the SSH trust data.
2. Finish VPS, database, HTTPS/reverse proxy and DNS setup separately.
3. Merge the develop-targeted PR first when dev is ready; this triggers a dev deployment. Validate the application using its development URLs.
4. Merge the main-targeted PR only when the production migration is ready; this triggers a production deployment. DNS/database migration is a separate operation.
5. Inspect Actions and the target service after each deployment. Configuration validation and local tests do not prove a real deployment.

For manual deployment select develop in Deploy medsync-back-legacy to Contabo dev, or main in the prod workflow. Other refs are skipped.

## Rollback

Disable the affected workflow before changing routing. Reverting these workflow commits restores the old VPS_HOST-secret-based routing, so verify that secret and the old destination before merging a revert. Application/data rollback is separate from workflow rollback.

## References

- [GitHub deployments and environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
- [SSH host fingerprint verification](https://github.com/appleboy/ssh-action#host-fingerprint-verification)

## Development endpoints

Frontend: https://test.medsync.mx/ . Backend base URL: https://api-test.medsync.mx/ (do not append /api in DEV_VUE_APP_CORE_URL_API).

The backend connects to MySQL on 127.0.0.1:3306, database hemia_assitant_legacy, user medsync_test_app. The server QA environment contains its database password, signing keys and SES settings. Update it atomically and keep a private copy before changes. If a release rolls back after an environment change, restore the previous environment separately. Never print it in CI logs.
