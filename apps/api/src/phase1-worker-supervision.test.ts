// Phase-1 addition for the isolated workspace slice. Apache-2.0; see LICENSE. Not an upstream Rakazo file.
// Fake children only. No database server is started.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { stopClusterAfterWorkers, superviseFixtureWorker } from "./phase1-worker-supervision.js";

function fakeChild() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: 4242 });
  child.kill = () => true;
  return child;
}

it("stops the cluster only after the worker close event", async () => {
  const child = fakeChild();
  const worker = superviseFixtureWorker(child, {
    closeWaitMs: 50,
    signal: () => child.emit("close", 0),
  });
  const order: string[] = [];
  await stopClusterAfterWorkers([worker], async () => {
    order.push(worker.confirmedClosed() ? "worker-closed" : "worker-open");
    order.push("cluster-stop");
  });
  expect(order).toEqual(["worker-closed", "cluster-stop"]);
  expect(worker.confirmedClosed()).toBe(true);
});

it("does not stop the cluster when a timeout cannot confirm the worker closed", async () => {
  const child = fakeChild();
  const worker = superviseFixtureWorker(child, {
    closeWaitMs: 20,
    signal: () => {
      throw new Error("signal failed");
    },
  });
  let stopped = false;
  await expect(worker.until(/never/, 15)).rejects.toThrow(/close unconfirmed/);
  await expect(
    stopClusterAfterWorkers([worker], async () => {
      stopped = true;
    }),
  ).rejects.toThrow(/close unconfirmed/);
  expect(stopped).toBe(false);
  expect(worker.confirmedClosed()).toBe(false);
});
