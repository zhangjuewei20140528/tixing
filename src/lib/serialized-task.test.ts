import assert from "node:assert/strict";
import test from "node:test";
import { retryTransient, runSerialized } from "./serialized-task";

test("serializes tasks sharing a key while allowing other keys", async () => {
  const events: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = runSerialized("account-a", async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const second = runSerialized("account-a", async () => { events.push("second"); });
  const other = runSerialized("account-b", async () => { events.push("other"); });

  await other;
  assert.deepEqual(events, ["first-start", "other"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "other", "first-end", "second"]);
});

test("retries only transient failures", async () => {
  let attempts = 0;
  const result = await retryTransient(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("prepare failed");
    return "sent";
  }, (error) => error instanceof Error && error.message.includes("prepare failed"), [0, 0]);

  assert.equal(result, "sent");
  assert.equal(attempts, 3);
});

test("releases the serialized queue after a failure", async () => {
  await assert.rejects(runSerialized("account-failure", async () => {
    throw new Error("send failed");
  }), /send failed/);

  assert.equal(await runSerialized("account-failure", async () => "next sent"), "next sent");
});
