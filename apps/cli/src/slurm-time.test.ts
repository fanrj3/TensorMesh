import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSlurmDurationSeconds,
  getSlurmKillTiming,
  parseSlurmDurationSeconds
} from "@tensormesh/shared";
import { validateSlurmTimeLimit } from "@tensormesh/shared/node";

test("Slurm durations support multi-day limits", () => {
  assert.equal(parseSlurmDurationSeconds("31-00:00:00"), 31 * 86_400);
  assert.equal(parseSlurmDurationSeconds("31-00"), 31 * 86_400);
  assert.equal(parseSlurmDurationSeconds("90-00:00:00"), 90 * 86_400);
  assert.equal(formatSlurmDurationSeconds(60 * 86_400 + 3_661), "60-01:01:01");
});

test("running jobs expose the remaining hard-limit time and kill timestamp", () => {
  const now = Date.parse("2026-07-24T10:00:00.000Z");
  const timing = getSlurmKillTiming({
    state: "RUNNING",
    elapsed: "30-00:00:00",
    timeLimit: "90-00:00:00"
  }, now);

  assert.equal(timing.killRemaining, "60-00:00:00");
  assert.equal(timing.killRemainingSeconds, 60 * 86_400);
  assert.equal(timing.killAt, "2026-09-22T10:00:00.000Z");
});

test("pending jobs do not show a wall-clock kill countdown before allocation", () => {
  assert.deepEqual(getSlurmKillTiming({
    state: "PENDING",
    elapsed: "00:00:00",
    timeLimit: "31-00:00:00"
  }), {
    killRemaining: undefined,
    killRemainingSeconds: undefined,
    killAt: undefined
  });
});

test("explicit hard limits accept 90 days and reject longer requests", () => {
  assert.equal(validateSlurmTimeLimit("90-00:00:00"), 90 * 86_400);
  assert.equal(validateSlurmTimeLimit("90-00"), 90 * 86_400);
  assert.throws(() => validateSlurmTimeLimit("91-00:00:00"), /cannot exceed.*90 days/);
  assert.throws(() => validateSlurmTimeLimit("unlimited"), /must be a positive Slurm duration/);
});
