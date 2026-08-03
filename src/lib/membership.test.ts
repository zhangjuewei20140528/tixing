import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultMonthlyExpiry,
  effectiveReminderLimit,
  isVipActive,
  membershipLabel,
  membershipStatusText,
  MONTHLY_VIP_DURATION_DAYS,
  MONTHLY_VIP_PRICE_CENTS,
  reminderLimitMessage,
} from "./membership";

const now = new Date("2026-07-30T00:00:00.000Z");

test("monthly VIP plan keeps the configured price and duration", () => {
  assert.equal(MONTHLY_VIP_PRICE_CENTS, 499);
  assert.equal(MONTHLY_VIP_DURATION_DAYS, 30);
});

test("permanent VIP is always active", () => {
  assert.equal(isVipActive("permanent", null, now), true);
  assert.equal(membershipLabel("permanent", null, now), "永久 VIP");
});

test("monthly VIP is active only before its expiry", () => {
  assert.equal(isVipActive("monthly", "2026-08-01T00:00:00.000Z", now), true);
  assert.equal(isVipActive("monthly", "2026-07-29T00:00:00.000Z", now), false);
  assert.equal(membershipLabel("monthly", "2026-08-01T00:00:00.000Z", now), "月卡 VIP");
  assert.equal(membershipLabel("monthly", "2026-07-29T00:00:00.000Z", now), "普通用户");
});

test("normal users are not VIP", () => {
  assert.equal(isVipActive("none", null, now), false);
  assert.equal(membershipLabel("none", null, now), "普通用户");
});

test("formats visible membership identity and monthly expiry", () => {
  const expiry = new Date("2026-08-29T00:00:00.000Z");
  assert.equal(membershipStatusText("monthly", expiry, now), "月卡 VIP · 2026年8月29日到期");
  assert.match(membershipStatusText("monthly", expiry, new Date("2026-08-30T00:00:00.000Z")), /^月卡 VIP（已到期）/);
  assert.equal(membershipStatusText("permanent", null, now), "永久 VIP · 永久有效");
  assert.equal(membershipStatusText("none", null, now), "普通用户");
});

test("default monthly expiry is exactly 30 days later", () => {
  assert.equal(defaultMonthlyExpiry(now).toISOString(), "2026-08-29T00:00:00.000Z");
});

test("calculates reminder limits for each membership and administrator overrides", () => {
  assert.equal(effectiveReminderLimit({ vipType: "none", vipExpiresAt: null }, now), 1);
  assert.equal(effectiveReminderLimit({ vipType: "monthly", vipExpiresAt: "2026-08-01T00:00:00.000Z" }, now), 10);
  assert.equal(effectiveReminderLimit({ vipType: "monthly", vipExpiresAt: "2026-07-01T00:00:00.000Z" }, now), 1);
  assert.equal(effectiveReminderLimit({ vipType: "permanent", vipExpiresAt: null }, now), 20);
  assert.equal(effectiveReminderLimit({ vipType: "permanent", vipExpiresAt: null, reminderLimitOverride: 7 }, now), 7);
  const upgradeMessage = reminderLimitMessage({ vipType: "none", vipExpiresAt: null }, 1, now);
  assert.match(upgradeMessage, /升级会员后可设置更多提醒：http:\/\//);
});
