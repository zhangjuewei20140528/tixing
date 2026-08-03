export type RepeatRule = "once" | "daily" | "weekdays" | "weekly" | `monthly:${number}` | "monthly:last";

export type ParsedReminder = {
  title: string;
  scheduledAt: string;
  repeatRule: RepeatRule;
  repeatLabel: string;
  repeatUntil: string | null;
};

export type ReminderClarification = {
  originalInput: string;
  prompt: string;
  reason: "missing_exact_time" | "ambiguous_time_range" | "missing_title" | "unsupported_repeat" | "unrecognized";
};

export type ParsedReminderBatch = {
  reminders: ParsedReminder[];
  clarification: ReminderClarification | null;
};

export type ReminderClarificationStep = {
  reminder: ParsedReminder | null;
  clarification: ReminderClarification | null;
};

const vaguePeriodPattern = /(凌晨|早上|上午|中午|下午|晚上|今晚|明早|明晚)/;
const exactClockPattern = /(?:凌晨|早上|上午|中午|下午|晚上|今晚|明早|明晚)?\s*(?:\d{1,2}|[零一二两三四五六七八九十]+)(?:点(?:(?:半|一刻|三刻)|\s*(?:\d{1,2}|[零一二两三四五六七八九十]+)\s*分?)?|[:：]\s*\d{1,2})/;
const relativeTimePattern = /(?:半(?:个)?小时|一刻钟|(?:\d+|[一二两三四五六七八九十]+)\s*(?:个)?(?:分钟|小时|天|周|星期))(?:后|之后)/;
const eventTimePattern = /(饭后|吃完饭后?|下班后|到家后|起床后|睡前)/;
const unsupportedRepeatPattern = /每隔\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:分钟|小时)|每(?:周|星期)[一二三四五六日天]{2,}/;
const uncertainTimePattern = /(晚点|迟点|过会儿?|过一会儿?|过几天|改天|月底|月初|周末|有空时?|方便时?|忙完后?)/;

function ambiguousTimeRange(input: string) {
  const alternatives = input.match(/(\d{1,2}|[一二两三四五六七八九十]+)\s*点\s*(?:或|或者|还是)\s*(\d{1,2}|[一二两三四五六七八九十]+)\s*点/);
  if (alternatives) return { full: alternatives[0], first: alternatives[1], second: alternatives[2] };
  const separated = input.match(/(\d{1,2}|[一二两三四五六七八九十]+)\s*(?:到|至|或|、|~|－|-)\s*(\d{1,2}|[一二两三四五六七八九十]+)\s*点/);
  if (separated) return { full: separated[0], first: separated[1], second: separated[2] };
  const compact = input.match(/([一二两三四五六七八九])([一二两三四五六七八九])点/);
  return compact ? { full: compact[0], first: compact[1], second: compact[2] } : null;
}

function exactTimePhrase(input: string) {
  return input.match(exactClockPattern)?.[0] ?? input.match(relativeTimePattern)?.[0] ?? null;
}

export function isReminderClarificationAnswer(input: string) {
  const phrase = exactTimePhrase(input);
  if (!phrase) return false;
  const remainder = input
    .replace(phrase, "")
    .replace(/(?:今天|明天|后天|今晚|明早|明晚)/g, "")
    .replace(/(?:差不多|大概|大约|约莫|估计|就|那就|定在|改成|安排在|可以|好的|好|行|吧|开始|左右|上下|多)/g, "")
    .replace(/[，,。.!！?？\s]/g, "");
  return remainder.length === 0;
}

export function isSpecificReminderTitle(input: string) {
  const title = input.replace(/^(?:提醒我|内容是|事项是)\s*/, "").replace(/[。.!！?？]+$/, "").trim();
  if (!title || isReminderClarificationAnswer(title)) return false;
  if (uncertainTimePattern.test(title) || ambiguousTimeRange(title) || /^(?:凌晨|早上|上午|中午|下午|晚上|今晚|明早|明晚|今天|明天|后天|以后|之后|再说)$/.test(title)) return false;
  return !/^(?:那个|那个事|那件事|这个|这件事|到时候再说|之后再说|回头再说|随便|都行|一样|照旧|还没想好|没想好|不知道|不确定|刚才那个|前面那个)$/.test(title);
}

function dateContext(input: string) {
  if (/明早|明晚|明天/.test(input)) return "明天";
  if (/后天/.test(input)) return "后天";
  if (/今晚|今天/.test(input)) return "今天";
  const calendar = input.match(/(?:(?:\d{4})年)?\d{1,2}月\d{1,2}(?:日|号)?/);
  if (calendar) return calendar[0];
  const weekday = input.match(/(?:下)?(?:周|星期)[一二三四五六日天]/);
  return weekday?.[0] ?? "";
}

function splitReminderSegments(input: string) {
  const raw = input.split(/[、，,；;\n]+/).map((item) => item.trim().replace(/[。.!！]+$/, "")).filter(Boolean).reduce<string[]>((items, segment) => {
    if (/^连续\s*(?:\d+|[一二两三四五六七八九十]+)\s*天$/.test(segment) && items.length) items[items.length - 1] = `${items[items.length - 1]}，${segment}`;
    else items.push(segment);
    return items;
  }, []);
  if (raw.length <= 1) return raw;
  let inheritedDate = "";
  return raw.map((segment) => {
    const ownDate = dateContext(segment);
    if (ownDate) inheritedDate = ownDate;
    if (!ownDate && inheritedDate && (exactClockPattern.test(segment) || vaguePeriodPattern.test(segment))) return `${inheritedDate}${segment}`;
    return segment;
  });
}

function clarificationFor(segment: string): ReminderClarification {
  const range = ambiguousTimeRange(segment);
  if (range) {
    return {
      originalInput: segment,
      reason: "ambiguous_time_range",
      prompt: `你说的是${range.first}点还是${range.second}点？请选一个准确时间。`,
    };
  }
  if (unsupportedRepeatPattern.test(segment)) {
    return {
      originalInput: segment,
      reason: "unsupported_repeat",
      prompt: "这个重复方式我还不能准确执行。目前支持每天、工作日、每周某一天或每月某一天。请换一种说法，例如“每个工作日早上8点提醒我喝水”。",
    };
  }
  const uncertain = segment.match(uncertainTimePattern)?.[0];
  if (uncertain) {
    return {
      originalInput: segment,
      reason: "missing_exact_time",
      prompt: `“${uncertain}”还不够准确。请告诉我具体日期和时间，例如“明天下午3点”。`,
    };
  }
  const event = segment.match(eventTimePattern)?.[0];
  if (event && !exactTimePhrase(segment)) {
    const title = segment.replace(eventTimePattern, "").replace(/提醒我|提醒/g, "").trim() || "这件事";
    return {
      originalInput: segment,
      reason: "missing_exact_time",
      prompt: `我知道你想在“${event}”安排“${title}”。${event}大概是几点？例如回复“晚上7点”。`,
    };
  }
  const period = segment.match(vaguePeriodPattern)?.[0];
  if (period && !exactTimePhrase(segment)) {
    const title = segment.replace(period, "").replace(/提醒我|提醒/g, "").trim() || "这件事";
    return {
      originalInput: segment,
      reason: "missing_exact_time",
      prompt: `我知道你想安排“${title}”，还需要一个准确时间。${period}几点开始？例如回复“${period === "下午" ? "下午4点" : `${period}8点`}”。`,
    };
  }
  return {
    originalInput: segment,
    reason: "unrecognized",
    prompt: "我还没有确认具体提醒时间。请补充日期和时间，例如“明天下午3点”。",
  };
}

export function parseChineseReminders(input: string, now = new Date()): ParsedReminderBatch {
  const parsedItems: ParsedReminder[] = [];
  for (const segment of splitReminderSegments(input)) {
    if (unsupportedRepeatPattern.test(segment) || ambiguousTimeRange(segment) || uncertainTimePattern.test(segment) || (eventTimePattern.test(segment) && !exactTimePhrase(segment))) {
      return { reminders: parsedItems, clarification: clarificationFor(segment) };
    }
    if (!exactTimePhrase(segment) && vaguePeriodPattern.test(segment)) return { reminders: parsedItems, clarification: clarificationFor(segment) };
    const parsed = parseChineseReminder(segment, now);
    if (!parsed) return { reminders: parsedItems, clarification: clarificationFor(segment) };
    if (parsed.title === "新提醒") {
      return {
        reminders: parsedItems,
        clarification: {
          originalInput: segment,
          reason: "missing_title",
          prompt: `时间我记住了：${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(parsed.scheduledAt))}。要提醒你做什么？`,
        },
      };
    }
    parsedItems.push(parsed);
  }
  return { reminders: parsedItems, clarification: null };
}

export function resolveReminderClarification(originalInput: string, answer: string, now = new Date()) {
  const phrase = exactTimePhrase(answer);
  if (!phrase) return null;
  const range = ambiguousTimeRange(originalInput);
  if (range) return parseChineseReminder(originalInput.replace(range.full, phrase), now);
  const event = originalInput.match(eventTimePattern)?.[0];
  if (event) return parseChineseReminder(originalInput.replace(event, phrase), now);
  const vague = originalInput.match(vaguePeriodPattern)?.[0];
  let resolved = originalInput;
  if (vague) {
    const replacement = vaguePeriodPattern.test(phrase) ? phrase : `${vague}${phrase}`;
    resolved = originalInput.replace(vague, replacement);
  } else {
    resolved = `${originalInput}，${phrase}`;
  }
  const parsed = parseChineseReminder(resolved, now);
  if (parsed?.title !== "新提醒") return parsed;
  const answerWithTitle = parseChineseReminder(answer, now);
  if (!answerWithTitle || answerWithTitle.title === "新提醒") return parsed;
  return parseChineseReminder(`${originalInput}，${answer}`, now);
}

export function resolveReminderClarificationStep(originalInput: string, answer: string, now = new Date()): ReminderClarificationStep {
  const range = ambiguousTimeRange(answer);
  if (range) {
    return {
      reminder: null,
      clarification: {
        originalInput,
        reason: "ambiguous_time_range",
        prompt: `你回复的是${range.first}点还是${range.second}点？请只选一个准确时间。`,
      },
    };
  }
  const uncertain = answer.match(uncertainTimePattern)?.[0];
  if (uncertain) {
    return {
      reminder: null,
      clarification: {
        originalInput,
        reason: "missing_exact_time",
        prompt: `“${uncertain}”还是比较模糊，请给我一个具体钟点，例如“下午4点”。`,
      },
    };
  }
  const reminder = resolveReminderClarification(originalInput, answer, now);
  if (reminder) return { reminder, clarification: null };
  return {
    reminder: null,
    clarification: {
      originalInput,
      reason: "missing_exact_time",
      prompt: "我还没拿到准确钟点。请回复例如“下午4点”或“明天上午9点”。",
    },
  };
}

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

function earliestBareClockOnDate(date: Date, hour: number, minute: number, now: Date) {
  const candidateHours = hour === 12 ? [0, 12] : hour >= 1 && hour <= 11 ? [hour, hour + 12] : [hour];
  const candidates = candidateHours.map((candidateHour) => {
    const candidate = new Date(date);
    candidate.setHours(candidateHour, minute, 0, 0);
    return candidate;
  });
  return candidates.find((candidate) => candidate > now) ?? candidates[0];
}

export function parseChineseReminder(input: string, now = new Date()): ParsedReminder | null {
  let date = new Date(now);
  let repeatRule: RepeatRule = "once";
  let repeatLabel = "仅一次";
  let repeatUntil: Date | null = null;
  let matchedTime = false;
  let matchedRelativeText = "";
  let matchedClockText = "";
  let matchedCalendarText = "";
  let calendarHasYear = false;
  const weekdaysRepeat = /每(?:个)?工作日|工作日每天|工作日(?:早上|上午|下午|晚上)|每周一(?:到|至)周?五/.test(input);
  const monthlyDay = input.match(/每(?:个)?月(?:的)?\s*(\d{1,2})(?:日|号)/);
  const monthlyLastDay = /每(?:个)?月(?:的)?最后一天/.test(input);
  if (monthlyDay && (Number(monthlyDay[1]) < 1 || Number(monthlyDay[1]) > 31)) return null;

  const oneAndHalfHoursLater = input.match(/(?:过)?(\d+|[一二两三四五六七八九十]+)\s*(?:个)?半小时(?:后|之后)/);
  const halfHourLater = input.match(/(?:过)?半(?:个)?小时(?:后|之后)/);
  const quarterHourLater = input.match(/(?:过)?一刻钟(?:后|之后)/);
  const minutesLater = input.match(/(?:过)?(\d+|[一二两三四五六七八九十]+)\s*(?:个)?分钟(?:后|之后)/);
  const hoursLater = input.match(/(?:过)?(\d+|[一二两三四五六七八九十]+)\s*(?:个)?小时(?:后|之后)/);
  const daysLater = input.match(/(?:过)?(\d+|[一二两三四五六七八九十]+)\s*(?:个)?天(?:后|之后)/);
  const weeksLater = input.match(/(?:过)?(\d+|[一二两三四五六七八九十]+)\s*(?:个)?(?:周|星期)(?:后|之后)/);
  if (oneAndHalfHoursLater) {
    const amount = numberValue(oneAndHalfHoursLater[1]);
    date = new Date(now.getTime() + (amount + 0.5) * 3_600_000);
    matchedRelativeText = oneAndHalfHoursLater[0];
    matchedTime = true;
  } else if (halfHourLater) {
    date = new Date(now.getTime() + 30 * 60_000);
    matchedRelativeText = halfHourLater[0];
    matchedTime = true;
  } else if (quarterHourLater) {
    date = new Date(now.getTime() + 15 * 60_000);
    matchedRelativeText = quarterHourLater[0];
    matchedTime = true;
  } else if (minutesLater) {
    const amount = numberValue(minutesLater[1]);
    date = new Date(now.getTime() + amount * 60_000);
    matchedRelativeText = minutesLater[0];
    matchedTime = true;
  } else if (hoursLater) {
    const amount = numberValue(hoursLater[1]);
    date = new Date(now.getTime() + amount * 3_600_000);
    matchedRelativeText = hoursLater[0];
    matchedTime = true;
  } else {
    if (daysLater) {
      const amount = numberValue(daysLater[1]);
      date.setDate(date.getDate() + amount);
      date.setSeconds(0, 0);
      matchedRelativeText = daysLater[0];
      matchedTime = true;
    } else if (weeksLater) {
      const amount = numberValue(weeksLater[1]);
      date.setDate(date.getDate() + amount * 7);
      date.setSeconds(0, 0);
      matchedRelativeText = weeksLater[0];
      matchedTime = true;
    } else {
      const calendar = input.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})(?:日|号)?/);
      if (calendar) {
        const year = calendar[1] ? Number(calendar[1]) : date.getFullYear();
        const month = Number(calendar[2]);
        const day = Number(calendar[3]);
        date.setFullYear(year, month - 1, 1);
        date.setDate(day);
        if (month < 1 || month > 12 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
        matchedCalendarText = calendar[0];
        calendarHasYear = Boolean(calendar[1]);
      } else if (/后天/.test(input)) {
        date.setDate(date.getDate() + 2);
      } else if (/明天|明早|明晚/.test(input)) {
        date.setDate(date.getDate() + 1);
      }
    }

    const weekday = matchedCalendarText || weekdaysRepeat ? null : input.match(/(下)?(?:周|星期)([一二三四五六日天])/);
    if (weekday) {
      const map: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
      const target = map[weekday[2]];
      const currentDay = date.getDay();
      const delta = weekday[1]
        ? 7 - ((currentDay + 6) % 7) + ((target + 6) % 7)
        : (target - currentDay + 7) % 7 || 7;
      date.setDate(date.getDate() + delta);
    }

    const clockNumber = "(?:\\d{1,2}|[零一二两三四五六七八九十]+)";
    const time = input.match(new RegExp(`(?:(凌晨|早上|上午|中午|下午|晚上|今晚|明早|明晚))?\\s*(${clockNumber})(?:点(?:(半|一刻|三刻)|\\s*(${clockNumber})\\s*分?)?|[:：]\\s*(\\d{1,2}))`));
    if (time) {
      let hour = numberValue(time[2]);
      const minute = time[3] === "半" ? 30 : time[3] === "一刻" ? 15 : time[3] === "三刻" ? 45 : time[4] ? numberValue(time[4]) : Number(time[5] || 0);
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
      if (["下午", "晚上", "今晚", "明晚"].includes(time[1]) && hour < 12) hour += 12;
      if (time[1] === "中午" && hour < 11) hour += 12;
      if (time[1] === "凌晨" && hour === 12) hour = 0;
      if (hour > 23 || minute > 59) return null;
      date = time[1] ? new Date(date.setHours(hour, minute, 0, 0)) : earliestBareClockOnDate(date, hour, minute, now);
      matchedClockText = time[0];
      matchedTime = true;
    } else if (/明早|早上|上午/.test(input)) {
      date.setHours(8, 0, 0, 0);
      matchedTime = true;
    } else if (/下午/.test(input)) {
      date.setHours(15, 0, 0, 0);
      matchedTime = true;
    } else if (/明晚|晚上|今晚/.test(input)) {
      date.setHours(20, 0, 0, 0);
      matchedTime = true;
    }
  }

  if (/每天/.test(input)) {
    repeatRule = "daily";
    repeatLabel = "每天";
  }
  const weekly = input.match(/每(?:周|星期)([一二三四五六日天])/);
  if (monthlyLastDay || monthlyDay) {
    repeatRule = monthlyLastDay ? "monthly:last" : `monthly:${Number(monthlyDay![1])}`;
    repeatLabel = monthlyLastDay ? "每月最后一天" : `每月${Number(monthlyDay![1])}号`;
  } else if (weekdaysRepeat) {
    repeatRule = "weekdays";
    repeatLabel = "工作日";
  } else if (weekly) {
    repeatRule = "weekly";
    repeatLabel = `每周${weekly[1] === "天" ? "日" : weekly[1]}`;
  }

  if (!matchedTime) return null;
  if (repeatRule.startsWith("monthly:")) {
    const desiredDay = repeatRule === "monthly:last" ? null : Number(repeatRule.slice("monthly:".length));
    const setMonthlyDay = () => {
      date.setDate(1);
      const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      date.setDate(desiredDay === null ? lastDay : Math.min(desiredDay, lastDay));
    };
    setMonthlyDay();
    if (date <= now) {
      date.setMonth(date.getMonth() + 1, 1);
      setMonthlyDay();
    }
  }
  if (date <= now && !matchedRelativeText) {
    if (matchedCalendarText && calendarHasYear) return null;
    if (matchedCalendarText) date.setFullYear(date.getFullYear() + 1);
    else date.setDate(date.getDate() + 1);
  }
  if (repeatRule === "weekdays") {
    while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
  }

  const finiteDays = input.match(/连续\s*(\d+|[一二两三四五六七八九十]+)\s*天/);
  if (finiteDays && repeatRule !== "once") {
    const occurrences = numberValue(finiteDays[1]);
    if (!occurrences || occurrences < 1 || occurrences > 365) return null;
    repeatUntil = new Date(date);
    let remaining = occurrences - 1;
    while (remaining > 0) {
      repeatUntil.setDate(repeatUntil.getDate() + 1);
      if (repeatRule !== "weekdays" || (repeatUntil.getDay() !== 0 && repeatUntil.getDay() !== 6)) remaining -= 1;
    }
    repeatLabel = `${repeatLabel}，连续${occurrences}天`;
  }

  let title = input
    .replace(matchedRelativeText, "")
    .replace(matchedClockText, "")
    .replace(matchedCalendarText, "")
    .replace(/提醒我|提醒/g, "")
    .replace(/(?:再)?(?:叫|通知)我/g, "")
    .replace(/(?:过)?(?:\d+|[一二两三四五六七八九十]+)\s*(?:个)?半小时(?:后|之后)/g, "")
    .replace(/半(?:个)?小时(?:后|之后)/g, "")
    .replace(/一刻钟(?:后|之后)/g, "")
    .replace(/(?:\d+|[一二两三四五六七八九十]+)\s*(?:个)?(?:分钟|小时)(?:后|之后)/g, "")
    .replace(/(?:\d+|[一二两三四五六七八九十]+)\s*(?:个)?(?:天|周|星期)(?:后|之后)/g, "")
    .replace(/(?:明天|后天|今天|明早|明晚)/g, "")
    .replace(/(?:(?:\d{4})年)?\d{1,2}月\d{1,2}(?:日|号)?/g, "")
    .replace(/每(?:个)?月(?:的)?(?:\s*\d{1,2}(?:日|号)|最后一天)/g, "")
    .replace(/(?:每(?:个)?工作日|工作日每天|工作日|每周一(?:到|至)周?五)/g, "")
    .replace(/(?:每|下)?(?:周|星期)[一二三四五六日天]/g, "")
    .replace(/每天/g, "")
    .replace(/连续\s*(?:\d+|[一二两三四五六七八九十]+)\s*天/g, "")
    .replace(/开始/g, "")
    .replace(/(?:(?:凌晨|早上|上午|中午|下午|晚上|今晚))?\s*\d{1,2}(?:点|[:：])\d{0,2}/g, "")
    .replace(/(?:凌晨|早上|上午|中午|下午|晚上|今晚|明早|明晚)/g, "")
    .replace(/(?:差不多|大概|大约|约莫|估计|左右|上下|吧)/g, "")
    .trim();
  title = title.replace(/^(?:等下(?!班)|等一下|等会儿?|待会儿?|一会儿?|到时候)\s*/, "");
  if (title === "吃完饭" && date.getHours() >= 16 && date.getHours() <= 20) title = "吃晚饭";
  title = title.replace(/^[，,。\s]+|[，,。\s]+$/g, "") || "新提醒";

  return { title, scheduledAt: date.toISOString(), repeatRule, repeatLabel, repeatUntil: repeatUntil?.toISOString() || null };
}
