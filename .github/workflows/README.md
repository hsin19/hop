# CI/CD Workflows

## Architecture

```
check.yml   workflow_call → check: format · lint · typecheck · unit tests
                                   · build (dry-run) → Codecov upload
pr.yml      pull_request  → check.yml · dependency-review
                          → auto-merge (Dependabot)
deploy.yml  push to main  → check.yml → deploy to Cloudflare Workers → smoke check
```

`check.yml` is a reusable (`workflow_call`) workflow holding the single definition
of "did this tree pass" — everything `pnpm run check` covers locally, which is the
equivalence to preserve when adding anything: a check belongs in both or in
neither. Both other workflows call it, so a PR and a `main` push are held to the
same bar and the list cannot drift between them — which it did when one file
spelled the steps out three times, once per job.

`check` runs each check as its own step rather than chaining them into one
command, so the failing step names itself in the Actions UI, and the steps are
conditioned to keep going after one fails so a single run reports every failure
instead of stopping at the first. (They do stop depending on a successful
`pnpm install`, which would otherwise red all of them at once and bury the real
cause.) The `Build` step is `wrangler deploy --dry-run`: it bundles and validates
`wrangler.jsonc` without touching the account, so it is a check, not a deploy.

Neither caller is called `ci.yml`, and that is the point: CI is not what tells them
apart — both run the same gate — so they are named for the event that starts them.
`pr.yml` therefore does not run on `main` pushes at all; `deploy.yml` handles that
commit, gate included. `check.yml` also takes a `workflow_dispatch`, so "run every
check against this ref" is available without going through either.

`deploy.yml` has no separate build job. `pnpm run build` is the same dry-run
`check.yml` already performed on this exact tree, and `wrangler-action` builds from
source itself, so there is no artifact to hand between the two. The cost of this
layout is that every `main` push — a Dependabot auto-merge included — runs the full
suite again; that double run per merged PR is the price of holding a direct push to
`main` to the same bar as a PR.

Two deploy-time guards are deliberate. `wrangler-action` pushes every secret it is
given, so an empty `ADMIN_SECRET` would silently replace the live one with `""` and
make **every** bearer token match — the `Verify required secrets` step refuses the
deploy instead. Afterwards the `/health` endpoint is probed with retries, which is
what `test/index.spec.ts`'s "reports the service name" test exists to keep
assertable.

## Dependency review

`pr.yml`'s `dependency-review` job fails every PR with "Dependency review is not
supported on this repository" until the **Dependency graph** is on — enable
Dependabot alerts (Settings → Advanced Security), which switches it on too. It
also gates `auto-merge`, so with the graph off no Dependabot PR ever merges.

## Dependabot auto-merge → deploy

`pr.yml` merges a green Dependabot PR using `secrets.AUTOMERGE_TOKEN` (a dedicated
token, **not** the default `GITHUB_TOKEN`) so the resulting push to `main`
triggers `deploy.yml`. A push made with `GITHUB_TOKEN` would not — GitHub never
lets a `GITHUB_TOKEN` push start another workflow.

> `AUTOMERGE_TOKEN` must live in **Dependabot** secrets
> (Settings → Secrets and variables → Dependabot), not Actions secrets —
> Dependabot-triggered runs only see the Dependabot secret store.

`AUTOMERGE_TOKEN` is a fine-grained PAT scoped to this repository with
`contents: read/write` and `pull requests: read/write` permissions (or a classic
PAT with `repo` scope). A PAT already used by show-me-way or InTheGreenYet can be
reused only if its repository access list includes this repo. Fine-grained PATs
expire (max 1 year) — an expired token makes auto-merge silently stop merging
while CI stays green, so track the expiry date. A red Dependabot PR (typically
peer-dependency skew — `@cloudflare/vitest-pool-workers` pins narrow ranges on
`vitest` and `@vitest/runner`, and `typescript-eslint` refuses to load outside its
`typescript` peer range) is left for a human; there is no auto-repair job.

The `deploy-actions` group in `dependabot.yml` is excluded from auto-merge.
`cloudflare/wrangler-action` only ever runs on a push to `main`, so a green PR
proves nothing about it and a bad bump would land straight in the production
deploy — it gets a human look instead.

## Coverage → Codecov

The `test:ci` step writes two reports — `coverage/lcov.info` and
`test-report.junit.xml` (test results) — and both are uploaded through
`codecov/codecov-action@v7`. Thresholds and the PR comment policy live in
`codecov.yml`; the measured scope — `src/**/*.ts` — is set in `vitest.config.ts`.

Both uploads live in `check.yml`, so every caller gets them: a PR uploads its own
reports through `pr.yml`, and the `main` baseline those are diffed against is the
upload from `deploy.yml`'s call — the only run of the suite on the default branch.

> `CODECOV_TOKEN` is an **Actions** secret (Settings → Secrets and variables →
> Actions) — unlike `AUTOMERGE_TOKEN`. A Dependabot PR therefore cannot read it, so
> the upload no-ops there; `fail_ci_if_error: false` on both steps is what keeps
> that from failing an otherwise green bump.

Both upload steps carry `if: ${{ !cancelled() }}` so a failing `Build` step still
ships the reports the tests already produced — on `main` in particular, dropping
them would leave the next PR diffed against a stale baseline.
