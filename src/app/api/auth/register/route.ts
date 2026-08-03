import { hash as hashPassword } from "bcryptjs";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession } from "@/server/auth";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { effectiveReminderLimit } from "@/lib/membership";
import { getSystemSettings } from "@/server/system-settings";

const inputSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/),
  password: z.string().min(8).max(72),
  displayName: z.string().trim().min(1).max(30),
});

export async function POST(request: Request) {
  try {
    if (!(await getSystemSettings()).accountRegistrationEnabled) return NextResponse.json({ error: "账号注册暂未开放" }, { status: 403 });
    const input = inputSchema.parse(await request.json());
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, input.username)).limit(1);
    if (existing) return NextResponse.json({ error: "该用户名已被使用" }, { status: 409 });

    const passwordHash = await hashPassword(input.password, 12);
    const [user] = await db.insert(users).values({
      username: input.username,
      passwordHash,
      displayName: input.displayName,
      role: "user",
    }).returning();
    await createSession(user.id);
    return NextResponse.json({ user: { id: user.id, username: user.username, displayName: user.displayName, timezone: user.timezone, role: user.role, vipType: user.vipType, vipExpiresAt: user.vipExpiresAt, reminderLimitOverride: user.reminderLimitOverride, reminderLimit: effectiveReminderLimit(user) } }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "请检查用户名、昵称和密码格式" }, { status: 400 });
    if (error instanceof Error && error.message.includes("users_username_unique")) return NextResponse.json({ error: "该用户名已被使用" }, { status: 409 });
    console.error(error);
    return NextResponse.json({ error: "注册暂时失败，请稍后重试" }, { status: 500 });
  }
}
