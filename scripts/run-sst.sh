#!/usr/bin/env bash

set -euo pipefail

readonly operation_input="${INPUT_OPERATION:-auto}"
readonly input_pr_number="${INPUT_PR_NUMBER:-}"
readonly cleanup_on_deploy_failure="${INPUT_CLEANUP_ON_DEPLOY_FAILURE:-true}"
readonly remove_max_attempts="${INPUT_REMOVE_MAX_ATTEMPTS:-3}"
readonly remove_retry_delay_seconds="${INPUT_REMOVE_RETRY_DELAY_SECONDS:-30}"
readonly verify_removal="${INPUT_VERIFY_REMOVAL:-auto}"
readonly event_action="${PR_EVENT_ACTION:-}"
readonly event_pr_number="${PR_NUMBER:-}"

error() {
  echo "::error::$*" >&2
}

validate_boolean() {
  local value="$1"
  local input_name="$2"

  if [[ "$value" != "true" && "$value" != "false" ]]; then
    error "${input_name} must be either true or false"
    exit 1
  fi
}

validate_boolean "$cleanup_on_deploy_failure" "cleanup-on-deploy-failure"

if [[ "$verify_removal" != "auto" && "$verify_removal" != "true" && "$verify_removal" != "false" ]]; then
  error "verify-removal must be auto, true, or false"
  exit 1
fi

if [[ ! "$remove_max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  error "remove-max-attempts must be a positive integer"
  exit 1
fi

if [[ ! "$remove_retry_delay_seconds" =~ ^[0-9]+$ ]]; then
  error "remove-retry-delay-seconds must be a non-negative integer"
  exit 1
fi

validate_pr_number() {
  local value="$1"
  local source="$2"

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    error "${source} must be a positive integer without leading zeros"
    exit 1
  fi
}

if [[ -n "$input_pr_number" ]]; then
  validate_pr_number "$input_pr_number" "pr-number"
fi

if [[ -n "$event_pr_number" ]]; then
  validate_pr_number "$event_pr_number" "github.event.pull_request.number"
fi

if [[ -n "$input_pr_number" && -n "$event_pr_number" && "$input_pr_number" != "$event_pr_number" ]]; then
  error "pr-number does not match github.event.pull_request.number"
  exit 1
fi

readonly pr_number="${input_pr_number:-$event_pr_number}"
if [[ -z "$pr_number" ]]; then
  error "This action requires pr-number or github.event.pull_request.number"
  exit 1
fi

case "$operation_input" in
  auto)
    if [[ "$event_action" == "closed" ]]; then
      readonly operation="remove"
    else
      readonly operation="deploy"
    fi
    ;;
  deploy | remove)
    readonly operation="$operation_input"
    ;;
  *)
    error "operation must be auto, deploy, or remove"
    exit 1
    ;;
esac

readonly stage="pr-${pr_number}"
{
  echo "operation=${operation}"
  echo "stage=${stage}"
} >>"$GITHUB_OUTPUT"

verify_stage_removed() {
  local state_list
  local normalized_state_list

  if ! state_list="$(npx sst state list --stage "$stage" 2>&1)"; then
    printf '%s\n' "$state_list" >&2
    error "Unable to verify whether ${stage} is still present in SST state"
    return 2
  fi

  printf '%s\n' "$state_list"
  normalized_state_list="$(
    sed -E $'s/\x1b\\[[0-9;?]*[ -\\/]*[@-~]//g' <<<"$state_list" |
      sed -E \
        -e 's/^[[:space:]]*Stages:[[:space:]]*//' \
        -e 's/^[[:space:]]+//' \
        -e 's/[[:space:]]+$//'
  )"

  if grep -Fqx -- "$stage" <<<"$normalized_state_list"; then
    error "${stage} is still present in SST state"
    return 1
  fi
}

sst_supports_state_removal() {
  local version_output
  local version
  local major
  local minor

  if ! version_output="$(npx sst version 2>&1)"; then
    printf '%s\n' "$version_output" >&2
    return 2
  fi

  version="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+' <<<"$version_output" | tail -1 || true)"
  if [[ -z "$version" ]]; then
    printf '%s\n' "$version_output" >&2
    return 2
  fi

  IFS=. read -r major minor <<<"${version%.*}"
  if ((major > 4 || (major == 4 && minor >= 13))); then
    return 0
  fi

  return 1
}

remove_stage() {
  local attempt
  local state_removal_support
  local verification_mode="$verify_removal"

  if [[ "$verification_mode" == "auto" ]]; then
    if sst_supports_state_removal; then
      verification_mode="true"
    else
      state_removal_support=$?
      if [[ "$state_removal_support" -eq 1 ]]; then
        echo "::warning::Skipping state verification because SST state removal requires SST 4.13.0 or newer"
        verification_mode="false"
      else
        echo "::warning::Unable to determine the SST version; enforcing state verification"
        verification_mode="true"
      fi
    fi
  fi

  for ((attempt = 1; attempt <= remove_max_attempts; attempt++)); do
    echo "Removing ${stage} (attempt ${attempt}/${remove_max_attempts})"

    if npx sst remove --stage "$stage"; then
      if [[ "$verification_mode" == "false" ]]; then
        return 0
      fi

      if verify_stage_removed; then
        return 0
      fi
    fi

    if ((attempt < remove_max_attempts)); then
      sleep "$remove_retry_delay_seconds"
    fi
  done

  error "Failed to remove ${stage} after ${remove_max_attempts} attempts"
  return 1
}

if [[ "$operation" == "remove" ]]; then
  remove_stage
  exit 0
fi

deploy_log="$(mktemp)"
cleanup_deploy_log() {
  rm -f -- "$deploy_log"
}
trap cleanup_deploy_log EXIT

set +e
npx sst deploy --stage "$stage" 2>&1 | tee "$deploy_log"
deploy_pipeline_status=("${PIPESTATUS[@]}")
set -e

readonly deploy_status="${deploy_pipeline_status[0]}"
readonly tee_status="${deploy_pipeline_status[1]}"

if ((deploy_status != 0)); then
  error "SST deploy failed for ${stage}"

  if [[ "$cleanup_on_deploy_failure" == "true" ]]; then
    echo "Deploy failed; removing partially created resources for ${stage}"
    if ! remove_stage; then
      error "Deploy and rollback both failed for ${stage}"
    fi
  fi

  exit 1
fi

if ((tee_status != 0)); then
  echo "::warning::SST deploy succeeded, but its output could not be captured completely"
fi

url="$(grep -oE 'https://[a-z0-9]+\.cloudfront\.net' "$deploy_log" | head -1 || true)"
echo "url=${url}" >>"$GITHUB_OUTPUT"

if [[ -z "$url" ]]; then
  echo "::warning::Deploy succeeded, but no CloudFront URL was found in SST output"
fi
