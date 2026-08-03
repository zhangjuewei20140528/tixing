import { db } from "./db";
import { systemSettings } from "./db/schema";

export const DEFAULT_SYSTEM_SETTINGS = {
  id: "default",
  accountRegistrationEnabled: true,
  wechatRegistrationEnabled: true,
  reminderCreationEnabled: true,
  aiEnabled: true,
  aiGlobalDailyLimit: 3000,
  alertEmail: process.env.OPS_ALERT_EMAIL || "",
} as const;

let cached: { value: typeof systemSettings.$inferSelect; expiresAt: number } | null = null;

export function clearSystemSettingsCache() {
  cached = null;
}

export async function getSystemSettings() {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  await db.insert(systemSettings).values(DEFAULT_SYSTEM_SETTINGS).onConflictDoNothing();
  const [value] = await db.select().from(systemSettings).limit(1);
  if (!value) throw new Error("SYSTEM_SETTINGS_UNAVAILABLE");
  cached = { value, expiresAt: Date.now() + 5_000 };
  return value;
}
