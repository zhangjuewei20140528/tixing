import { NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { parseChineseReminders } from "@/lib/reminder-parser";
import { requireUser } from "@/server/auth";
import { analyzeReminderIntent } from "@/server/reminder-intent-provider";
import { db } from "@/server/db";
import { reminders } from "@/server/db/schema";
import { apiError } from "@/server/http";

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const input = await request.json() as { text?: string };
    const text = String(input.text || "").trim().slice(0, 300);
    if (!text) return NextResponse.json({ error: "请输入提醒内容" }, { status: 400 });
    const local = parseChineseReminders(text);
    if (local.reminders.length || local.clarification?.reason !== "unrecognized") return NextResponse.json({ source: "rules", ...local });
    const candidates = await db.select({ title: reminders.title, scheduledAt: reminders.scheduledAt, repeatRule: reminders.repeatRule })
      .from(reminders).where(and(eq(reminders.userId, user.id), inArray(reminders.status, ["upcoming", "paused"]))).orderBy(asc(reminders.scheduledAt)).limit(5);
    const intent = await analyzeReminderIntent({ user, text, timezone: user.timezone, reminders: candidates });
    if (!intent) return NextResponse.json({ source: "rules", reminders: [], clarification: { originalInput: text, reason: "unrecognized", prompt: "还没有识别到准确时间，请补充日期和时间。" } });
    if (intent.intent === "unsupported") return NextResponse.json({ source: "ai", unsupported: true, reminders: [], clarification: null });
    if (intent.intent === "clarify") return NextResponse.json({ source: "ai", reminders: [], clarification: { originalInput: text, reason: intent.clarification_reason === "missing_title" ? "missing_title" : "missing_exact_time", prompt: intent.clarification_reason === "missing_title" ? "时间我记住了。要提醒你做什么？" : "还需要一个准确时间，例如“明天下午3点”。" } });
    if (intent.intent !== "create" || !intent.title || !intent.time_text) return NextResponse.json({ source: "ai", unsupported: true, reminders: [], clarification: null });
    const repeatText = intent.repeat === "daily" ? `每天${intent.repeat_days ? `连续${intent.repeat_days}天` : ""}` : intent.repeat === "weekdays" ? "每个工作日" : "";
    const parsed = parseChineseReminders(`${repeatText}${intent.time_text}提醒我${intent.title}`);
    return NextResponse.json({ source: "ai", ...parsed, correctionNote: intent.correction_note });
  } catch (error) {
    return apiError(error);
  }
}
