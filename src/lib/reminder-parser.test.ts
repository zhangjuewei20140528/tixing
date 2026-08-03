import assert from "node:assert/strict";
import test from "node:test";
import { mergeReminderEditTimeClarification, parseNumberedMenuChoice, parseReminderCandidateChoice, parseReminderCancelCommand, parseReminderEditCommand, parseReminderSnoozeCommand, parseReminderStateCommand, reminderEditTimeNeedsClarification, reminderTargetMatches, resolveReminderEditTime } from "./reminder-command";
import { resolveDeliveryFinalization } from "./reminder-delivery";
import { deliveryLatencyMs, formatDeliveryTiming } from "./delivery-timing";
import { isReminderClarificationAnswer, isSpecificReminderTitle, parseChineseReminder, parseChineseReminders, resolveReminderClarification, resolveReminderClarificationStep } from "./reminder-parser";
import { nextFutureOccurrence } from "./reminder-schedule";

const now = new Date(2026, 6, 29, 12, 0, 0, 0);

test("parses common relative-time expressions", () => {
  const cases = [
    ["半个小时之后提醒我喝水", 30],
    ["两小时后提醒我开会", 120],
    ["十五分钟后提醒我休息", 15],
    ["三天后提醒我交材料", 3 * 24 * 60],
    ["一个星期后提醒我续费", 7 * 24 * 60],
  ] as const;
  for (const [input, minutes] of cases) {
    const parsed = parseChineseReminder(input, now);
    assert.ok(parsed, input);
    assert.equal((new Date(parsed.scheduledAt).getTime() - now.getTime()) / 60_000, minutes, input);
  }
});

test("parses next-week weekday and evening", () => {
  const parsed = parseChineseReminder("下周五晚上8点提醒我交周报", now);
  assert.ok(parsed);
  const scheduled = new Date(parsed.scheduledAt);
  assert.equal(scheduled.getDay(), 5);
  assert.equal(scheduled.getDate(), 7);
  assert.equal(scheduled.getHours(), 20);
  assert.equal(parsed.title, "交周报");
});

test("parses natural Chinese clock expressions without leaking time into the title", () => {
  const cases = [
    ["明天下午三点提醒我开会", 30, 15, 0, "开会"],
    ["今晚八点半提醒我看直播", 29, 20, 30, "看直播"],
    ["明早八点提醒我吃药", 30, 8, 0, "吃药"],
    ["后天上午九点一刻提醒我出门", 31, 9, 15, "出门"],
  ] as const;
  for (const [input, day, hour, minute, title] of cases) {
    const parsed = parseChineseReminder(input, now);
    assert.ok(parsed, input);
    const scheduled = new Date(parsed.scheduledAt);
    assert.equal(scheduled.getDate(), day, input);
    assert.equal(scheduled.getHours(), hour, input);
    assert.equal(scheduled.getMinutes(), minute, input);
    assert.equal(parsed.title, title, input);
  }
});

test("chooses the earliest future occurrence for bare 12-hour clock times", () => {
  const sixPm = new Date(2026, 6, 30, 18, 0, 0, 0);
  const sevenPm = parseChineseReminder("7点提醒我喝水", sixPm);
  assert.ok(sevenPm);
  assert.equal(new Date(sevenPm.scheduledAt).getDate(), 30);
  assert.equal(new Date(sevenPm.scheduledAt).getHours(), 19);

  const sevenTwentyTwoPm = new Date(2026, 6, 30, 19, 22, 0, 0);
  const sevenThirtyPm = parseChineseReminder("七点半提醒我喝水", sevenTwentyTwoPm);
  assert.ok(sevenThirtyPm);
  assert.equal(new Date(sevenThirtyPm.scheduledAt).getDate(), 30);
  assert.equal(new Date(sevenThirtyPm.scheduledAt).getHours(), 19);
  assert.equal(new Date(sevenThirtyPm.scheduledAt).getMinutes(), 30);

  const eightPm = new Date(2026, 6, 30, 20, 0, 0, 0);
  const nextMorning = parseChineseReminder("7点提醒我喝水", eightPm);
  assert.ok(nextMorning);
  assert.equal(new Date(nextMorning.scheduledAt).getDate(), 31);
  assert.equal(new Date(nextMorning.scheduledAt).getHours(), 7);
});

test("parses explicit calendar dates and rejects invalid or expired dated reminders", () => {
  const parsed = parseChineseReminder("8月15日下午3点提醒我交材料", now);
  assert.ok(parsed);
  const scheduled = new Date(parsed.scheduledAt);
  assert.equal(scheduled.getFullYear(), 2026);
  assert.equal(scheduled.getMonth(), 7);
  assert.equal(scheduled.getDate(), 15);
  assert.equal(scheduled.getHours(), 15);
  assert.equal(parsed.title, "交材料");
  assert.equal(parseChineseReminder("2026年2月30日上午8点提醒我测试", now), null);
  assert.equal(parseChineseReminder("2025年8月1日上午8点提醒我测试", now), null);
});

test("parses conversational relative durations", () => {
  const oneAndHalf = parseChineseReminder("一个半小时后提醒我休息", now);
  const quarter = parseChineseReminder("过一刻钟后提醒我关火", now);
  assert.ok(oneAndHalf);
  assert.ok(quarter);
  assert.equal((new Date(oneAndHalf.scheduledAt).getTime() - now.getTime()) / 60_000, 90);
  assert.equal((new Date(quarter.scheduledAt).getTime() - now.getTime()) / 60_000, 15);
  assert.equal(oneAndHalf.title, "休息");
  assert.equal(quarter.title, "关火");
});

test("removes conversational waiting fillers from an exact-clock reminder title", () => {
  const now = new Date("2026-07-31T15:20:00+08:00");
  const parsed = parseChineseReminder("等下五点吃完饭", now);
  assert.ok(parsed);
  assert.equal(parsed.title, "吃晚饭");
  assert.equal(parsed.scheduledAt, new Date("2026-07-31T17:00:00+08:00").toISOString());
});

test("parses workday reminders and skips weekends", () => {
  const parsed = parseChineseReminder("工作日每天早上九点提醒我打卡", now);
  assert.ok(parsed);
  const scheduled = new Date(parsed.scheduledAt);
  assert.equal(parsed.repeatRule, "weekdays");
  assert.equal(parsed.repeatLabel, "工作日");
  assert.equal(parsed.title, "打卡");
  assert.equal(scheduled.getDay(), 4);
  assert.equal(scheduled.getHours(), 9);

  const fridayEvening = new Date(2026, 6, 31, 18, 0, 0, 0);
  const monday = parseChineseReminder("每周一至周五早上9点提醒我写日报", fridayEvening);
  assert.ok(monday);
  const next = new Date(monday.scheduledAt);
  assert.equal(next.getDay(), 1);
  assert.equal(next.getDate(), 3);
  assert.equal(monday.repeatRule, "weekdays");
  assert.equal(monday.title, "写日报");
});

test("parses monthly reminders including the last day of the month", () => {
  const rent = parseChineseReminder("每月31号上午九点提醒我交房租", now);
  const closing = parseChineseReminder("每个月最后一天下午六点提醒我月末结账", now);
  assert.ok(rent);
  assert.ok(closing);
  assert.equal(rent.repeatRule, "monthly:31");
  assert.equal(rent.repeatLabel, "每月31号");
  assert.equal(rent.title, "交房租");
  assert.equal(new Date(rent.scheduledAt).getDate(), 31);
  assert.equal(closing.repeatRule, "monthly:last");
  assert.equal(closing.title, "月末结账");
  assert.equal(new Date(closing.scheduledAt).getDate(), 31);
  assert.equal(parseChineseReminder("每月32号上午9点提醒我测试", now), null);
});

test("rejects invalid clock time", () => {
  assert.equal(parseChineseReminder("25点提醒我测试", now), null);
});

test("parses multiple reminders and inherits the date context", () => {
  const result = parseChineseReminders("明早8点喝水、10点开会", now);
  assert.equal(result.clarification, null);
  assert.equal(result.reminders.length, 2);
  assert.deepEqual(result.reminders.map((item) => item.title), ["喝水", "开会"]);
  assert.deepEqual(result.reminders.map((item) => new Date(item.scheduledAt).getDate()), [30, 30]);
  assert.deepEqual(result.reminders.map((item) => new Date(item.scheduledAt).getHours()), [8, 10]);
});

test("asks for an exact time when a period is ambiguous", () => {
  const result = parseChineseReminders("下午散步一小时", now);
  assert.equal(result.reminders.length, 0);
  assert.equal(result.clarification?.reason, "missing_exact_time");
  assert.match(result.clarification?.prompt || "", /下午几点/);
  const resolved = resolveReminderClarification(result.clarification!.originalInput, "下午4点", now);
  assert.ok(resolved);
  assert.equal(new Date(resolved.scheduledAt).getHours(), 16);
  assert.equal(resolved.title, "散步一小时");
});

test("asks instead of crashing or guessing for ambiguous clock ranges", () => {
  for (const input of ["下午三四点提醒我散步", "3到4点提醒我开会", "明天8点或9点提醒我开会", "明天八点还是九点开会"]) {
    const result = parseChineseReminders(input, now);
    assert.equal(result.reminders.length, 0);
    assert.equal(result.clarification?.reason, "ambiguous_time_range");
  }
});

test("asks for concrete dates and times for uncertain phrases", () => {
  const vagueTimes = ["晚点", "迟点", "过会", "过会儿", "过一会儿", "过几天", "改天", "月底", "月初", "周末", "有空时", "方便时", "忙完后"];
  const actions = ["散步", "喝水", "交社保", "吃药", "回电话", "交作业"];
  for (const vagueTime of vagueTimes) {
    for (const action of actions) {
      const input = `${vagueTime}提醒我${action}`;
      const result = parseChineseReminders(input, now);
      assert.equal(result.reminders.length, 0, input);
      assert.equal(result.clarification?.reason, "missing_exact_time", input);
    }
  }
});

test("asks for a missing title and accepts approximate clarification fillers", () => {
  const missingTitle = parseChineseReminders("差不多晚上八点吧", now);
  assert.equal(missingTitle.reminders.length, 0);
  assert.equal(missingTitle.clarification?.reason, "missing_title");
  assert.equal(isReminderClarificationAnswer("大概八点"), true);
  assert.equal(isReminderClarificationAnswer("差不多八点吧"), true);
  assert.equal(isReminderClarificationAnswer("八点多"), true);
  const dateOnly = parseChineseReminders("提醒8月1", new Date("2026-07-31T03:49:00+08:00"));
  assert.equal(dateOnly.clarification?.reason, "unrecognized");
  const resolvedDateOnly = resolveReminderClarification(dateOnly.clarification!.originalInput, "6点40", new Date("2026-07-31T03:49:00+08:00"));
  assert.ok(resolvedDateOnly);
  assert.equal(resolvedDateOnly.title, "新提醒");
  const resolvedTogether = resolveReminderClarification(dateOnly.clarification!.originalInput, "6点40交社保", new Date("2026-07-31T03:49:00+08:00"));
  assert.ok(resolvedTogether);
  assert.equal(resolvedTogether.title, "交社保");
  assert.equal(new Date(resolvedTogether.scheduledAt).getDate(), 1);
});

test("keeps asking when clarification replies are still vague", () => {
  const originalInput = "下午提醒我散步";
  for (const answer of ["晚点", "过会", "差不多吧", "三四点", "3点或4点", "到时候再说"]) {
    const step = resolveReminderClarificationStep(originalInput, answer, now);
    assert.equal(step.reminder, null, answer);
    assert.ok(step.clarification, answer);
  }

  const resolved = resolveReminderClarificationStep(originalInput, "4点", now);
  assert.ok(resolved.reminder);
  assert.equal(resolved.reminder.title, "散步");
  assert.equal(new Date(resolved.reminder.scheduledAt).getHours(), 16);

  const dated = resolveReminderClarificationStep("8月1提醒", "6点40交社保", new Date("2026-07-31T03:49:00+08:00"));
  assert.ok(dated.reminder);
  assert.equal(dated.reminder.title, "交社保");
  assert.equal(new Date(dated.reminder.scheduledAt).getDate(), 1);
});

test("rejects vague titles during repeated clarification", () => {
  for (const input of ["", "那个", "那个事", "那件事", "这个", "到时候再说", "回头再说", "随便", "都行", "照旧", "还没想好", "不知道", "8点", "明天下午3点", "晚点", "下午", "三四点"]) {
    assert.equal(isSpecificReminderTitle(input), false, input);
  }
  for (const input of ["交社保", "给妈妈打电话", "提醒大家都要戴口罩", "拿快递", "下午的会议材料"]) {
    assert.equal(isSpecificReminderTitle(input), true, input);
  }
});

test("fuzzes hundreds of ambiguous user phrases without unsafe creation", () => {
  const vagueTimes = ["晚点", "过会", "过几天", "月底", "周末", "有空时", "方便时", "忙完后"];
  const verbs = ["提醒我", "叫我", "记得提醒我", "到时提醒我"];
  const actions = ["喝水", "吃药", "交社保", "散步", "回电话", "交材料"];
  let checked = 0;
  for (const vagueTime of vagueTimes) {
    for (const verb of verbs) {
      for (const action of actions) {
        const input = `${vagueTime}${verb}${action}`;
        assert.doesNotThrow(() => parseChineseReminders(input, now), input);
        const result = parseChineseReminders(input, now);
        assert.equal(result.reminders.length, 0, input);
        assert.ok(result.clarification, input);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 192);
});

test("random malformed combinations never create placeholder reminders", () => {
  const fragments = ["提醒", "明天", "下午", "或者", "差不多", "月底", "8点", "吃饭", "？", " "];
  for (let index = 0; index < 500; index += 1) {
    const input = Array.from({ length: 1 + (index % 5) }, (_, offset) => fragments[(index * 7 + offset * 3) % fragments.length]).join("");
    assert.doesNotThrow(() => parseChineseReminders(input, now), input);
    const result = parseChineseReminders(input, now);
    assert.equal(result.reminders.some((item) => item.title === "新提醒"), false, input);
  }
});

test("asks for unsupported repetition and event-based times", () => {
  const repeat = parseChineseReminders("每周一三五晚上八点跑步", now);
  assert.equal(repeat.clarification?.reason, "unsupported_repeat");
  const event = parseChineseReminders("饭后提醒我吃药", now);
  assert.equal(event.clarification?.reason, "missing_exact_time");
  assert.match(event.clarification?.prompt || "", /饭后.*几点/);
});

test("invalid Chinese clock strings never throw", () => {
  assert.doesNotThrow(() => parseChineseReminder("九十九点提醒我测试", now));
  assert.equal(parseChineseReminder("九十九点提醒我测试", now), null);
});

test("only treats time-only messages as clarification answers", () => {
  assert.equal(isReminderClarificationAnswer("8点"), true);
  assert.equal(isReminderClarificationAnswer("晚上八点"), true);
  assert.equal(isReminderClarificationAnswer("明天晚上8点吧"), true);
  assert.equal(isReminderClarificationAnswer("晚上吃饭"), false);
  assert.equal(isReminderClarificationAnswer("明天8点吃饭"), false);
});

test("keeps the original reminder title and vague period after clarification", () => {
  const initial = parseChineseReminders("晚上吃饭", now);
  assert.ok(initial.clarification);
  const resolved = resolveReminderClarification(initial.clarification.originalInput, "8点", now);
  assert.ok(resolved);
  assert.equal(resolved.title, "吃饭");
  assert.equal(new Date(resolved.scheduledAt).getHours(), 20);
});

test("returns clear reminders before the first ambiguous segment", () => {
  const result = parseChineseReminders("明早8点喝水、10点开会、下午陪妈散步一小时", now);
  assert.equal(result.reminders.length, 2);
  assert.equal(result.clarification?.reason, "missing_exact_time");
  assert.match(result.clarification?.originalInput || "", /明天下午/);
});

test("creates a finite daily reminder after clarifying the missing time", () => {
  const initial = parseChineseReminders("下周一开始每天提醒我吃药，连续14天", now);
  assert.equal(initial.reminders.length, 0);
  assert.ok(initial.clarification);
  const parsed = resolveReminderClarification(initial.clarification.originalInput, "早上8点", now);
  assert.ok(parsed);
  assert.equal(parsed.repeatRule, "daily");
  assert.equal(parsed.title, "吃药");
  assert.match(parsed.repeatLabel, /连续14天/);
  assert.equal((new Date(parsed.repeatUntil!).getTime() - new Date(parsed.scheduledAt).getTime()) / 86_400_000, 13);
});

test("parses reminder edit commands", () => {
  assert.deepEqual(parseReminderEditCommand("把提醒2改到明天下午3点"), { target: "2", timeText: "明天下午3点" });
  assert.deepEqual(parseReminderEditCommand("修改提醒2 半小时后"), { target: "2", timeText: "半小时后" });
  assert.deepEqual(parseReminderEditCommand("把喝水提醒改到明天上午8点"), { target: "喝水", timeText: "明天上午8点" });
  assert.deepEqual(parseReminderEditCommand("把喝水改成喝咖啡"), { target: "喝水", titleText: "喝咖啡" });
  assert.deepEqual(parseReminderEditCommand("把提醒1改成喝咖啡"), { target: "1", titleText: "喝咖啡" });
  assert.deepEqual(parseReminderEditCommand("把散步改成八点"), { target: "散步", timeText: "八点" });
  assert.deepEqual(parseReminderEditCommand("喝水改到八点"), { target: "喝水", timeText: "八点" });
  assert.deepEqual(parseReminderEditCommand("喝水改成八点"), { target: "喝水", timeText: "八点" });
  assert.deepEqual(parseReminderEditCommand("把喝水挪到晚上八点"), { target: "喝水", timeText: "晚上八点" });
  assert.deepEqual(parseReminderEditCommand("喝水时间调到明早七点"), { target: "喝水", timeText: "明早七点" });
  assert.deepEqual(parseReminderEditCommand("喝水那个改八点"), { target: "喝水那个", timeText: "八点" });
  assert.deepEqual(parseReminderEditCommand("喝水往后推半小时"), { target: "喝水", timeText: "半小时后" });
  assert.deepEqual(parseReminderEditCommand("喝水改成喝咖啡"), { target: "喝水", titleText: "喝咖啡" });
});

test("resolves intelligent reminder edit targets and clarification replies", () => {
  const rows = [
    { id: "a", title: "陪妈妈散步" },
    { id: "b", title: "晚饭后散步" },
    { id: "c", title: "喝水" },
  ];
  assert.deepEqual(reminderTargetMatches(rows, "喝水"), [rows[2]]);
  assert.deepEqual(reminderTargetMatches(rows, "散步"), rows.slice(0, 2));
  assert.deepEqual(reminderTargetMatches(rows, "喝水那个"), [rows[2]]);
  assert.equal(parseReminderCandidateChoice("第二个", 2), 1);
  assert.equal(parseReminderCandidateChoice("3", 2), null);
  assert.equal(reminderEditTimeNeedsClarification("晚上"), true);
  assert.equal(reminderEditTimeNeedsClarification("晚上八点"), false);
  assert.equal(mergeReminderEditTimeClarification("明天晚上", "八点"), "明天晚上八点");
});

test("targets reminders by ordinal, date, period, and clock qualifiers", () => {
  const reference = new Date(2026, 6, 29, 18, 0, 0);
  const rows = [
    { id: "a", title: "喝水", scheduledAt: new Date(2026, 6, 30, 8, 0) },
    { id: "b", title: "喝水", scheduledAt: new Date(2026, 6, 30, 19, 0) },
    { id: "c", title: "陪妈妈散步", scheduledAt: new Date(2026, 6, 29, 20, 0) },
  ];
  assert.deepEqual(reminderTargetMatches(rows, "第一个", reference), [rows[0]]);
  assert.deepEqual(reminderTargetMatches(rows, "明天早上的喝水", reference), [rows[0]]);
  assert.deepEqual(reminderTargetMatches(rows, "明天晚上七点的喝水", reference), [rows[1]]);
});

test("keeps a bare edited clock near the existing reminder period", () => {
  const now = new Date(2026, 6, 30, 18, 0, 0);
  const current = new Date(2026, 6, 30, 19, 0, 0);
  assert.equal(resolveReminderEditTime("八点", current, "once", now)?.getHours(), 20);
  assert.equal(resolveReminderEditTime("八点", current, "once", now)?.getDate(), 30);
});

test("rejects incomplete reminder edit commands", () => {
  assert.equal(parseReminderEditCommand("修改提醒2"), null);
  assert.equal(parseReminderEditCommand("把提醒改到明天"), null);
});

test("parses conversational reminder cancellation commands", () => {
  assert.deepEqual(parseReminderCancelCommand("取消提醒2"), { target: "2" });
  assert.deepEqual(parseReminderCancelCommand("取消喝水"), { target: "喝水" });
  assert.deepEqual(parseReminderCancelCommand("删掉喝水"), { target: "喝水" });
  assert.deepEqual(parseReminderCancelCommand("把喝水取消掉"), { target: "喝水" });
  assert.deepEqual(parseReminderCancelCommand("喝水不要提醒了"), { target: "喝水" });
  assert.deepEqual(parseReminderCancelCommand("不要提醒我喝水"), { target: "喝水" });
  assert.equal(parseReminderCancelCommand("取消全部提醒"), null);
});

test("parses numbered menu choices", () => {
  assert.equal(parseNumberedMenuChoice("1"), 1);
  assert.equal(parseNumberedMenuChoice("选择2"), 2);
  assert.equal(parseNumberedMenuChoice("第三项"), 3);
  assert.equal(parseNumberedMenuChoice("六"), 6);
  assert.equal(parseNumberedMenuChoice("7"), null);
});

test("parses pause and resume commands", () => {
  assert.deepEqual(parseReminderStateCommand("暂停提醒2"), { action: "pause", target: "2" });
  assert.deepEqual(parseReminderStateCommand("停用提醒 吃药"), { action: "pause", target: "吃药" });
  assert.deepEqual(parseReminderStateCommand("恢复提醒1"), { action: "resume", target: "1" });
  assert.deepEqual(parseReminderStateCommand("先暂停喝水"), { action: "pause", target: "喝水" });
  assert.deepEqual(parseReminderStateCommand("喝水先别提醒"), { action: "pause", target: "喝水" });
  assert.deepEqual(parseReminderStateCommand("继续提醒喝水"), { action: "resume", target: "喝水" });
  assert.deepEqual(parseReminderStateCommand("恢复喝水提醒"), { action: "resume", target: "喝水" });
  assert.equal(parseReminderStateCommand("暂停提醒"), null);
});

test("finds the next future recurring occurrence without replaying missed periods", () => {
  const daily = nextFutureOccurrence(new Date("2026-07-20T00:00:00.000Z"), "daily", new Date("2026-07-29T12:00:00.000Z"));
  const weekly = nextFutureOccurrence(new Date("2026-07-01T12:00:00.000Z"), "weekly", new Date("2026-07-29T12:00:00.000Z"));
  assert.equal(daily?.toISOString(), "2026-07-30T00:00:00.000Z");
  assert.equal(weekly?.toISOString(), "2026-08-05T12:00:00.000Z");
  assert.equal(nextFutureOccurrence(now, "once", new Date(now.getTime() + 1)), null);
});

test("schedules the next workday occurrence after Friday", () => {
  const friday = new Date(2026, 6, 31, 9, 0, 0, 0);
  const after = new Date(2026, 6, 31, 10, 0, 0, 0);
  const next = nextFutureOccurrence(friday, "weekdays", after);
  assert.ok(next);
  assert.equal(next.getDay(), 1);
  assert.equal(next.getDate(), 3);
  assert.equal(next.getHours(), 9);
});

test("preserves the intended monthly day after shorter months", () => {
  const january31 = new Date(2027, 0, 31, 9, 0, 0, 0);
  const february = nextFutureOccurrence(january31, "monthly:31", new Date(2027, 0, 31, 10, 0, 0, 0));
  assert.ok(february);
  assert.equal(february.getMonth(), 1);
  assert.equal(february.getDate(), 28);
  const march = nextFutureOccurrence(february, "monthly:31", new Date(2027, 1, 28, 10, 0, 0, 0));
  assert.ok(march);
  assert.equal(march.getMonth(), 2);
  assert.equal(march.getDate(), 31);

  const lastDay = nextFutureOccurrence(january31, "monthly:last", new Date(2027, 0, 31, 10, 0, 0, 0));
  assert.equal(lastDay?.getDate(), 28);
});

test("parses snooze commands without consuming reminders that include a title", () => {
  const cases = [
    ["10分钟后再提醒我", 10],
    ["半小时后提醒我一下", 30],
    ["两小时之后再提醒我", 120],
    ["延后十五分钟", 15],
    ["稍后再提醒我", 10],
    ["五分钟后再叫我", 5],
    ["半小时以后提醒我", 30],
  ] as const;
  for (const [input, minutes] of cases) {
    const parsed = parseReminderSnoozeCommand(input, now);
    assert.ok(parsed, input);
    assert.equal((new Date(parsed.scheduledAt).getTime() - now.getTime()) / 60_000, minutes, input);
  }
  assert.equal(parseReminderSnoozeCommand("10分钟后提醒我喝水", now), null);
  assert.equal(parseReminderSnoozeCommand("稍后提醒我交材料", now), null);
});

test("finalizes an already-sent one-time reminder after an interrupted delivery", () => {
  const occurrenceAt = new Date("2026-07-29T07:00:00.000Z");
  assert.deepEqual(resolveDeliveryFinalization({
    status: "upcoming",
    repeatRule: "once",
    scheduledAt: occurrenceAt,
    occurrenceAt,
  }, now), { kind: "complete" });
});

test("advances an already-sent recurring reminder without replaying missed periods", () => {
  const occurrenceAt = new Date("2026-07-20T09:00:00.000Z");
  const result = resolveDeliveryFinalization({
    status: "upcoming",
    repeatRule: "daily",
    scheduledAt: occurrenceAt,
    occurrenceAt,
  }, new Date("2026-07-29T12:00:00.000Z"));
  assert.equal(result.kind, "advance");
  assert.equal(result.kind === "advance" ? result.scheduledAt.toISOString() : null, "2026-07-30T09:00:00.000Z");
});

test("completes a finite recurring reminder after its final occurrence", () => {
  const occurrenceAt = new Date("2026-08-12T00:00:00.000Z");
  assert.deepEqual(resolveDeliveryFinalization({
    status: "upcoming",
    repeatRule: "daily",
    scheduledAt: occurrenceAt,
    occurrenceAt,
    repeatUntil: occurrenceAt,
  }, occurrenceAt), { kind: "complete" });
});

test("does not finalize a cancelled, paused, completed, or rescheduled reminder", () => {
  const occurrenceAt = new Date("2026-07-29T07:00:00.000Z");
  for (const status of ["cancelled", "paused", "completed"] as const) {
    assert.deepEqual(resolveDeliveryFinalization({ status, repeatRule: "once", scheduledAt: occurrenceAt, occurrenceAt }, now), { kind: "noop" });
  }
  assert.deepEqual(resolveDeliveryFinalization({
    status: "upcoming",
    repeatRule: "once",
    scheduledAt: new Date(occurrenceAt.getTime() + 60_000),
    occurrenceAt,
  }, now), { kind: "noop" });
});

test("calculates and labels end-to-end delivery timing", () => {
  const scheduledAt = new Date("2026-07-29T07:00:00.000Z");
  assert.equal(deliveryLatencyMs(scheduledAt, new Date("2026-07-29T07:00:01.250Z")), 1_250);
  assert.equal(formatDeliveryTiming(1_250), "准时");
  assert.equal(formatDeliveryTiming(5_000), "准时");
  assert.equal(formatDeliveryTiming(5_001), "延迟 6 秒");
  assert.equal(formatDeliveryTiming(61_000), "延迟 2 分钟");
  assert.equal(deliveryLatencyMs(scheduledAt, null), null);
});
