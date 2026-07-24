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
- Supports explicit `deploy` and `remove` operations, plus event-based auto detection

## Recommended usage

Use one workflow for deployment, close-event cleanup, and manual cleanup.

```yaml
name: SST Preview

on:
  pull_request:
    types: [opened, reopened, synchronize]
  pull_request_target:
    types: [closed]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number to clean up
        required: true
        type: number

concurrency:
  group: preview-pr-${{ inputs.pr_number || github.event.pull_request.number }}
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

The manual cleanup input is a pull request number, not an SST stage name. The
action validates it and always derives a `pr-{number}` stage, so it cannot be
used to remove `dev`, `stg`, or `prod`.

## SST configuration

Protect persistent environments and purge state only for pull-request stages:

```ts
const persistentStages = new Set(["dev", "stg", "prod"]);

export default $config({
  app(input) {
    const persistent = persistentStages.has(input.stage);
    const preview = /^pr-[1-9][0-9]*$/.test(input.stage);

    return {
      name: "my-app",
      removal: persistent ? "retain" : "remove",
      protect: persistent,
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
| `operation`                  | false    | `auto`  | `auto`, `deploy`, or `remove`                              |
| `pr-number`                  | false    |         | PR number for manual workflows                             |
| `comment-enabled`            | false    | `true`  | Post a preview URL comment after deployment                |
| `cleanup-on-deploy-failure`  | false    | `true`  | Remove the preview stage after a failed deployment         |
| `remove-max-attempts`        | false    | `3`     | Maximum removal attempts                                   |
| `remove-retry-delay-seconds` | false    | `30`    | Delay between removal attempts                             |
| `verify-removal`             | false    | `auto`  | `auto`, `true`, or `false`                                 |
| `url-output-key`             | false    | `url`   | Top-level SST output key containing the preview URL        |

With `operation: auto`, a `closed` pull-request event removes the stage and all
other pull-request actions deploy it. The stage is always derived from
`pr-number` or `github.event.pull_request.number`; arbitrary stage names are not
accepted. When both values are present, they must match.

`verify-removal: auto` verifies state when the installed SST version supports
reliable state deletion and falls back with a warning for older versions.
Use `true` for strict verification with SST 4.13.0 or newer.

## Outputs

| Name        | Description                                    |
| ----------- | ---------------------------------------------- |
| `url`       | Deployed preview URL, when one is available    |
| `operation` | Resolved `deploy` or `remove` operation        |
| `stage`     | The `pr-{number}` SST stage used by the action |

## Prerequisites

1. AWS credentials are configured before this action runs.
2. Node.js and the project package manager are available.
3. Project dependencies, including a locally pinned SST version, are installed.
4. The working directory contains a valid SST project.

## License

MIT
