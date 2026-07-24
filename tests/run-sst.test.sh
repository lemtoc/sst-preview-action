#!/usr/bin/env bash

set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly script_under_test="${repository_root}/scripts/run-sst.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"

  grep -Fq "$expected" "$file" || fail "${file} does not contain: ${expected}"
}

run_action() {
  local temp_dir="$1"
  shift

  env \
    PATH="${temp_dir}/bin:${PATH}" \
    GITHUB_OUTPUT="${temp_dir}/github-output" \
    INPUT_CLEANUP_ON_DEPLOY_FAILURE="${INPUT_CLEANUP_ON_DEPLOY_FAILURE:-true}" \
    INPUT_OPERATION="${INPUT_OPERATION:-auto}" \
    INPUT_PR_NUMBER="${INPUT_PR_NUMBER-}" \
    INPUT_REMOVE_MAX_ATTEMPTS="${INPUT_REMOVE_MAX_ATTEMPTS:-3}" \
    INPUT_REMOVE_RETRY_DELAY_SECONDS="0" \
    INPUT_VERIFY_REMOVAL="${INPUT_VERIFY_REMOVAL:-auto}" \
    PR_EVENT_ACTION="${PR_EVENT_ACTION:-opened}" \
    PR_NUMBER="${PR_NUMBER-123}" \
    TEST_CALL_LOG="${temp_dir}/calls" \
    TEST_COUNTER_FILE="${temp_dir}/counter" \
    TEST_STREAM_RELEASE_FILE="${temp_dir}/stream-release" \
    TEST_SCENARIO="$1" \
    bash "$script_under_test"
}

make_temp_dir() {
  local temp_dir
  temp_dir="$(mktemp -d)"
  mkdir -p "${temp_dir}/bin"
  touch "${temp_dir}/calls" "${temp_dir}/github-output"

  cat >"${temp_dir}/bin/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

echo "$*" >>"$TEST_CALL_LOG"

case "${TEST_SCENARIO}:$1:$2" in
  deploy-success:sst:deploy)
    echo "✓ Complete"
    echo "https://abc123.cloudfront.net"
    ;;
  deploy-failure:sst:deploy)
    echo "deploy failed" >&2
    exit 1
    ;;
  deploy-stream:sst:deploy)
    echo "deploy started"
    while [[ ! -e "$TEST_STREAM_RELEASE_FILE" ]]; do
      sleep 0.01
    done
    echo "https://streamed.cloudfront.net"
    ;;
  deploy-failure:sst:remove | deploy-failure:sst:state)
    echo "Stages: dev"
    ;;
  remove-retry:sst:remove)
    count="$(cat "$TEST_COUNTER_FILE" 2>/dev/null || echo 0)"
    count="$((count + 1))"
    echo "$count" >"$TEST_COUNTER_FILE"
    if [[ "$count" -eq 1 ]]; then
      exit 1
    fi
    ;;
  remove-retry:sst:state)
    echo "Stages: dev"
    ;;
  verify-retry:sst:remove)
    ;;
  verify-retry:sst:state)
    count="$(cat "$TEST_COUNTER_FILE" 2>/dev/null || echo 0)"
    count="$((count + 1))"
    echo "$count" >"$TEST_COUNTER_FILE"
    if [[ "$count" -eq 1 ]]; then
      printf 'Stages: dev\n            pr-123\n'
    else
      echo "Stages: dev"
    fi
    ;;
  auto-remove:sst:remove | auto-remove:sst:state)
    echo "Stages: dev"
    ;;
  state-unavailable:sst:remove)
    ;;
  state-unavailable:sst:state)
    echo "Unknown command: state" >&2
    exit 1
    ;;
  not-deployed:sst:remove)
    ;;
  not-deployed:sst:state)
    printf '\033[90mStages:\033[0m\n  pr-123 (not deployed)\n'
    ;;
  old-sst:sst:remove)
    ;;
  old-sst:sst:state)
    printf 'Stages:\n  pr-123\n'
    ;;
  old-sst:sst:version)
    echo "4.12.9"
    ;;
  unknown-version:sst:remove)
    ;;
  unknown-version:sst:state)
    echo "backend unavailable" >&2
    exit 1
    ;;
  unknown-version:sst:version)
    echo "development build"
    ;;
  *:sst:version)
    echo "4.17.1"
    ;;
  *)
    echo "Unexpected invocation: ${TEST_SCENARIO}:$*" >&2
    exit 99
    ;;
esac
EOF
  chmod +x "${temp_dir}/bin/npx"
  echo "$temp_dir"
}

test_deploy_success() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  INPUT_OPERATION=deploy run_action "$temp_dir" deploy-success

  assert_contains "${temp_dir}/github-output" "operation=deploy"
  assert_contains "${temp_dir}/github-output" "stage=pr-123"
  assert_contains "${temp_dir}/github-output" "url=https://abc123.cloudfront.net"
  assert_contains "${temp_dir}/calls" "sst deploy --stage pr-123"
}

test_deploy_failure_rolls_back() {
  local temp_dir
  local output_file
  temp_dir="$(make_temp_dir)"
  output_file="${temp_dir}/output"

  if INPUT_OPERATION=deploy run_action "$temp_dir" deploy-failure >"$output_file" 2>&1; then
    fail "deploy failure unexpectedly succeeded"
  fi

  assert_contains "${temp_dir}/calls" "sst deploy --stage pr-123"
  assert_contains "${temp_dir}/calls" "sst remove --stage pr-123"
  assert_contains "${temp_dir}/calls" "sst state list"
  [[ "$(grep -Fxc "deploy failed" "$output_file")" -eq 1 ]] ||
    fail "deploy failure output was not streamed exactly once"
}

test_deploy_output_is_streamed() {
  local action_pid
  local output_file
  local stream_observed="false"
  local temp_dir
  temp_dir="$(make_temp_dir)"
  output_file="${temp_dir}/output"

  INPUT_OPERATION=deploy run_action "$temp_dir" deploy-stream >"$output_file" 2>&1 &
  action_pid=$!

  for _ in {1..200}; do
    if grep -Fq "deploy started" "$output_file"; then
      stream_observed="true"
      break
    fi
    sleep 0.01
  done

  touch "${temp_dir}/stream-release"
  wait "$action_pid"

  [[ "$stream_observed" == "true" ]] ||
    fail "deploy output was not visible before deployment completed"
  assert_contains "${temp_dir}/github-output" "url=https://streamed.cloudfront.net"
}

test_remove_retries() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  INPUT_OPERATION=remove run_action "$temp_dir" remove-retry

  [[ "$(grep -Fc "sst remove --stage pr-123" "${temp_dir}/calls")" -eq 2 ]] ||
    fail "remove was not attempted twice"
}

test_verification_retries() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  INPUT_OPERATION=remove run_action "$temp_dir" verify-retry

  [[ "$(grep -Fc "sst remove --stage pr-123" "${temp_dir}/calls")" -eq 2 ]] ||
    fail "remove was not retried after failed verification"
}

test_auto_closed_event_removes() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  INPUT_OPERATION=auto PR_EVENT_ACTION=closed run_action "$temp_dir" auto-remove

  assert_contains "${temp_dir}/github-output" "operation=remove"
  assert_contains "${temp_dir}/calls" "sst remove --stage pr-123"
}

test_auto_verification_rejects_unavailable_state_on_modern_sst() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  if INPUT_OPERATION=remove INPUT_VERIFY_REMOVAL=auto run_action "$temp_dir" state-unavailable; then
    fail "automatic verification unexpectedly ignored a state error"
  fi

  [[ "$(grep -Fc "sst remove --stage pr-123" "${temp_dir}/calls")" -eq 3 ]] ||
    fail "automatic verification did not retry removal"
}

test_strict_verification_rejects_unavailable_state() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  if INPUT_OPERATION=remove INPUT_VERIFY_REMOVAL=true run_action "$temp_dir" state-unavailable; then
    fail "strict verification unexpectedly succeeded"
  fi

  [[ "$(grep -Fc "sst remove --stage pr-123" "${temp_dir}/calls")" -eq 3 ]] ||
    fail "strict verification did not retry removal"
}

test_not_deployed_state_is_treated_as_removed() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  INPUT_OPERATION=remove SST_STAGE=pr-123 run_action "$temp_dir" not-deployed

  [[ "$(grep -Fc "sst remove --stage pr-123" "${temp_dir}/calls")" -eq 1 ]] ||
    fail "remove was retried for a stage marked as not deployed"
  assert_contains "${temp_dir}/calls" "sst state list --stage pr-123"
}

test_auto_verification_supports_old_state_cleanup() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  INPUT_OPERATION=remove INPUT_VERIFY_REMOVAL=auto run_action "$temp_dir" old-sst

  [[ "$(grep -Fc "sst remove --stage pr-123" "${temp_dir}/calls")" -eq 1 ]] ||
    fail "remove was retried for an SST version that retains state"
  assert_contains "${temp_dir}/calls" "sst version"
}

test_unknown_version_enforces_verification() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  if INPUT_OPERATION=remove INPUT_VERIFY_REMOVAL=auto run_action "$temp_dir" unknown-version; then
    fail "an unknown SST version unexpectedly skipped verification"
  fi

  [[ "$(grep -Fc "sst remove --stage pr-123" "${temp_dir}/calls")" -eq 3 ]] ||
    fail "an unknown SST version did not retry removal"
}

test_invalid_pr_number_is_rejected() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  if PR_NUMBER='123;echo unsafe' run_action "$temp_dir" auto-remove; then
    fail "invalid PR number unexpectedly succeeded"
  fi

  [[ ! -s "${temp_dir}/calls" ]] || fail "npx was called for an invalid PR number"
}

test_explicit_pr_number_supports_manual_remove() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  INPUT_OPERATION=remove INPUT_PR_NUMBER=456 PR_NUMBER= run_action "$temp_dir" auto-remove

  assert_contains "${temp_dir}/github-output" "stage=pr-456"
  assert_contains "${temp_dir}/calls" "sst remove --stage pr-456"
}

test_matching_explicit_and_event_pr_numbers_are_allowed() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  INPUT_OPERATION=remove INPUT_PR_NUMBER=123 PR_NUMBER=123 run_action "$temp_dir" auto-remove

  assert_contains "${temp_dir}/github-output" "stage=pr-123"
  assert_contains "${temp_dir}/calls" "sst remove --stage pr-123"
}

test_mismatched_explicit_and_event_pr_numbers_are_rejected() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  if INPUT_OPERATION=remove INPUT_PR_NUMBER=456 PR_NUMBER=123 run_action "$temp_dir" auto-remove; then
    fail "mismatched PR numbers unexpectedly succeeded"
  fi

  [[ ! -s "${temp_dir}/calls" ]] || fail "npx was called for mismatched PR numbers"
}

test_noncanonical_pr_numbers_are_rejected() {
  local invalid_pr_number

  for invalid_pr_number in 0 001 '123;echo unsafe'; do
    local temp_dir
    temp_dir="$(make_temp_dir)"

    if INPUT_OPERATION=remove INPUT_PR_NUMBER="$invalid_pr_number" PR_NUMBER= run_action "$temp_dir" auto-remove; then
      fail "invalid explicit PR number unexpectedly succeeded: ${invalid_pr_number}"
    fi

    [[ ! -s "${temp_dir}/calls" ]] ||
      fail "npx was called for invalid explicit PR number: ${invalid_pr_number}"
  done
}

test_missing_pr_number_is_rejected() {
  local temp_dir
  temp_dir="$(make_temp_dir)"

  if INPUT_OPERATION=remove INPUT_PR_NUMBER= PR_NUMBER= run_action "$temp_dir" auto-remove; then
    fail "missing PR number unexpectedly succeeded"
  fi

  [[ ! -s "${temp_dir}/calls" ]] || fail "npx was called without a PR number"
}

test_deploy_success
test_deploy_failure_rolls_back
test_deploy_output_is_streamed
test_remove_retries
test_verification_retries
test_auto_closed_event_removes
test_auto_verification_rejects_unavailable_state_on_modern_sst
test_strict_verification_rejects_unavailable_state
test_not_deployed_state_is_treated_as_removed
test_auto_verification_supports_old_state_cleanup
test_unknown_version_enforces_verification
test_invalid_pr_number_is_rejected
test_explicit_pr_number_supports_manual_remove
test_matching_explicit_and_event_pr_numbers_are_allowed
test_mismatched_explicit_and_event_pr_numbers_are_rejected
test_noncanonical_pr_numbers_are_rejected
test_missing_pr_number_is_rejected

echo "All run-sst tests passed"
