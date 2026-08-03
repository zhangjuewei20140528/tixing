import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth";
import { effectiveReminderLimit } from "@/lib/membership";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ user: null });
  if (user.accountStatus === "disabled") return NextResponse.json({ user: null, error: "账号已被禁用" }, { status: 403 });
  return NextResponse.json({ user: { id: user.id, username: user.username, displayName: user.displayName, timezone: user.timezone, role: user.role, vipType: user.vipType, vipExpiresAt: user.vipExpiresAt, reminderLimitOverride: user.reminderLimitOverride, reminderLimit: effectiveReminderLimit(user) } });
}
