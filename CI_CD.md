# TerraCart customer web CI/CD

Repository: `AiAlly-second/TerraCart-Frontend`. React 19 / Vite 7, JavaScript/JSX, npm lockfile; Node **22.23.3**. Default/active branch `main`. Existing `vercel.json` and GitHub deployment history from `vercel[bot]` establish **Vercel** as the current web deployment provider. No provider migration was made.

Before: a Node 20 build-only GitHub workflow with non-lock npm install and no security/tests/production approval. The customer workflow did not itself deploy; provider Git integration was a separate deployment path.

## Workflows, configuration and helpers

- `.github/workflows/terracart-frontend-cicd.yml`: PR/all branch push/manual strict CI; ESLint, explicit no-framework status plus helper safety tests, dependency audit and secret/dangerous-operation scan. Build depends on all checks.
- `.github/workflows/deploy-production.yml`: protected main-only manual Vercel deployment, default dry run, numeric successful main CI run ID, no active-deploy cancellation.
- `vercel.json`: added only `git.deploymentEnabled=false`, preserving existing SPA/cache/build configuration. This prevents Git deployment once adopted, but **the operator must disable/disconnect existing Vercel Git automation before merging/PR activation**; local edits do not change remote project settings or revoke existing deployments.
- `ci/.gitignore`, `ci/policy.json`, `ci/checks.py`, `ci/artifact.py`, `ci/github.py`, `ci/deploy_web.py`.
- `ci/tests/test_safety.py`, `ci/tests/test_web.py`: provenance/environment/archive, dry-run/target and static-smoke/rollback tests.

## Public configuration and protected secret names

Protected secret: **`VERCEL_TOKEN`**, scoped to the existing project/team and required deployment operations.

Protected variables: `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `PRODUCTION_WEB_ORIGIN`, `PRODUCTION_DEPLOYMENTS_ENABLED`.

Repository **public build variables**: `PRODUCTION_API_ORIGIN`, `PRODUCTION_FALLBACK_API_ORIGIN`. Use the same reviewed values for production dispatch; the helper rejects artifact/config drift.

The browser receives only public `VITE_NODE_API_URL`, `VITE_PRIMARY_API_URL`, `VITE_FALLBACK_API_URL`, `VITE_USE_VITE_PROXY=false`. Never put DB URIs, passwords, AWS/signing/service-account keys or private tokens in `VITE_*`. `.env.production`/other local real environment files are not copied into CI/artifacts. Legacy Flask variables are not referenced by current app source and are not guessed/introduced.

PR build configuration is loopback-only. Main builds require explicit HTTPS production origins and build into a fresh temporary Vercel Build Output v3 directory with current immutable `/assets/` caching and SPA fallback. The production artifact is tied to commit/run and public configuration; production does not rebuild or pull provider environment files.

## Deployment and rollback

Install pinned Vercel CLI **62.2.0** in runner tooling. Verify project/account IDs, current READY production deployment, the reviewed site's existing production alias, public artifact configuration, and current HTML/critical JavaScript before any mutation. Dry run does GET/read/verification only; it does not create previews or production deployments.

Activation uses `vercel deploy --prebuilt --prod` for the validated artifact, then read-only HTTPS checks verify served HTML/critical JavaScript bytes against that selected artifact. No backend, database, AWS/S3 sync or application source command is executed. On failure, `vercel rollback <verified-previous-deployment-id>` restores the previous provider artifact, then verifies the old site. Old deployment retention and rollback capability must be confirmed with the existing Vercel account/plan. If rollback fails, the job fails and an operator must use the recorded previous deployment in the Vercel dashboard; no success is inferred.

For an operator-requested rollback after a completed deployment, use Vercel's prior production deployment/Instant Rollback under the same human approval policy. Record the prior deployment ID before activation. Rollback restores the application artifact only; it does not revert production data. A new CLI production dispatch still requires successful main CI and protected review; no unchecked rollback/build bypass was added.

## Existing dangerous operations

No deployment/reset package script is used by the customer pipeline. Existing manual instructions and broad removal/seed matches are recorded as potentially dangerous audit locations and excluded from CI execution.

## Recorded baseline

Locked dependency install and independent production-style static compile passed. ESLint fails: **146 errors / 20 warnings**. No test framework/script exists; no fake passing tests were added. Dependency audit fails: **5 high (12 total)**. Secret pattern scan found zero matching findings. **19 CI helper tests passed**. These checks stay strict; no source changes, test filtering, lint exclusions, forced dependency upgrades or ignored failures were added. Browser/live Vercel deployment/rollback testing remains unperformed.
## Safety and activation status

Implemented locally; **production activation is blocked**. No commit, push, GitHub settings change, hosting change, production deployment, migration, seed, reset, restore, or production database operation was performed. Existing application changes in this dirty workspace predate this task and were preserved.

**Application source modification required** to make the existing failing application checks green. Remediate those failures in a separately reviewed application change. This implementation does not weaken checks, change application code, change lockfiles, generate a signing key, or auto-increment a release version.

PRs and branch pushes run validation only, with `contents: read`. CI does not reference production/cloud/signing/Firebase secrets and does not use `pull_request_target`. Installs use the committed lockfile, ignore npm lifecycle hooks, and check lockfile retention. Reviewed npm script definitions must exactly match `ci/policy.json`; changed definitions fail closed.

Production is `workflow_dispatch` on `main` only, in the native `production` environment. `dry_run` defaults to true. Native required reviewers, selected-main-only deployment rules, and actual main protection requiring a reviewed PR and all four CI checks are checked again by the helper. Actual activation additionally requires protected environment variable `PRODUCTION_DEPLOYMENTS_ENABLED=true`. Keep it absent/false until every prerequisite and the first dry run pass. Production workflow concurrency never cancels an active deployment.

Only a successful, completed, same-repository **main-push CI** run from the specified CI workflow supplies an artifact. Failed runs, PR runs, feature branches, forks, expired/missing artifacts, foreign workflows, archive links/traversal, wrong environment/repository/commit/run ID, and checksum mismatches are rejected. Artifacts include repository, full commit SHA, run ID, environment, file hashes, and reviewed public configuration. The GitHub archive digest, inner tar checksum, and individual file hashes are checked. Ordinary CI reports retain 14 days; main build artifacts retain 30 days.

**No staging environment detected.** Historical Vercel Preview/Production labels do not establish an isolated staging API/database. No staging or preview deployment workflow was added. PR web builds use a loopback-only API origin; mobile debug CI uses a loopback `.env` asset and `USE_PROD_API=false`.

## Required GitHub controls

Create/configure a lowercase `production` environment with required human reviewers, prevent self-review and bypass where the plan supports it, and selected deployment **branch `main` only** (no tags/wildcards). If the repository plan cannot enforce native reviewers, production stays disabled; there is no replacement approval checkbox or custom pseudo-approval workflow.

Protect `main` with reviewed PRs, dismiss stale approvals, required checks `Checks (lint)`, `Checks (test)`, `Checks (security)`, and `Build`, require current branch status, prohibit force pushes/deletion, and review workflow/helper changes through trusted maintainers. Prefer a repository ruleset plus restricted bypass; status checks alone do not establish trusted deployment code. No repository settings were changed in this task.

Production secrets belong in the protected environment only. Keep workflow token permissions read-only; deployment artifact retrieval adds `actions: read`. Do not grant `contents: write`, `id-token: write`, production Mongo credentials, or general-purpose cloud administrator credentials to PR CI. Enable native secret scanning/push protection where available; the included scanner checks current source for selected high-confidence credential patterns and does **not** prove historical Git history is clean.

## First safe activation

1. Review only this task's workflow/CI/documentation/deployment-config diff; preserve all pre-existing dirty changes. Do not stage whole mixed application files.
2. Disable existing provider automation that could deploy outside these workflows before merging. Configure branch protections/native environment reviewers, and move production credentials out of repository-level secrets.
3. Open reviewed CI implementation PRs and run validation without production credentials. Keep failing PRs unmerged; deployment remains disabled and dry-run-only.
4. Fix the recorded application lint/test/format/analysis and dependency blockers through separately reviewed changes. Require all PR checks before merging the CI setup, then require a successful full main CI before any deployment. A successful build alone is insufficient.
5. Configure explicit reviewed production variables, least-privilege hosting access, verified SSH known hosts where used, and server/provider prerequisites. Do not initialize/migrate live storage as part of CI.
6. After a successful main-push CI run, dispatch production with that numeric CI run ID and `dry_run=true`. Complete native review. Verify artifact provenance, target identity, persistent-state protection, health, rollback, and the expected absence of writes.
7. Only after reviewing dry-run evidence, deliberately set `PRODUCTION_DEPLOYMENTS_ENABLED=true` and approve a separately dispatched activation with `dry_run=false`. The first CI run never deploys. Monitor read-only smoke checks and preserve the prior application artifact.

## Local validation and limits (2026-10-04)

Validation used separate source copies and checksum-verified Node 22.23.3. npm installs with `npm ci --ignore-scripts` passed. All existing application checks were run independently to expose the baseline even where production CI correctly stops before building. Results and sanitized reports are in `../TerraCart-AdminApp/build/work-ux-validation/cicd-2026-10-04/` in this multi-checkout workspace; they are local working-tree evidence (including preserved uncommitted changes), not a remote-main, GitHub Actions or production acceptance claim. No live production dry run, deploy, signing release, Firebase upload, live provider rollback, or device installation was performed.

Actionlint 1.7.12 validates all workflow syntax/expressions; bash command syntax is checked separately. ShellCheck/PyFlakes were unavailable and are not claimed. CI helper unit tests use temporary local fixtures and mocked hosting/PM2/Firebase operations. Current-source secret scans found no matching secrets in the isolated copies; this is limited pattern coverage. There is no Flutter dependency vulnerability feed integrated; Flutter security validation currently covers committed credential/signing-file detection and dangerous-operation reporting.

## Database boundary

**NO AUTOMATIC PRODUCTION DB MUTATION COMMANDS.** CI receives no production DB credentials. Backend tests use a disposable local Mongo replica set named `terracart_inventory_isolation_test`, with a preload guard rejecting remote hosts, other database names, credentials, URI overrides, and non-test environments. Tests may create/delete only their disposable fixtures. The backend server is never started by CI. Deployment helpers have no DB driver/URI, seed/reset/migration/restore command, or database rollback.

The SSH deployment account operates on a host that already has the application's production `.env`; it has indirect host access, so least-privilege account controls matter. Reloading the existing application retains its existing database permissions, business schedulers, and implicit Mongoose model/index initialization. This implementation does not claim the running application is read-only or that application startup can never write/create indexes. Strict zero writes across application startup would require separate database-permission/application changes; those are outside this source-preserving CI task. Verify runtime/IAM/index behavior before activation. No production DB credentials were read/copied into CI, and no live DB safety claim is inferred from local tests.
