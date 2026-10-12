import assert from "node:assert/strict";
import test from "node:test";
import type { SlurmJob } from "@tensormesh/shared";
import {
  formatCancelJobDetails,
  isCancelConfirmation,
  nextCancelJobIndex,
  runCancelCommand,
  type CancelCommandDependencies
} from "./cancel";

function job(id: string, overrides: Partial<SlurmJob> = {}): SlurmJob {
  return {
    id,
    name: `train-${id}`,
    user: "alice",
    state: "RUNNING",
    partition: "gpu",
    nodes: "gpu-node",
    elapsed: "00:12:34",
    timeLimit: "1-00:00:00",
    reason: "training smoke test",
    allocatedGpuIndexes: [2],
    workDir: "/data/alice/project",
    command: "python train.py",
    ...overrides
  };
}

function dependencies(overrides: Partial<CancelCommandDependencies> = {}): CancelCommandDependencies {
  return {
    currentUser: "alice",
    getJobs: async () => [],
    getJob: async (jobId) => job(jobId),
    cancelJob: async () => undefined,
    selectJob: async (jobs) => jobs[0],
    confirmJob: async () => true,
    ...overrides
  };
}

test("cancel without an id lists the current user's jobs and cancels the selected job", async () => {
  const jobs = [job("101"), job("202", { state: "PENDING" })];
  const calls: string[] = [];
  const result = await runCancelCommand(undefined, dependencies({
    getJobs: async (user) => {
      calls.push(`list:${user}`);
      return jobs;
    },
    selectJob: async (options) => {
      assert.deepEqual(options, jobs);
      calls.push("select:202");
      return options[1];
    },
    getJob: async (jobId) => {
      calls.push(`detail:${jobId}`);
      return job("202", { state: "PENDING", command: "bash reserve.sh" });
    },
    confirmJob: async (selected) => {
      calls.push(`confirm:${selected.id}:${selected.command}`);
      return true;
    },
    cancelJob: async (jobId) => {
      calls.push(`cancel:${jobId}`);
    }
  }));

  assert.equal(result?.id, "202");
  assert.deepEqual(calls, [
    "list:alice",
    "select:202",
    "detail:202",
    "confirm:202:bash reserve.sh",
    "cancel:202"
  ]);
});

test("cancel with an id shows details but does not cancel unless confirmation is Y", async () => {
  let listCalled = false;
  let selectCalled = false;
  let cancelCalled = false;
  const result = await runCancelCommand("303", dependencies({
    getJobs: async () => {
      listCalled = true;
      return [];
    },
    selectJob: async () => {
      selectCalled = true;
      return undefined;
    },
    getJob: async () => job("303", { name: "important-training" }),
    confirmJob: async (selected) => {
      assert.equal(selected.name, "important-training");
      return false;
    },
    cancelJob: async () => {
      cancelCalled = true;
    }
  }));

  assert.equal(result, undefined);
  assert.equal(listCalled, false);
  assert.equal(selectCalled, false);
  assert.equal(cancelCalled, false);
});

test("cancel rejects a job owned by another user before confirmation", async () => {
  let confirmed = false;
  let cancelled = false;
  await assert.rejects(
    runCancelCommand("404", dependencies({
      getJob: async () => job("404", { user: "bob" }),
      confirmJob: async () => {
        confirmed = true;
        return true;
      },
      cancelJob: async () => {
        cancelled = true;
      }
    })),
    /owner 是 bob，当前用户是 alice/
  );
  assert.equal(confirmed, false);
  assert.equal(cancelled, false);
});

test("cancel details include fields needed to identify the job", () => {
  const output = formatCancelJobDetails(job("505", {
    name: "large-inference",
    taskDescription: "blind-road inference\nnight batch",
    allocatedGpuIndexes: [1, 7],
    command: "python infer.py --split test"
  }));

  assert.match(output, /Slurm Job 505/);
  assert.match(output, /Name\s+large-inference/);
  assert.match(output, /User\s+alice/);
  assert.match(output, /GPU\s+GPU1,GPU7/);
  assert.match(output, /Command\s+python infer.py --split test/);
  assert.match(output, /Reason\s+blind-road inference night batch/);
});

test("job selection wraps with up and down keys", () => {
  assert.equal(nextCancelJobIndex(0, 3, "up"), 2);
  assert.equal(nextCancelJobIndex(2, 3, "down"), 0);
  assert.equal(nextCancelJobIndex(0, 0, "down"), 0);
});

test("only Y or yes confirms cancellation", () => {
  assert.equal(isCancelConfirmation("Y"), true);
  assert.equal(isCancelConfirmation(" yes "), true);
  assert.equal(isCancelConfirmation(""), false);
  assert.equal(isCancelConfirmation("n"), false);
  assert.equal(isCancelConfirmation("是"), false);
});
