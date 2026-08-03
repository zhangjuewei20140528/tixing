import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { reminders, wechatBindings } from "@/server/db/schema";
import { apiError } from "@/server/http";
import { scheduleReminder } from "@/server/queue";

export async function POST() {
  try {
    const user = await requireUser();
    const [binding] = await db.select({ id: wechatBindings.id }).from(wechatBindings).where(and(eq(wechatBindings.userId, user.id), eq(wechatBindings.status, "active"))).limit(1);
    if (!binding) return NextResponse.json({ error: "请先绑定微信" }, { status: 409 });
    const scheduledAt = new Date(Date.now() + 2_000);
    const [reminder] = await db.insert(reminders).values({ userId: user.id, title: "微信连接测试", originalInput: "系统连接测试", scheduledAt, repeatRule: "once" }).returning();
    let jobId: string | null;
    try {
      jobId = await scheduleReminder(reminder.id, scheduledAt);
    } catch (error) {
      await db.delete(reminders).where(eq(reminders.id, reminder.id));
      throw error;
    }
    await db.update(reminders).set({ queueJobId: jobId }).where(eq(reminders.id, reminder.id));
    return NextResponse.json({ reminderId: reminder.id, scheduledAt }, { status: 202 });
  } catch (error) { return apiError(error); }
}
