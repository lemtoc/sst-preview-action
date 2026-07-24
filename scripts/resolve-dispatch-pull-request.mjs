#!/usr/bin/env node

import { appendFile } from "node:fs/promises";

const apiUrl = process.env.DISPATCH_GITHUB_API_URL;
const defaultBranch = process.env.DISPATCH_GITHUB_DEFAULT_BRANCH;
const githubOutput = process.env.GITHUB_OUTPUT;
const inputPullRequestNumber = process.env.DISPATCH_INPUT_PR_NUMBER ?? "";
const operationInput = process.env.DISPATCH_OPERATION;
const refName = process.env.DISPATCH_GITHUB_REF_NAME;
const refType = process.env.DISPATCH_GITHUB_REF_TYPE;
const repository = process.env.DISPATCH_GITHUB_REPOSITORY;
const targetBranch = process.env.DISPATCH_TARGET_BRANCH ?? "";
const token = process.env.DISPATCH_GITHUB_TOKEN;

const fail = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message
    .replace(/%/gu, "%25")
    .replace(/\r/gu, "%0D")
    .replace(/\n/gu, "%0A");
  process.stderr.write(`::error::${normalizedMessage}\n`);
  process.exitCode = 1;
};

const main = async () => {
  if (
    !apiUrl ||
    !defaultBranch ||
    !githubOutput ||
    !operationInput ||
    !refName ||
    !refType ||
    !repository ||
    !token
  ) {
    throw new Error(
      "GitHub API URL, default branch, output, operation, ref, repository, and token are required",
    );
  }

  const operation = operationInput === "auto" ? "deploy" : operationInput;
  if (operation !== "deploy" && operation !== "remove") {
    throw new Error("Dispatch pull request resolution supports deploy or remove");
  }

  if (refType !== "branch") {
    throw new Error("Manual deploy and remove require a selected branch");
  }

  if (operation === "remove" && refName !== defaultBranch) {
    throw new Error("Manual remove must run from the default branch");
  }

  if (operation === "deploy" && targetBranch !== "") {
    throw new Error("target-branch is supported only for manual remove");
  }

  const repositoryParts = repository.split("/");
  if (
    repositoryParts.length !== 2 ||
    repositoryParts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))
  ) {
    throw new Error("GitHub repository must use the owner/name format");
  }

  if (/[\u0000\r\n]/u.test(refName) || /[\u0000\r\n]/u.test(targetBranch)) {
    throw new Error("GitHub branch name contains unsupported characters");
  }

  const pullRequestBranch = operation === "deploy" ? refName : targetBranch;
  if (pullRequestBranch === "" && inputPullRequestNumber === "") {
    throw new Error("Manual remove requires target-branch or pr-number");
  }

  const baseUrl = new URL(apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
    throw new Error("GitHub API URL must use HTTP or HTTPS");
  }

  const [owner, name] = repositoryParts;
  const endpointPrefix =
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`;

  const requestGitHub = async (endpoint) => {
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
      const target =
        pullRequestBranch === ""
          ? `pull request ${inputPullRequestNumber}`
          : `branch ${pullRequestBranch}`;
      throw new Error(
        `GitHub returned HTTP ${response.status} while resolving ${target}`,
      );
    }

    return response;
  };

  const writeResolvedPullRequest = async ({ number, state }) => {
    if (operation === "remove" && state === "open") {
      process.stdout.write(
        `::warning::Removing preview for open pull request ${number}; a later pull request update can deploy it again\n`,
      );
    }
    process.stdout.write(`Resolved pull request ${number} for ${operation}\n`);
    await appendFile(
      githubOutput,
      `operation=${operation}\npr_number=${number}\nskip=false\n`,
    );
  };

  if (inputPullRequestNumber !== "") {
    if (!/^[1-9][0-9]*$/u.test(inputPullRequestNumber)) {
      throw new Error(
        "pr-number must be a positive integer without leading zeros",
      );
    }

    const endpoint = new URL(
      `${endpointPrefix}/${inputPullRequestNumber}`,
      baseUrl,
    );
    const response = await requestGitHub(endpoint);
    const pullRequest = await response.json();
    const expectedNumber = Number(inputPullRequestNumber);

    if (
      !Number.isSafeInteger(pullRequest?.number) ||
      pullRequest.number !== expectedNumber ||
      (pullRequest?.state !== "open" && pullRequest?.state !== "closed") ||
      pullRequest?.head?.repo?.full_name !== repository ||
      typeof pullRequest?.head?.ref !== "string"
    ) {
      throw new Error("GitHub returned an unexpected pull request");
    }

    if (operation === "deploy") {
      if (pullRequest.state !== "open") {
        throw new Error(
          `Pull request ${inputPullRequestNumber} is not open for deploy`,
        );
      }
      if (pullRequest.head.ref !== pullRequestBranch) {
        throw new Error(
          `pr-number ${inputPullRequestNumber} does not match selected branch ${refName}`,
        );
      }
    }

    if (
      operation === "remove" &&
      pullRequestBranch !== "" &&
      pullRequest.head.ref !== pullRequestBranch
    ) {
      throw new Error(
        `pr-number ${inputPullRequestNumber} does not match target branch ${pullRequestBranch}`,
      );
    }

    await writeResolvedPullRequest(pullRequest);
    return;
  }

  const endpoint = new URL(endpointPrefix, baseUrl);
  endpoint.searchParams.set("head", `${owner}:${pullRequestBranch}`);
  endpoint.searchParams.set("state", operation === "deploy" ? "open" : "all");
  endpoint.searchParams.set("per_page", "100");

  const response = await requestGitHub(endpoint);

  if (/rel="next"/u.test(response.headers.get("link") ?? "")) {
    throw new Error(
      `Branch ${pullRequestBranch} has too many pull request matches; provide pr-number`,
    );
  }

  const pullRequests = await response.json();
  if (!Array.isArray(pullRequests)) {
    throw new Error("GitHub returned an invalid pull request list");
  }

  const matches = pullRequests.filter((pullRequest) => {
    const validNumber =
      Number.isSafeInteger(pullRequest?.number) && pullRequest.number > 0;
    const validState =
      pullRequest?.state === "open" ||
      (operation === "remove" && pullRequest?.state === "closed");

    return (
      validNumber &&
      validState &&
      pullRequest?.head?.ref === pullRequestBranch &&
      pullRequest?.head?.repo?.full_name === repository
    );
  });

  if (matches.length !== pullRequests.length) {
    throw new Error("GitHub returned an unexpected pull request match");
  }

  if (matches.length === 0) {
    if (operation === "deploy") {
      process.stdout.write(
        `Skipping deploy; branch ${pullRequestBranch} has no open pull request\n`,
      );
      await appendFile(githubOutput, "operation=deploy\nskip=true\n");
      return;
    }

    throw new Error(
      `Branch ${pullRequestBranch} has no pull request; provide pr-number or run reconcile`,
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `Branch ${pullRequestBranch} matches multiple pull requests; provide pr-number`,
    );
  }

  await writeResolvedPullRequest(matches[0]);
};

try {
  await main();
} catch (error) {
  fail(error);
}
