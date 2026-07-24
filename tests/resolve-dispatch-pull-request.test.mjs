import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(
  new URL("../scripts/resolve-dispatch-pull-request.mjs", import.meta.url),
);

const pullRequest = ({
  number = 123,
  ref = "feature/preview",
  repository = "owner/repository",
  state = "open",
} = {}) => ({
  head: {
    ref,
    repo: {
      full_name: repository,
    },
  },
  number,
  state,
});

const runResolver = async ({
  defaultBranch = "main",
  inputPullRequestNumber = "",
  operation = "deploy",
  refName = "feature/preview",
  refType = "branch",
  responseFor = () => ({
    body: [pullRequest()],
    headers: {},
    status: 200,
  }),
  targetBranch = "",
  token = "test-token",
} = {}) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "sst-preview-action-dispatch-test-"),
  );
  const githubOutput = join(temporaryDirectory, "github-output");
  await writeFile(githubOutput, "");

  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      url: request.url,
    });
    const configuredResponse = responseFor(request.url ?? "");
    response.writeHead(configuredResponse.status, {
      "Content-Type": "application/json",
      ...configuredResponse.headers,
    });
    response.end(JSON.stringify(configuredResponse.body));
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        DISPATCH_GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        DISPATCH_GITHUB_DEFAULT_BRANCH: defaultBranch,
        DISPATCH_GITHUB_REF_NAME: refName,
        DISPATCH_GITHUB_REF_TYPE: refType,
        DISPATCH_GITHUB_REPOSITORY: "owner/repository",
        DISPATCH_GITHUB_TOKEN: token,
        DISPATCH_INPUT_PR_NUMBER: inputPullRequestNumber,
        DISPATCH_OPERATION: operation,
        DISPATCH_TARGET_BRANCH: targetBranch,
        GITHUB_OUTPUT: githubOutput,
      },
    });
    const stderr = [];
    const stdout = [];

    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.on("close", (code) => {
      resolve({
        code,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  const output = await readFile(githubOutput, "utf8");
  await rm(temporaryDirectory, { force: true, recursive: true });

  return { ...result, output, requests };
};

test("resolves a selected branch to its open pull request for deploy", async () => {
  const result = await runResolver();

  assert.equal(result.code, 0);
  assert.equal(
    result.output,
    "operation=deploy\npr_number=123\nskip=false\n",
  );
  assert.match(result.stdout, /pull request 123 for deploy/u);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].authorization, "Bearer test-token");

  const requestUrl = new URL(
    result.requests[0].url ?? "",
    "http://localhost",
  );
  assert.equal(requestUrl.pathname, "/repos/owner/repository/pulls");
  assert.equal(requestUrl.searchParams.get("head"), "owner:feature/preview");
  assert.equal(requestUrl.searchParams.get("state"), "open");
  assert.equal(requestUrl.searchParams.get("per_page"), "100");
});

test("skips deploy when the selected branch has no open pull request", async () => {
  const result = await runResolver({
    responseFor: () => ({ body: [], headers: {}, status: 200 }),
  });

  assert.equal(result.code, 0);
  assert.equal(result.output, "operation=deploy\nskip=true\n");
  assert.match(result.stdout, /Skipping deploy/u);
});

test("resolves a target branch for remove regardless of pull request state", async () => {
  for (const state of ["open", "closed"]) {
    const result = await runResolver({
      operation: "remove",
      refName: "main",
      responseFor: () => ({
        body: [pullRequest({ state })],
        headers: {},
        status: 200,
      }),
      targetBranch: "feature/preview",
    });

    assert.equal(result.code, 0);
    assert.equal(
      result.output,
      "operation=remove\npr_number=123\nskip=false\n",
    );
    if (state === "open") {
      assert.match(result.stdout, /preview for open pull request 123/u);
    } else {
      assert.doesNotMatch(result.stdout, /::warning::/u);
    }
    const requestUrl = new URL(
      result.requests[0].url ?? "",
      "http://localhost",
    );
    assert.equal(requestUrl.searchParams.get("head"), "owner:feature/preview");
    assert.equal(requestUrl.searchParams.get("state"), "all");
  }
});

test("fails remove when the target branch has no pull request", async () => {
  const result = await runResolver({
    operation: "remove",
    refName: "main",
    responseFor: () => ({ body: [], headers: {}, status: 200 }),
    targetBranch: "feature/preview",
  });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /provide pr-number or run reconcile/u);
});

test("fails closed when a branch matches multiple pull requests", async () => {
  const result = await runResolver({
    operation: "remove",
    refName: "main",
    responseFor: () => ({
      body: [
        pullRequest({ number: 123, state: "closed" }),
        pullRequest({ number: 456, state: "open" }),
      ],
      headers: {},
      status: 200,
    }),
    targetBranch: "feature/preview",
  });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /multiple pull requests/u);
});

test("uses an explicit pull request number to disambiguate a branch", async () => {
  const result = await runResolver({
    inputPullRequestNumber: "456",
    operation: "remove",
    refName: "main",
    responseFor: (url) => {
      assert.equal(url, "/repos/owner/repository/pulls/456");
      return {
        body: pullRequest({ number: 456, state: "closed" }),
        headers: {},
        status: 200,
      };
    },
    targetBranch: "feature/preview",
  });

  assert.equal(result.code, 0);
  assert.equal(
    result.output,
    "operation=remove\npr_number=456\nskip=false\n",
  );
  assert.equal(result.requests.length, 1);
});

test("rejects an explicit pull request that does not match a selected feature branch", async () => {
  const result = await runResolver({
    inputPullRequestNumber: "456",
    operation: "remove",
    refName: "main",
    responseFor: () => ({
      body: pullRequest({
        number: 456,
        ref: "another-branch",
        state: "closed",
      }),
      headers: {},
      status: 200,
    }),
    targetBranch: "feature/preview",
  });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /does not match target branch/u);
});

test("allows default-branch cleanup with an explicit pull request number", async () => {
  const result = await runResolver({
    inputPullRequestNumber: "456",
    operation: "remove",
    refName: "main",
    responseFor: () => ({
      body: pullRequest({
        number: 456,
        ref: "deleted-feature",
        state: "closed",
      }),
      headers: {},
      status: 200,
    }),
  });

  assert.equal(result.code, 0);
  assert.equal(
    result.output,
    "operation=remove\npr_number=456\nskip=false\n",
  );
});

test("rejects manual remove from a non-default dispatch ref", async () => {
  const result = await runResolver({
    inputPullRequestNumber: "123",
    operation: "remove",
  });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /must run from the default branch/u);
  assert.deepEqual(result.requests, []);
});

test("requires a target branch or pull request number for manual remove", async () => {
  const result = await runResolver({
    operation: "remove",
    refName: "main",
  });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /requires target-branch or pr-number/u);
  assert.deepEqual(result.requests, []);
});

test("rejects target-branch for manual deploy", async () => {
  const result = await runResolver({ targetBranch: "another-branch" });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /supported only for manual remove/u);
  assert.deepEqual(result.requests, []);
});

test("requires explicit deploys to target an open PR for the selected branch", async () => {
  const closed = await runResolver({
    inputPullRequestNumber: "123",
    responseFor: () => ({
      body: pullRequest({ state: "closed" }),
      headers: {},
      status: 200,
    }),
  });
  const mismatched = await runResolver({
    inputPullRequestNumber: "123",
    responseFor: () => ({
      body: pullRequest({ ref: "another-branch" }),
      headers: {},
      status: 200,
    }),
  });

  assert.equal(closed.code, 1);
  assert.match(closed.stderr, /is not open for deploy/u);
  assert.equal(mismatched.code, 1);
  assert.match(mismatched.stderr, /does not match selected branch/u);
});

test("rejects an invalid explicit pull request number before querying GitHub", async () => {
  const result = await runResolver({ inputPullRequestNumber: "001" });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /positive integer without leading zeros/u);
  assert.deepEqual(result.requests, []);
});

test("rejects tags before querying GitHub", async () => {
  const result = await runResolver({ refType: "tag" });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /selected branch/u);
  assert.deepEqual(result.requests, []);
});

test("rejects malformed or mismatched GitHub responses", async () => {
  const malformed = await runResolver({
    responseFor: () => ({
      body: { number: 123 },
      headers: {},
      status: 200,
    }),
  });
  const mismatched = await runResolver({
    responseFor: () => ({
      body: [pullRequest({ ref: "another-branch" })],
      headers: {},
      status: 200,
    }),
  });

  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /invalid pull request list/u);
  assert.equal(mismatched.code, 1);
  assert.match(mismatched.stderr, /unexpected pull request match/u);
});

test("rejects paginated and failed GitHub responses", async () => {
  const paginated = await runResolver({
    responseFor: () => ({
      body: [pullRequest()],
      headers: {
        Link: '<https://api.example.test/pulls?page=2>; rel="next"',
      },
      status: 200,
    }),
  });
  const failed = await runResolver({
    responseFor: () => ({
      body: { message: "Server Error" },
      headers: {},
      status: 500,
    }),
  });

  assert.equal(paginated.code, 1);
  assert.match(paginated.stderr, /too many pull request matches/u);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /HTTP 500/u);
});

test("requires a token before querying GitHub", async () => {
  const result = await runResolver({ token: "" });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /token/u);
  assert.deepEqual(result.requests, []);
});
