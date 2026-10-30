# Contabo deployments

Both repositories use these destinations:

| Branch | GitHub environment | Workflow | VPS |
| --- | --- | --- | --- |
| main | prod | deploy.yml | 195.26.247.210 |
| develop | dev | deploy-dev.yml | 185.187.235.117 |

Pushes to the matching branch deploy automatically after required checks. Manual runs are allowed only on that same branch. Pull requests never deploy. Merge the workflow changes separately into main and develop; publishing only on main does not install the workflow on develop. The dev workflow also exists on the default branch so GitHub can expose its manual trigger.

## GitHub setup

In this repository, configure Settings > Environments: prod allows main only; dev allows develop only. Store each environment's secrets there. Required reviewers for prod are recommended while provisioning the new VPS. Do not merge or dispatch until the intended environment is ready.

The destination IP is explicit in each workflow. The old VPS_HOST secret is no longer read. Existing production secret names are retained; verify their values for the new VPS. Dev reads only DEV_* secrets, with no fallback to production names. Never copy the production database credentials, signing keys, external service credentials or API URL into dev.

| Production secret | Development secret |
| --- | --- |
| `APP_PORT` | `DEV_APP_PORT` |
| `ENV_FILE` | `DEV_ENV_FILE` |
| `VPS_APP_DIR` | `DEV_VPS_APP_DIR` |
| `VPS_KNOWN_HOSTS` | `DEV_VPS_KNOWN_HOSTS` |
| `VPS_PORT` | `DEV_VPS_PORT` |
| `VPS_SSH_KEY` | `DEV_VPS_SSH_KEY` |
| `VPS_USER` | `DEV_VPS_USER` |

VPS_PORT/DEV_VPS_PORT default to 22. APP_PORT/DEV_APP_PORT default to 3009. Other listed secrets are required. VPS_USER is the SSH account (currently root in the local connection config); VPS_APP_DIR must be a dedicated absolute application directory. Use dedicated GitHub Actions SSH keys, separate from personal login keys. Install each public key in the corresponding server account; put its private key in the corresponding GitHub secret. These workflows expect deployment keys without a passphrase; restrict and rotate them as deployment credentials. Never put private keys in the repository.

VPS_KNOWN_HOSTS/DEV_VPS_KNOWN_HOSTS must contain the new server public host keys, verified through the Contabo console or another trusted channel. Do not blindly trust ssh-keyscan output. ENV_FILE/DEV_ENV_FILE contain the complete environment file for the corresponding backend. Keep NODE_ENV=production on both internet-facing servers for runtime security, with separate databases, secrets, HTTPS CORS origins and cookies. NODE_ENV does not select the Git branch. Configure the backend PORT to match APP_PORT (default 3009). The release script requires Node 22 via nvm, PM2, and a database/schema that passes /readyz.

## Activation and verification

1. Populate secrets for the matching environment and verify the SSH trust data.
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
