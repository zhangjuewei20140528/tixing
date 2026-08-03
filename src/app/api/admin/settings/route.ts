import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAdminAudit } from "@/server/admin-audit";
import { requireAdmin } from "@/server/auth";
import { db } from "@/server/db";
import { systemSettings } from "@/server/db/schema";
import { apiError } from "@/server/http";
import { clearSystemSettingsCache, getSystemSettings } from "@/server/system-settings";

const settingsSchema = z.object({
  accountRegistrationEnabled: z.boolean(),
  wechatRegistrationEnabled: z.boolean(),
  reminderCreationEnabled: z.boolean(),
  aiEnabled: z.boolean(),
  aiGlobalDailyLimit: z.number().int().min(0).max(100000),
  alertEmail: z.string().trim().email().max(200),
});

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ settings: await getSystemSettings() });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const admin = await requireAdmin();
    const input = settingsSchema.parse(await request.json());
    await getSystemSettings();
    const [settings] = await db.update(systemSettings).set({ ...input, updatedBy: admin.id, updatedAt: new Date() }).where(eq(systemSettings.id, "default")).returning();
    clearSystemSettingsCache();
    await writeAdminAudit({ actorUserId: admin.id, action: "settings.update", targetType: "system", targetId: "default", summary: "更新系统运营设置", details: input });
    return NextResponse.json({ settings });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message || "系统设置不正确" }, { status: 400 });
    return apiError(error);
  }
}
