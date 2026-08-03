import assert from "node:assert/strict";
import test from "node:test";
import { decideExistingDeliveryAttempt, MAX_AUTOMATIC_DELIVERY_ATTEMPTS } from "./delivery-retry";

test("does not send a duplicate while another delivery is pending", () => {
  assert.equal(decideExistingDeliveryAttempt({ status: "pending", attempt: 1, handled: false, manualRetry: false }), "duplicate");
});

test("automatic retries stop at the delivery attempt limit", () => {
  assert.equal(decideExistingDeliveryAttempt({ status: "failed", attempt: MAX_AUTOMATIC_DELIVERY_ATTEMPTS, handled: false, manualRetry: false }), "exhausted");
  assert.equal(decideExistingDeliveryAttempt({ status: "failed", attempt: MAX_AUTOMATIC_DELIVERY_ATTEMPTS - 1, handled: false, manualRetry: false }), "send");
});

test("a deliberate admin retry can recover a previously exhausted delivery", () => {
  assert.equal(decideExistingDeliveryAttempt({ status: "failed", attempt: 33, handled: false, manualRetry: true }), "send");
});

test("handled or already sent deliveries are never sent again", () => {
  assert.equal(decideExistingDeliveryAttempt({ status: "failed", attempt: 1, handled: true, manualRetry: true }), "handled");
  assert.equal(decideExistingDeliveryAttempt({ status: "sent", attempt: 1, handled: false, manualRetry: true }), "duplicate");
});
