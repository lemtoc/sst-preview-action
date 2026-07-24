# SST Preview Action

Deploy and remove isolated SST preview environments for pull requests.

<img width="2050" height="754" alt="SST preview deployment comment" src="https://github.com/user-attachments/assets/160e8769-14ba-45be-8bd3-6e6b3aee26c1" />

## Features

- Deploys only to a `pr-{number}` stage
- Removes a partially created stage when deployment fails
- Retries failed removals and verifies the SST state
- Posts a sticky PR comment with the CloudFront URL
- Supports explicit `deploy` and `remove` operations, plus event-based auto detection

## Recommended usage

Use separate workflows for deployment and cleanup. Give both workflows the same
concurrency group so a close event waits for an in-progress deployment.

### Deploy previews

```yaml
name: Deploy SST Preview

on:
  pull_request:
    types: [opened, reopened, synchronize]

concurrency:
  group: preview-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: false

permissions:
  contents: read
  id-token: write
  pull-requests: write

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
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
          operation: deploy
          working-directory: path/to/sst/project
```

For production workflows, pin third-party actions to a full commit SHA.

### Clean up closed previews

```yaml
name: Cleanup SST Preview

on:
  pull_request_target:
    types: [closed]

concurrency:
  group: preview-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: false

permissions:
  contents: read
  id-token: write

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout trusted default branch
        uses: actions/checkout@v6
        with:
          ref: ${{ github.event.repository.default_branch }}
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
          operation: remove
          working-directory: path/to/sst/project
```

`pull_request_target` runs cleanup from the default branch even when the pull
request has merge conflicts. Do not check out or execute pull-request code in
this privileged cleanup workflow.

## Inputs

| Name                         | Required | Default | Description                                        |
| ---------------------------- | -------- | ------- | -------------------------------------------------- |
| `working-directory`          | false    | `.`     | Directory containing `sst.config`                  |
| `operation`                  | false    | `auto`  | `auto`, `deploy`, or `remove`                      |
| `comment-enabled`            | false    | `true`  | Post a preview URL comment after deployment        |
| `cleanup-on-deploy-failure`  | false    | `true`  | Remove the preview stage after a failed deployment |
| `remove-max-attempts`        | false    | `3`     | Maximum removal attempts                           |
| `remove-retry-delay-seconds` | false    | `30`    | Delay between removal attempts                     |
| `verify-removal`             | false    | `auto`  | `auto`, `true`, or `false`                         |

With `operation: auto`, a `closed` pull-request event removes the stage and all
other pull-request actions deploy it. The stage is always derived from
`github.event.pull_request.number`; arbitrary stage names are not accepted.

`verify-removal: auto` verifies state when the installed SST version supports
reliable state deletion and falls back with a warning for older versions.
Use `true` for strict verification with SST 4.13.0 or newer.

## Outputs

| Name        | Description                                                |
| ----------- | ---------------------------------------------------------- |
| `url`       | Deployed CloudFront URL, when one is present in SST output |
| `operation` | Resolved `deploy` or `remove` operation                    |
| `stage`     | The `pr-{number}` SST stage used by the action             |

## Prerequisites

1. AWS credentials are configured before this action runs.
2. Node.js and the project package manager are available.
3. Project dependencies, including a locally pinned SST version, are installed.
4. The working directory contains a valid SST project.

## License

MIT
