import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SharedTaskEntry } from "@tensormesh/shared";

// Point the registry at a throwaway file before importing the module.
const testDirectory = mkdtempSync(path.join(os.tmpdir(), "tensormesh-shared-tasks-test-"));
process.env.TENSORMESH_SHARED_TASKS_FILE = path.join(testDirectory, "shared-tasks.json");
// Tests use fake scope names that do not exist as systemd scopes; disable pruning.
process.env.TENSORMESH_SHARED_TASKS_SKIP_PRUNE = "1";

const {
  isSharedProcess,
  listSharedTasks,
  registerSharedTask,
  resetSharedTaskRegistryForTests,
  unregisterSharedTask
} = await import("./shared-tasks");

function entry(overrides: Partial<SharedTaskEntry> = {}): SharedTaskEntry {
  return {
    id: "s-test-1",
    user: "admin",
    gpuIndexes: [6],
    scope: "shared-s-test-1.scope",
    command: "python train.py",
    startedAt: "2026-08-01T00:00:00.000Z",
    createdBy: "admin",
    ...overrides
  };
}

test("register/list/unregister round-trip", () => {
  resetSharedTaskRegistryForTests();
  assert.deepEqual(listSharedTasks(), []);
  registerSharedTask(entry());
  const listed = listSharedTasks();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "s-test-1");
  assert.equal(listed[0].gpuIndexes[0], 6);

  assert.equal(unregisterSharedTask("s-test-1"), true);
  assert.deepEqual(listSharedTasks(), []);
  // unregistering an unknown id returns false
  assert.equal(unregisterSharedTask("s-test-1"), false);
});

test("registering the same id replaces the previous entry", () => {
  resetSharedTaskRegistryForTests();
  registerSharedTask(entry({ gpuIndexes: [6] }));
  registerSharedTask(entry({ gpuIndexes: [7], scope: "shared-s-test-1.scope" }));
  const listed = listSharedTasks();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].gpuIndexes, [7]);
});

test("isSharedProcess matches processes inside a registered scope", () => {
  resetSharedTaskRegistryForTests();
  // Our own process is not in any shared scope.
  assert.equal(isSharedProcess(process.pid), false);
  registerSharedTask(entry());
  assert.equal(isSharedProcess(process.pid), false);
});

test("registry persists across module state resets via the file", () => {
  resetSharedTaskRegistryForTests();
  registerSharedTask(entry());
  // listSharedTasks re-reads from the persisted file (registry was reset).
  resetSharedTaskRegistryForTests();
  const listed = listSharedTasks();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "s-test-1");
  unregisterSharedTask("s-test-1");
});

test.after(() => {
  rmSync(testDirectory, { recursive: true, force: true });
});
