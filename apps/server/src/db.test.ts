import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SlurmJob } from "@tensormesh/shared";

const testDirectory = mkdtempSync(path.join(os.tmpdir(), "tensormesh-db-test-"));
process.env.TENSORMESH_DB_PATH = path.join(testDirectory, "history.db");

const {
  getActiveSlurmJobHistoryIds,
  getSlurmJobHistoryFromDb,
  recordSlurmJobHistory
} = await import("./db");

function job(state: string, overrides: Partial<SlurmJob> = {}): SlurmJob {
  return {
    id: "42",
    name: "history-test",
    user: "alice",
    state,
    partition: "gpu",
    nodes: "node1",
    elapsed: "00:01:00",
    timeLimit: "01:00:00",
    reason: "test history lifecycle",
    ...overrides
  };
}

test("records, finalizes, filters, and reactivates Slurm job history", () => {
  const baseTime = Date.now() - 5 * 60 * 1000;
  const at = (offsetSeconds: number) => new Date(baseTime + offsetSeconds * 1000).toISOString();
  const submittedAt = at(-120);
  const firstSeenAt = at(0);
  const endedAt = at(120);

  recordSlurmJobHistory([job("RUNNING", {
    submittedAt,
    startedAt: firstSeenAt
  })], firstSeenAt);

  assert.deepEqual(getActiveSlurmJobHistoryIds(), ["42"]);
  let active = getSlurmJobHistoryFromDb({ user: "alice", days: 365, active: true });
  assert.equal(active.jobs.length, 1);
  assert.equal(active.jobs[0].state, "RUNNING");
  assert.equal(active.jobs[0].submittedAt, submittedAt);

  recordSlurmJobHistory([], endedAt);

  assert.deepEqual(getActiveSlurmJobHistoryIds(), []);
  const finished = getSlurmJobHistoryFromDb({ user: "alice", days: 365, active: false });
  assert.equal(finished.jobs.length, 1);
  assert.equal(finished.jobs[0].state, "ENDED");
  assert.equal(finished.jobs[0].endedAt, endedAt);

  recordSlurmJobHistory([job("RUNNING")], at(180));
  active = getSlurmJobHistoryFromDb({ user: "alice", days: 365, active: true });
  assert.equal(active.jobs.length, 1);
  assert.equal(active.jobs[0].firstSeenAt, firstSeenAt);
  assert.equal(active.jobs[0].endedAt, undefined);

  recordSlurmJobHistory([job("COMPLETED", {
    endedAt: at(270),
    exitCode: "0:0"
  })], at(300));
  const completed = getSlurmJobHistoryFromDb({ user: "alice", days: 365, active: false });
  assert.equal(completed.jobs[0].state, "COMPLETED");
  assert.equal(completed.jobs[0].endedAt, at(270));
  assert.equal(completed.jobs[0].exitCode, "0:0");
});

test.after(() => {
  rmSync(testDirectory, { recursive: true, force: true });
});
