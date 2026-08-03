export function cleanAiReminderTitle(title: string, timeText: string) {
  const cleaned = title
    .replace(/^(?:帮我)?(?:添加|新增|创建)(?:一个)?提醒(?:提醒我)?/i, "")
    .replace(/^提醒我/, "")
    .replace(/^(?:等一下|等会儿|待会儿|一会儿)/, "")
    .replace(/^(?:(?:每次|每回|每个月|每月|每天|每日|每周|每星期|每个工作日)?(?:都|也)(?:要|得|需要)|(?:每次|每回)(?:要|得|需要))\s*/, "")
    .replace(/(?:今天|明天|后天|早上|上午|中午|下午|晚上|今晚|明早|明晚)?\s*\d{1,2}(?::\d{1,2})?(?:点钟?|时)?(?:\s*\d{1,2}分)?/g, "")
    .replace(timeText, "")
    .replace(/^钟(?=\S)/, "")
    .trim();
  return cleaned || title.trim();
}
