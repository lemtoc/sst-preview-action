import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(
  new URL("../scripts/plan-reconciliation.mjs", import.meta.url),
);

const runPlanner = async ({
  candidates = ["pr-123"],
  responseFor = () => ({
    body: { number: 123, state: "open", closed_at: null },
    status: 200,
  }),
  token = "test-token",
}) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "sst-preview-action-test-"),
  );
  const candidatesFile = join(temporaryDirectory, "candidates");
  const githubOutput = join(temporaryDirectory, "github-output");
  await writeFile(
    candidatesFile,
    candidates.length === 0 ? "" : `${candidates.join("\n")}\n`,
  );
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
        GITHUB_OUTPUT: githubOutput,
        RECONCILE_CANDIDATES_FILE: candidatesFile,
        RECONCILE_GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        RECONCILE_GITHUB_REPOSITORY: "owner/repository",
        RECONCILE_GITHUB_TOKEN: token,
        RUNNER_TEMP: temporaryDirectory,
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
  const planFile = /^plan_file=(.+)$/mu.exec(output)?.[1];
  const plan = planFile ? await readFile(planFile, "utf8") : undefined;

  await rm(temporaryDirectory, { force: true, recursive: true });

  return { ...result, output, plan, requests };
};

test("plans only pull requests closed beyond the grace period", async () => {
  const result = await runPlanner({
    candidates: ["pr-123", "pr-456", "pr-789"],
    responseFor: (url) => {
      if (url.endsWith("/123")) {
        return {
          body: { number: 123, state: "open", closed_at: null },
          status: 200,
        };
      }
      if (url.endsWith("/456")) {
        return {
          body: {
            number: 456,
            state: "closed",
            closed_at: "2020-01-01T00:00:00Z",
          },
          status: 200,
        };
      }
      return {
        body: {
          number: 789,
          state: "closed",
          closed_at: new Date().toISOString(),
        },
        status: 200,
      };
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.plan, "pr-456\n");
  assert.deepEqual(
    result.requests.map(({ url }) => url),
    [
      "/repos/owner/repository/pulls/123",
      "/repos/owner/repository/pulls/456",
      "/repos/owner/repository/pulls/789",
      "/repos/owner/repository/pulls/456",
    ],
  );
  assert.ok(
    result.requests.every(
      ({ authorization }) => authorization === "Bearer test-token",
    ),
  );
});

test("writes an empty plan when there are no candidates", async () => {
  const result = await runPlanner({ candidates: [] });

  assert.equal(result.code, 0);
  assert.equal(result.plan, "");
  assert.deepEqual(result.requests, []);
});

test("drops a pull request that reopens during final plan validation", async () => {
  let requestCount = 0;
  const result = await runPlanner({
    responseFor: () => {
      requestCount += 1;
      return requestCount === 1
        ? {
            body: {
              number: 123,
              state: "closed",
              closed_at: "2020-01-01T00:00:00Z",
            },
            status: 200,
          }
        : {
            body: { number: 123, state: "open", closed_at: null },
            status: 200,
          };
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.plan, "");
  assert.equal(result.requests.length, 2);
});

test("fails closed when final plan validation cannot recheck GitHub", async () => {
  let requestCount = 0;
  const result = await runPlanner({
    responseFor: () => {
      requestCount += 1;
      return requestCount === 1
        ? {
            body: {
              number: 123,
              state: "closed",
              closed_at: "2020-01-01T00:00:00Z",
            },
            status: 200,
          }
        : { body: { message: "Server Error" }, status: 500 };
    },
  });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.equal(result.plan, undefined);
  assert.match(result.stderr, /HTTP 500/u);
});

test("discards a closed candidate when a later API request fails", async () => {
  const result = await runPlanner({
    candidates: ["pr-123", "pr-456"],
    responseFor: (url) =>
      url.endsWith("/123")
        ? {
            body: {
              number: 123,
              state: "closed",
              closed_at: "2020-01-01T00:00:00Z",
            },
            status: 200,
          }
        : { body: { message: "Not Found" }, status: 404 },
  });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.equal(result.plan, undefined);
  assert.match(result.stderr, /HTTP 404/u);
});

test("rejects a mismatched pull request response", async () => {
  const result = await runPlanner({
    responseFor: () => ({
      body: {
        number: 456,
        state: "closed",
        closed_at: "2020-01-01T00:00:00Z",
      },
      status: 200,
    }),
  });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /mismatched pull request/u);
});

test("fails closed when the GitHub token is missing", async () => {
  const result = await runPlanner({ token: "" });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /token/u);
  assert.deepEqual(result.requests, []);
});

test("rejects an unknown pull request state", async () => {
  const result = await runPlanner({
    responseFor: () => ({
      body: { number: 123, state: "unknown", closed_at: null },
      status: 200,
    }),
  });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /unknown pull request state/u);
});

test("rejects a closed pull request without a valid close time", async () => {
  const result = await runPlanner({
    responseFor: () => ({
      body: { number: 123, state: "closed", closed_at: "not-a-date" },
      status: 200,
    }),
  });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /valid closed_at/u);
});

test("rejects noncanonical and duplicate candidates", async () => {
  const noncanonical = await runPlanner({ candidates: ["dev"] });
  const duplicate = await runPlanner({
    candidates: ["pr-123", "pr-123"],
  });

  assert.equal(noncanonical.code, 1);
  assert.equal(noncanonical.output, "");
  assert.match(noncanonical.stderr, /canonical/u);
  assert.equal(duplicate.code, 1);
  assert.equal(duplicate.output, "");
  assert.match(duplicate.stderr, /duplicates/u);
});

test("refuses a plan larger than the removal limit", async () => {
  const candidates = Array.from({ length: 21 }, (_, index) => `pr-${index + 1}`);
  const result = await runPlanner({
    candidates,
    responseFor: (url) => {
      const number = Number(url.split("/").at(-1));
      return {
        body: {
          number,
          state: "closed",
          closed_at: "2020-01-01T00:00:00Z",
        },
        status: 200,
      };
    },
  });

  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.equal(result.plan, undefined);
  assert.match(result.stderr, /maximum per reconciliation is 20/u);
});
