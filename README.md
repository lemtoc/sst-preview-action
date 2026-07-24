# SST Preview Action

Deploy and remove isolated SST preview environments for pull requests.

<img width="2050" height="754" alt="SST preview deployment comment" src="https://github.com/user-attachments/assets/160e8769-14ba-45be-8bd3-6e6b3aee26c1" />

## Features

- Deploys only to a `pr-{number}` stage
- Removes a partially created stage when deployment fails
- Retries failed removals and verifies the SST state
- Streams SST deployment logs in real time
- Reads a named SST output with a CloudFront URL fallback
- Posts a sticky PR comment with the preview URL
- Supports PR-number-only manual cleanup
- Reconciles orphaned preview stages on a schedule
- Supports explicit `deploy`, `remove`, and `reconcile` operations, plus event-based auto detection

## Recommended usage

Use one workflow for deployment, close-event cleanup, and manual cleanup.

```yaml
name: SST Preview

on:
  pull_request:
    types: [opened, reopened, synchronize]
  pull_request_target:
    types: [closed]
  schedule:
    - cron: "23 */6 * * *"
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number to clean up
        required: true
        type: number

concurrency:
  group: sst-preview
  queue: max
  cancel-in-progress: false

permissions:
  contents: read
  id-token: write
  pull-requests: write

jobs:
  preview:
    if: >-
      ${{
        github.event_name != 'pull_request' ||
        (
          github.actor != 'dependabot[bot]' &&
          github.event.pull_request.head.repo.full_name == github.repository
        )
      }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          ref: >-
            ${{
              github.event_name == 'pull_request' &&
              github.event.pull_request.head.sha ||
              github.event.repository.default_branch
            }}
          persist-credentials: false
      - uses: actions/setup-node@v6
        with:
          node-version: 24
      - uses: aws-actions/configure-aws-credentials@v5
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ap-northeast-1
      - uses: lemtoc/sst-preview-action@v1
        with:
          operation: ${{ github.event_name == 'workflow_dispatch' && 'remove' || 'auto' }}
          pr-number: ${{ inputs.pr_number || github.event.pull_request.number }}
          working-directory: path/to/sst/project
```

For production workflows, pin third-party actions to a full commit SHA.

The workflow deploys pull-request head code only for same-repository
`pull_request` events. `pull_request_target` close events and manual cleanup
always run the trusted default branch, including when the pull request has merge
conflicts. Do not change the checkout expression to execute pull-request code
for these privileged events.

Scheduled runs reconcile SST state from the trusted default branch. The shared
concurrency group prevents deployment, close cleanup, and reconciliation from
overlapping. `queue: max` keeps up to 100 lifecycle runs waiting instead of
replacing an older pending run.

The manual cleanup input is a pull request number, not an SST stage name. The
action validates it and always derives a `pr-{number}` stage, so it cannot be
used to remove `dev`, `stg`, or `prod`.

## Reconciliation

Reconciliation is a safety net for a close-event workflow that failed or was
canceled. It:

1. Lists deployed SST stages and accepts only bare `pr-{number}` entries.
2. Queries each matching pull request and completes the entire removal plan
   before deleting anything.
3. Keeps open and recently closed pull requests.
4. Removes pull requests that have remained closed for at least one hour.
5. Rechecks every eligible pull request immediately before writing the
   token-free removal plan.

The inventory command uses `pr-1` only as a read-only probe context for
evaluating `sst.config`; it does not deploy or remove that stage. Reconciliation
requires the app name returned by `app(input)` to stay the same across all
pull-request stages.

Any SST state or GitHub API error aborts planning without removing a stage.
Reconciliation also refuses plans larger than 20 stages. It does not scan AWS
resources that are missing from SST state. The action-provided GitHub token is
available only to the planning step; the action does not pass it to SST or
application code. A plan over the limit requires manual cleanup before
scheduled reconciliation can resume.

GitHub state checks and AWS removal cannot be one atomic operation. If a pull
request reopens after the final check, the shared concurrency queue keeps its
deployment behind reconciliation so the preview is recreated afterward.

## SST configuration

Protect persistent environments and purge state only for pull-request stages:

```ts
const persistentStages = new Set(["dev", "stg", "prod"]);

export default $config({
  app(input) {
    const persistent = persistentStages.has(input.stage);
    const preview = /^pr-[1-9][0-9]*$/.test(input.stage);

    if (!persistent && !preview) {
      throw new Error(`Unsupported stage: ${input.stage}`);
    }

    return {
      name: "my-app",
      removal: preview ? "remove" : "retain",
      protect: !preview,
      state: {
        purge: preview,
      },
      home: "aws",
    };
  },
  async run() {
    const frontend = new sst.aws.Nextjs("Frontend");

    return {
      url: frontend.url,
    };
  },
});
```

The action reads `url` from `.sst/outputs.json` by default. Use
`url-output-key` when the project returns a different top-level key. Projects
that do not configure a named output keep the existing CloudFront URL fallback.
`state.purge` requires SST 4.13.0 or newer and the corresponding S3
object-version deletion permissions in the AWS role. Purging state is
irreversible, so keep its condition restricted to canonical `pr-{number}`
stages.

## Inputs

| Name                         | Required | Default | Description                                                |
| ---------------------------- | -------- | ------- | ---------------------------------------------------------- |
| `working-directory`          | false    | `.`     | Directory containing `sst.config`                          |
| `operation`                  | false    | `auto`  | `auto`, `deploy`, `remove`, or `reconcile`                 |
| `pr-number`                  | false    |         | PR number for manual workflows                             |
| `comment-enabled`            | false    | `true`  | Post a preview URL comment after deployment                |
| `cleanup-on-deploy-failure`  | false    | `true`  | Remove the preview stage after a failed deployment         |
| `remove-max-attempts`        | false    | `3`     | Maximum removal attempts                                   |
| `remove-retry-delay-seconds` | false    | `30`    | Delay between removal attempts                             |
| `verify-removal`             | false    | `auto`  | `auto`, `true`, or `false`                                 |
| `url-output-key`             | false    | `url`   | Top-level SST output key containing the preview URL        |

With `operation: auto`, scheduled events reconcile stages, closed pull-request
events remove their stage, and other events deploy it. Manual cleanup must pass
`operation: remove`, as shown above. Deploy and remove stages are always derived
from `pr-number` or `github.event.pull_request.number`; arbitrary stage names are
not accepted. When both values are present, they must match. Explicit
`operation: reconcile` is limited to `schedule` and `workflow_dispatch` events.

`verify-removal: auto` verifies state when the installed SST version supports
reliable state deletion and falls back with a warning for older versions.
Use `true` for strict verification with SST 4.13.0 or newer.

## Outputs

| Name        | Description                                    |
| ----------- | ---------------------------------------------- |
| `url`       | Deployed preview URL, when one is available    |
| `operation` | Resolved `deploy`, `remove`, or `reconcile` operation |
| `stage`     | The `pr-{number}` stage; empty for reconciliation     |

## Prerequisites

1. AWS credentials are configured before this action runs.
2. Node.js and the project package manager are available.
3. Project dependencies, including a locally pinned SST version, are installed.
4. The working directory contains a valid SST project.

## License

MIT
