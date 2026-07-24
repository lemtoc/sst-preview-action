#!/usr/bin/env bash

set -euo pipefail

readonly plan_file="${RECONCILE_PLAN_FILE:-}"
readonly max_removals=20
readonly script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

error() {
  echo "::error::$*" >&2
}

if [[ -z "$plan_file" || ! -f "$plan_file" ]]; then
  error "A reconciliation plan file is required"
  exit 1
fi

stages=()
while IFS= read -r stage || [[ -n "$stage" ]]; do
  stages+=("$stage")
done <"$plan_file"

if ((${#stages[@]} > max_removals)); then
  error "Refusing to remove ${#stages[@]} stages; maximum per reconciliation is ${max_removals}"
  exit 1
fi

seen_stages=()
for stage in "${stages[@]}"; do
  if [[ ! "$stage" =~ ^pr-[1-9][0-9]*$ ]]; then
    error "Refusing a reconciliation plan with a noncanonical stage: ${stage}"
    exit 1
  fi

  for seen_stage in "${seen_stages[@]}"; do
    if [[ "$seen_stage" == "$stage" ]]; then
      error "Refusing a reconciliation plan with a duplicate stage: ${stage}"
      exit 1
    fi
  done
  seen_stages+=("$stage")
done

if ((${#stages[@]} == 0)); then
  echo "No stale pull-request stages to remove"
  exit 0
fi

failed="false"
for stage in "${stages[@]}"; do
  echo "Reconciling ${stage}; pull request is closed"
  if ! INPUT_OPERATION=remove \
    INPUT_PR_NUMBER="${stage#pr-}" \
    PR_EVENT_ACTION="" \
    PR_EVENT_NAME="" \
    PR_NUMBER="" \
    "${script_directory}/run-sst.sh"; then
    failed="true"
  fi
done

if [[ "$failed" == "true" ]]; then
  error "One or more stale pull-request stages could not be removed"
  exit 1
fi
