import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { defaultMonthlyExpiry } from "@/lib/membership";
import { requireAdmin } from "@/server/auth";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { apiError } from "@/server/http";
import { writeAdminAudit } from "@/server/admin-audit";

const inputSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/),
  displayName: z.string().trim().min(1).max(30),
  adminNote: z.string().trim().max(200).nullable().optional(),
  password: z.string().min(8).max(72),
  timezone: z.string().trim().min(1).max(50).default("Asia/Shanghai"),
  accountStatus: z.enum(["active", "disabled"]).default("active"),
  vipType: z.enum(["none", "monthly", "permanent"]).default("none"),
  vipExpiresAt: z.coerce.date().nullable().optional(),
  reminderLimitOverride: z.number().int().min(0).max(1000).nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const input = inputSchema.parse(await request.json());
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, input.username)).limit(1);
    if (existing) return NextResponse.json({ error: "该用户名已被使用" }, { status: 409 });

    const [user] = await db.insert(users).values({
      username: input.username,
      displayName: input.displayName,
      adminNote: input.adminNote || null,
      passwordHash: await hash(input.password, 12),
      timezone: input.timezone,
      accountStatus: input.accountStatus,
      vipType: input.vipType,
      vipExpiresAt: input.vipType === "monthly" ? input.vipExpiresAt || defaultMonthlyExpiry() : null,
      reminderLimitOverride: input.reminderLimitOverride ?? null,
    }).returning();
    await writeAdminAudit({ actorUserId: admin.id, action: "user.create", targetType: "user", targetId: user.id, summary: `创建用户 ${user.displayName}` });
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "请检查用户资料和会员设置" }, { status: 400 });
    if (error instanceof Error && error.message.includes("users_username_unique")) return NextResponse.json({ error: "该用户名已被使用" }, { status: 409 });
    return apiError(error);
  }
}
