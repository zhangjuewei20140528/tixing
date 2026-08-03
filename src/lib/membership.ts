export const MONTHLY_VIP_PRICE_CENTS = 499;
export const MONTHLY_VIP_DURATION_DAYS = 30;
export const FREE_REMINDER_LIMIT = 1;
export const MONTHLY_VIP_REMINDER_LIMIT = 10;
export const PERMANENT_VIP_REMINDER_LIMIT = 20;
export const REMINDER_UPGRADE_URL = (process.env.NEXT_PUBLIC_UPGRADE_URL || "http://localhost:3100/").replace(/\/$/, "") + "/";

export type VipType = "none" | "monthly" | "permanent";

export function isVipActive(vipType: VipType, vipExpiresAt: Date | string | null, now = new Date()) {
  if (vipType === "permanent") return true;
  if (vipType !== "monthly" || !vipExpiresAt) return false;
  return new Date(vipExpiresAt).getTime() > now.getTime();
}

export function membershipLabel(vipType: VipType, vipExpiresAt: Date | string | null, now = new Date()) {
  if (vipType === "permanent") return "永久 VIP";
  if (isVipActive(vipType, vipExpiresAt, now)) return "月卡 VIP";
  return "普通用户";
}

export function membershipStatusText(
  vipType: VipType,
  vipExpiresAt: Date | string | null,
  now = new Date(),
  timezone = "Asia/Shanghai",
) {
  if (vipType === "permanent") return "永久 VIP · 永久有效";
  if (vipType !== "monthly" || !vipExpiresAt) return "普通用户";
  const expiry = new Date(vipExpiresAt);
  if (Number.isNaN(expiry.getTime())) return "普通用户";
  const date = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(expiry);
  return isVipActive(vipType, expiry, now)
    ? `月卡 VIP · ${date}到期`
    : `月卡 VIP（已到期）· ${date}到期`;
}

export function defaultMonthlyExpiry(now = new Date()) {
  return new Date(now.getTime() + MONTHLY_VIP_DURATION_DAYS * 24 * 60 * 60 * 1000);
}

export function defaultReminderLimit(vipType: VipType, vipExpiresAt: Date | string | null, now = new Date()) {
  if (vipType === "permanent") return PERMANENT_VIP_REMINDER_LIMIT;
  if (isVipActive(vipType, vipExpiresAt, now)) return MONTHLY_VIP_REMINDER_LIMIT;
  return FREE_REMINDER_LIMIT;
}

export function effectiveReminderLimit(
  user: { vipType: VipType; vipExpiresAt: Date | string | null; reminderLimitOverride?: number | null },
  now = new Date(),
) {
  return user.reminderLimitOverride == null
    ? defaultReminderLimit(user.vipType, user.vipExpiresAt, now)
    : Math.max(0, user.reminderLimitOverride);
}

export function reminderLimitMessage(
  user: { vipType: VipType; vipExpiresAt: Date | string | null; reminderLimitOverride?: number | null },
  limit = effectiveReminderLimit(user),
  now = new Date(),
) {
  if (user.reminderLimitOverride != null) return `你的提醒数量上限是 ${limit} 条，当前已达到上限。`;
  if (user.vipType === "permanent") return `永久 VIP 最多可设置 ${limit} 条有效提醒，你已达到上限。`;
  if (isVipActive(user.vipType, user.vipExpiresAt, now)) return `月卡 VIP 最多可设置 ${limit} 条有效提醒，你已达到上限。`;
  return `普通用户只能设置 ${limit} 条有效提醒。升级会员后可设置更多提醒：${REMINDER_UPGRADE_URL}`;
}
