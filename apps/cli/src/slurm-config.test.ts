import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("generated Slurm partition accepts jobs up to 90 days", async () => {
  const source = await readFile(new URL("./slurm-config.ts", import.meta.url), "utf8");

  assert.match(source, /^PartitionName=gpu .* MaxTime=90-00:00:00 State=UP$/m);
  assert.doesNotMatch(source, /^PartitionName=gpu .* MaxTime=7-00:00:00 State=UP$/m);
});

test("generated Slurm config backfills jobs onto non-conflicting resources", async () => {
  const source = await readFile(new URL("./slurm-config.ts", import.meta.url), "utf8");

  assert.match(source, /^PriorityType=priority\/basic$/m);
  assert.match(source, /^SchedulerType=sched\/backfill$/m);
  assert.match(source, /^PreemptType=preempt\/none$/m);
  assert.doesNotMatch(source, /^SchedulerType=sched\/builtin$/m);
});
