import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession } from "@/server/auth";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { effectiveReminderLimit } from "@/lib/membership";

const inputSchema = z.object({
  username: z.string().trim().toLowerCase().min(3).max(32),
  password: z.string().min(1).max(72),
});

export async function POST(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    const [user] = await db.select().from(users).where(eq(users.username, input.username)).limit(1);
    const valid = user?.passwordHash ? await compare(input.password, user.passwordHash) : false;
    if (!user || !valid) return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
    if (user.accountStatus === "disabled") return NextResponse.json({ error: "账号已被禁用" }, { status: 403 });

    await createSession(user.id);
    return NextResponse.json({ user: { id: user.id, username: user.username, displayName: user.displayName, timezone: user.timezone, role: user.role, vipType: user.vipType, vipExpiresAt: user.vipExpiresAt, reminderLimitOverride: user.reminderLimitOverride, reminderLimit: effectiveReminderLimit(user) } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "请输入正确的用户名和密码" }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: "登录暂时失败，请稍后重试" }, { status: 500 });
  }
}
