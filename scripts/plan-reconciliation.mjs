#!/usr/bin/env node

import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiUrl = process.env.RECONCILE_GITHUB_API_URL;
const candidatesFile = process.env.RECONCILE_CANDIDATES_FILE;
const githubOutput = process.env.GITHUB_OUTPUT;
const repository = process.env.RECONCILE_GITHUB_REPOSITORY;
const token = process.env.RECONCILE_GITHUB_TOKEN;
const runnerTemp = process.env.RUNNER_TEMP || tmpdir();
const gracePeriodMilliseconds = 60 * 60 * 1000;
const maxRemovals = 20;

const fail = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.replace(/[\r\n]+/gu, " ");
  process.stderr.write(`::error::${normalizedMessage}\n`);
  process.exitCode = 1;
};

const getPullRequestState = async ({
  baseUrl,
  owner,
  name,
  pullRequestNumber,
}) => {
  const endpoint = new URL(
    `repos/${owner}/${name}/pulls/${pullRequestNumber}`,
    baseUrl,
  );
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "sst-preview-action",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub returned HTTP ${response.status} for pull request ${pullRequestNumber}`,
    );
  }

  const pullRequest = await response.json();
  if (String(pullRequest?.number) !== pullRequestNumber) {
    throw new Error("GitHub returned a mismatched pull request");
  }

  if (pullRequest.state === "open") {
    return "open";
  }

  if (pullRequest.state !== "closed") {
    throw new Error("GitHub returned an unknown pull request state");
  }

  const closedAt = Date.parse(pullRequest.closed_at ?? "");
  if (!Number.isFinite(closedAt)) {
    throw new Error(
      "GitHub returned a closed pull request without a valid closed_at",
    );
  }

  return Date.now() - closedAt >= gracePeriodMilliseconds ? "closed" : "grace";
};

const main = async () => {
  if (
    !apiUrl ||
    !candidatesFile ||
    !githubOutput ||
    !repository ||
    !token
  ) {
    throw new Error(
      "GitHub API URL, repository, token, candidates, and output are required for reconciliation",
    );
  }

  const repositoryParts = repository.split("/");
  if (
    repositoryParts.length !== 2 ||
    repositoryParts.some(
      (part) => !/^[A-Za-z0-9_.-]+$/u.test(part),
    )
  ) {
    throw new Error("GitHub repository must use the owner/name format");
  }

  const baseUrl = new URL(apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
    throw new Error("GitHub API URL must use HTTP or HTTPS");
  }

  const candidates = (await readFile(candidatesFile, "utf8"))
    .split(/\r?\n/gu)
    .filter((candidate) => candidate !== "");

  if (
    candidates.some(
      (candidate) => !/^pr-[1-9][0-9]*$/u.test(candidate),
    )
  ) {
    throw new Error(
      "Reconciliation candidates must use canonical pr-{number} stages",
    );
  }

  if (new Set(candidates).size !== candidates.length) {
    throw new Error("Reconciliation candidates must not contain duplicates");
  }

  const [owner, name] = repositoryParts.map(encodeURIComponent);
  const stagesToRemove = [];

  for (const candidate of candidates) {
    const pullRequestNumber = candidate.slice(3);
    const state = await getPullRequestState({
      baseUrl,
      name,
      owner,
      pullRequestNumber,
    });

    if (state === "closed") {
      stagesToRemove.push(candidate);
      process.stdout.write(
        `Marking ${candidate} as eligible; pull request is closed\n`,
      );
    } else {
      process.stdout.write(`Keeping ${candidate}; pull request is ${state}\n`);
    }
  }

  if (stagesToRemove.length > maxRemovals) {
    throw new Error(
      `Refusing to remove ${stagesToRemove.length} stages; maximum per reconciliation is ${maxRemovals}`,
    );
  }

  const confirmedStagesToRemove = [];
  for (const candidate of stagesToRemove) {
    const pullRequestNumber = candidate.slice(3);
    const state = await getPullRequestState({
      baseUrl,
      name,
      owner,
      pullRequestNumber,
    });

    if (state === "closed") {
      confirmedStagesToRemove.push(candidate);
      process.stdout.write(
        `Confirmed removal for ${candidate}; pull request is still closed\n`,
      );
    } else {
      process.stdout.write(
        `Keeping ${candidate}; pull request changed to ${state}\n`,
      );
    }
  }

  const planDirectory = await mkdtemp(
    join(runnerTemp, "sst-preview-reconcile-"),
  );
  const planFile = join(planDirectory, "stages");
  const planContents =
    confirmedStagesToRemove.length === 0
      ? ""
      : `${confirmedStagesToRemove.join("\n")}\n`;
  await writeFile(planFile, planContents, { mode: 0o600 });
  await appendFile(githubOutput, `plan_file=${planFile}\n`);
};

try {
  await main();
} catch (error) {
  fail(error);
}
