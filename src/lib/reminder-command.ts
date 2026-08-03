import { parseChineseReminder } from "./reminder-parser";
import { nextFutureOccurrence } from "./reminder-schedule";

export type ReminderEditCommand = {
  target: string;
  timeText?: string;
  titleText?: string;
};

export type ReminderStateCommand = {
  action: "pause" | "resume";
  target: string;
};

export type ReminderCancelCommand = {
  target: string;
};

export type ReminderSnoozeCommand = {
  scheduledAt: string;
};

export type ReminderTargetCandidate = {
  id: string;
  title: string;
  scheduledAt?: Date | string;
  timezone?: string;
  repeatRule?: string;
};

const exactEditClockPattern = /(?:凌晨|早上|上午|中午|下午|晚上|今晚|明早|明晚)?\s*(?:\d{1,2}|[零一二两三四五六七八九十]+)(?:点(?:(?:半|一刻|三刻)|\s*(?:\d{1,2}|[零一二两三四五六七八九十]+)\s*分?)?|[:：]\s*\d{1,2})/;
const relativeEditTimePattern = /(?:半(?:个)?小时|一刻钟|(?:\d+|[一二两三四五六七八九十]+)\s*(?:个)?(?:分钟|小时|天|周|星期))(?:后|之后)/;
const vagueEditPeriodPattern = /(凌晨|早上|上午|中午|下午|晚上|今晚|明早|明晚)/;

function chineseNumber(value: string) {
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tens, units] = value.split("十");
    return (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0);
  }
  return digits[value];
}

function numberValue(value: string) {
  return /^\d+$/.test(value) ? Number(value) : chineseNumber(value);
}

export function parseReminderEditCommand(input: string): ReminderEditCommand | null {
  const text = input.trim().replace(/[!！。?？]+$/, "").trim();
  const postponed = text.match(/^(?:把|将)?\s*(.+?)(?:提醒)?\s*(?:往后推|往后延|推迟|延后)\s*(半(?:个)?小时|一刻钟|(?:\d+|[一二两三四五六七八九十]+)\s*(?:个)?(?:分钟|小时))$/);
  if (postponed?.[1] && postponed[2]) return { target: postponed[1].trim(), timeText: `${postponed[2].trim()}后` };
  const patterns = [
    /^(?:把)?提醒\s*(.+?)\s*(改到|改为|改成|修改到|修改为)\s*(.+)$/,
    /^(?:修改|更改)提醒\s*(.+?)\s+(.+)$/,
    /^把\s*(.+?)\s*提醒\s*(改到|改为|改成|修改到|修改为)\s*(.+)$/,
    /^把\s*(.+?)\s*(改为|改成)\s*(.+)$/,
    /^(?:把|将)\s*(.+?)(?:的)?(?:提醒)?(?:时间)?\s*(改到|修改到|调到|调整到|挪到|移到|换到|推迟到|延后到|改为|改成|调整为|改)\s*(.+)$/,
    /^(?!把|将|修改|更改|调整)(?!提醒(?:\s|改))(.+?)(?:的)?(?:提醒)?(?:时间)?\s*(改到|修改到|调到|调整到|挪到|移到|换到|推迟到|延后到|改为|改成|调整为|改)\s*(.+)$/,
  ];
  for (const [index, pattern] of patterns.entries()) {
    const match = text.match(pattern);
    if (!match) continue;
    const target = match[1].trim();
    const operation = index === 1 ? "修改" : match[2];
    const replacement = (index === 1 ? match[2] : match[3]).trim();
    if (!target || !replacement) continue;
    if (/^(?:提醒|这个提醒|那个提醒|这条提醒|时间)$/.test(target)) continue;
    const looksLikeTime = operation.includes("到") || /(?:今天|明天|后天|周|星期|凌晨|早上|上午|中午|下午|晚上|今晚|明早|明晚|晚点|晚一点|早点|早一点|一会|待会|\d{1,2}\s*[:：点]|[零一二两三四五六七八九十]+点|分钟后|小时后|天后)/.test(replacement);
    return looksLikeTime ? { target, timeText: replacement } : { target, titleText: replacement.replace(/^提醒我/, "").trim() };
  }
  return null;
}

export function parseReminderCancelCommand(input: string): ReminderCancelCommand | null {
  const text = input.trim().replace(/[!！。?？]+$/, "").trim();
  const patterns = [
    /^(?:取消|删除|删掉|删了|移除)(?:掉)?(?:提醒)?\s*(.+)$/,
    /^(?:把|将)\s*(.+?)(?:提醒)?\s*(?:取消|删除|删掉|移除)(?:掉)?$/,
    /^(.+?)(?:这个|那个|这条)?(?:提醒)?\s*(?:不要了|不用了|别提醒了|不要提醒了|取消掉|删掉)$/,
    /^不(?:要|再)提醒(?:我)?\s*(.+)$/,
  ];
  for (const pattern of patterns) {
    const target = text.match(pattern)?.[1]?.trim();
    if (!target || /^(?:全部|所有|我的全部|我的所有)(?:提醒)?$/.test(target)) continue;
    return { target };
  }
  return null;
}

export function reminderEditTimeNeedsClarification(input: string) {
  return !exactEditClockPattern.test(input) && !relativeEditTimePattern.test(input);
}

export function mergeReminderEditTimeClarification(originalTimeText: string, answer: string) {
  const exact = answer.match(exactEditClockPattern)?.[0] ?? answer.match(relativeEditTimePattern)?.[0];
  if (!exact) return null;
  if (/(?:今天|明天|后天|周|星期|\d{1,2}月\d{1,2})/.test(answer)) return answer.trim();
  const vague = originalTimeText.match(vagueEditPeriodPattern)?.[0];
  if (vague && !vagueEditPeriodPattern.test(exact)) return `${originalTimeText.replace(vague, "").trim()}${vague}${exact}`.trim();
  const dateOnly = originalTimeText.replace(vagueEditPeriodPattern, "").trim();
  return `${dateOnly}${exact}`.trim();
}

export function reminderTargetMatches<T extends ReminderTargetCandidate>(rows: T[], target: string, now = new Date()) {
  const ordinal = parseReminderCandidateChoice(target, rows.length);
  if (ordinal !== null) {
    const selected = rows[ordinal];
    return selected ? [selected] : [];
  }

  let candidates = rows;
  const dateQualifier = target.match(/今天|明天|后天/)?.[0];
  const periodQualifier = target.match(/凌晨|早上|上午|中午|下午|晚上|今晚|明早|明晚/)?.[0];
  const clockQualifier = target.match(/(\d{1,2}|[零一二两三四五六七八九十]+)点(?:(半|一刻|三刻)|(\d{1,2}|[零一二两三四五六七八九十]+)分?)?/) ?? null;
  if (dateQualifier || periodQualifier || clockQualifier) {
    candidates = rows.filter((item) => {
      if (!item.scheduledAt) return false;
      const scheduled = new Date(item.scheduledAt);
      if (Number.isNaN(scheduled.getTime())) return false;
      if (dateQualifier) {
        const expected = new Date(now);
        expected.setDate(expected.getDate() + (dateQualifier === "明天" ? 1 : dateQualifier === "后天" ? 2 : 0));
        if (scheduled.getFullYear() !== expected.getFullYear() || scheduled.getMonth() !== expected.getMonth() || scheduled.getDate() !== expected.getDate()) return false;
      }
      const hour = scheduled.getHours();
      if (periodQualifier) {
        const periodMatches = /凌晨/.test(periodQualifier) ? hour < 6
          : /早上|上午|明早/.test(periodQualifier) ? hour >= 5 && hour < 12
            : /中午/.test(periodQualifier) ? hour >= 11 && hour < 14
              : /下午/.test(periodQualifier) ? hour >= 12 && hour < 18
                : hour >= 18;
        if (!periodMatches) return false;
      }
      if (clockQualifier) {
        const expectedHour = numberValue(clockQualifier[1]);
        const expectedMinute = clockQualifier[2] === "半" ? 30 : clockQualifier[2] === "一刻" ? 15 : clockQualifier[2] === "三刻" ? 45 : clockQualifier[3] ? numberValue(clockQualifier[3]) : 0;
        const possibleHours = periodQualifier
          ? [(["下午", "晚上", "今晚", "明晚"].includes(periodQualifier) && expectedHour < 12) ? expectedHour + 12 : expectedHour]
          : expectedHour >= 1 && expectedHour <= 11 ? [expectedHour, expectedHour + 12] : [expectedHour];
        if (!possibleHours.includes(hour) || scheduled.getMinutes() !== expectedMinute) return false;
      }
      return true;
    });
  }

  const normalized = target
    .replace(/^提醒/, "")
    .replace(/(?:的)?(?:提醒)?(?:时间)?$/, "")
    .replace(/(?:那个|这个|这条)$/, "")
    .replace(/(?:今天|明天|后天|今晚|明早|明晚)/g, "")
    .replace(/(?:凌晨|早上|上午|中午|下午|晚上)/g, "")
    .replace(/(?:\d{1,2}|[零一二两三四五六七八九十]+)点(?:(?:半|一刻|三刻)|(?:\d{1,2}|[零一二两三四五六七八九十]+)分?)?/g, "")
    .replace(/^的|的$/g, "")
    .trim();
  if (!normalized) return candidates;
  const exact = candidates.filter((item) => item.title === normalized);
  if (exact.length) return exact;
  return candidates.filter((item) => item.title.includes(normalized));
}

export function parseReminderCandidateChoice(input: string, maximum: number) {
  const text = input.trim().replace(/[!！。?？]+$/, "").trim();
  const match = text.match(/^(?:第)?(\d+|[一二两三四五六七八九十]+)(?:个|条|项)?$/);
  if (!match) return null;
  const choice = numberValue(match[1]);
  return Number.isInteger(choice) && choice >= 1 && choice <= maximum ? choice - 1 : null;
}

export function parseNumberedMenuChoice(input: string) {
  const menuNumbers: Record<string, number> = { "0": 0, 零: 0, "1": 1, 一: 1, "2": 2, 二: 2, "3": 3, 三: 3, "4": 4, 四: 4, "5": 5, 五: 5, "6": 6, 六: 6 };
  const normalized = input.trim().replace(/^(?:选择|选|第)/, "").replace(/[.。项个条\s]/g, "");
  return menuNumbers[normalized] ?? null;
}

export function resolveReminderEditTime(timeText: string, currentScheduledAt: Date, repeatRule: string, now = new Date()) {
  if (reminderEditTimeNeedsClarification(timeText)) return null;
  const clockOnly = timeText.match(/^\s*(?:(凌晨|早上|上午|中午|下午|晚上|今晚|明早|明晚))?\s*(\d{1,2}|[零一二两三四五六七八九十]+)(?:点(?:(半|一刻|三刻)|\s*(\d{1,2}|[零一二两三四五六七八九十]+)\s*分?)?|[:：]\s*(\d{1,2}))\s*$/);
  if (!clockOnly) {
    const parsed = parseChineseReminder(timeText, now);
    return parsed ? new Date(parsed.scheduledAt) : null;
  }

  const period = clockOnly[1];
  let hour = numberValue(clockOnly[2]);
  const minute = clockOnly[3] === "半" ? 30 : clockOnly[3] === "一刻" ? 15 : clockOnly[3] === "三刻" ? 45 : clockOnly[4] ? numberValue(clockOnly[4]) : Number(clockOnly[5] || 0);
  if (hour > 23 || minute > 59) return null;
  if (["下午", "晚上", "今晚", "明晚"].includes(period) && hour < 12) hour += 12;
  if (period === "中午" && hour < 11) hour += 12;
  if (period === "凌晨" && hour === 12) hour = 0;
  const possibleHours = period ? [hour] : hour === 12 ? [0, 12] : hour >= 1 && hour <= 11 ? [hour, hour + 12] : [hour];
  const candidates = possibleHours.map((candidateHour) => {
    const candidate = new Date(currentScheduledAt);
    candidate.setHours(candidateHour, minute, 0, 0);
    return candidate;
  });
  const futureOnOriginalDate = candidates.filter((candidate) => candidate > now);
  let selected = (futureOnOriginalDate.length ? futureOnOriginalDate : candidates)
    .sort((left, right) => Math.abs(left.getTime() - currentScheduledAt.getTime()) - Math.abs(right.getTime() - currentScheduledAt.getTime()))[0];
  if (selected > now) return selected;
  if (repeatRule !== "once") return nextFutureOccurrence(selected, repeatRule, now);
  selected = new Date(selected);
  selected.setDate(selected.getDate() + 1);
  return selected;
}

export function parseReminderStateCommand(input: string): ReminderStateCommand | null {
  const text = input.trim().replace(/[!！。?？]+$/, "").trim();
  const leading = text.match(/^(?:先)?(暂停|停用|恢复|启用|继续)(?:提醒)?\s*(.+)$/);
  const trailing = text.match(/^(.+?)(?:先)?(别提醒|不要提醒|暂停提醒|继续提醒|恢复提醒|重新提醒)(?:了)?$/);
  const actionText = leading?.[1] ?? trailing?.[2];
  const target = (leading?.[2] ?? trailing?.[1])?.trim();
  const normalizedTarget = target?.replace(/^提醒\s*/, "").replace(/\s*提醒$/, "").trim();
  if (!actionText || !normalizedTarget) return null;
  return {
    action: /暂停|停用|别提醒|不要提醒/.test(actionText) ? "pause" : "resume",
    target: normalizedTarget,
  };
}

export function parseReminderSnoozeCommand(input: string, now = new Date()): ReminderSnoozeCommand | null {
  const text = input.trim().replace(/[!！。?？]+$/, "").trim();
  if (/^(?:稍后|等会(?:儿)?|过一会(?:儿)?)(?:再)?提醒我(?:一下|一次)?$/.test(text)) {
    return { scheduledAt: new Date(now.getTime() + 10 * 60_000).toISOString() };
  }

  const duration = "(?:半(?:个)?小时|(?:\\d+|[一二两三四五六七八九十]+)\\s*(?:个)?(?:分钟|小时))";
  const relative = text.match(new RegExp(`^(${duration})(?:后|之后|以后)(?:再)?(?:提醒|叫|通知)我(?:一下|一次)?$`));
  const postponed = text.match(new RegExp(`^(?:延后|推迟)\\s*(${duration})(?:(?:后|之后)?(?:再)?提醒我(?:一下|一次)?)?$`));
  const timeText = relative?.[1] ?? postponed?.[1];
  if (!timeText) return null;
  const parsed = parseChineseReminder(`${timeText}后提醒我`, now);
  return parsed ? { scheduledAt: parsed.scheduledAt } : null;
}
