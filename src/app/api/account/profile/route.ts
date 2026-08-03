import { hash as hashPassword } from "bcryptjs";
import { and, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { effectiveReminderLimit } from "@/lib/membership";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { apiError } from "@/server/http";

const profileSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/),
  displayName: z.string().trim().min(1).max(30),
  timezone: z.enum(["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei"]),
  password: z.string().min(8).max(72).optional(),
});

export async function PATCH(request: Request) {
  try {
    const current = await requireUser();
    const input = profileSchema.parse(await request.json());
    const [existing] = await db.select({ id: users.id }).from(users).where(and(eq(users.username, input.username), ne(users.id, current.id))).limit(1);
    if (existing) return NextResponse.json({ error: "该用户名已被使用" }, { status: 409 });
    const update: typeof users.$inferInsert = { username: input.username, displayName: input.displayName, timezone: input.timezone, updatedAt: new Date() };
    if (input.password) update.passwordHash = await hashPassword(input.password, 12);
    const [user] = await db.update(users).set(update).where(eq(users.id, current.id)).returning();
    return NextResponse.json({ user: { id: user.id, username: user.username, displayName: user.displayName, timezone: user.timezone, role: user.role, vipType: user.vipType, vipExpiresAt: user.vipExpiresAt, reminderLimitOverride: user.reminderLimitOverride, reminderLimit: effectiveReminderLimit(user) } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "请检查用户名、昵称、时区和密码格式" }, { status: 400 });
    return apiError(error);
  }
}
