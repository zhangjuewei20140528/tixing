export function isReminderDomainMessage(text: string) {
  if (!text.trim() || text.length > 300) return false;
  return /提醒|日程|安排|取消|删除|删掉|修改|改到|改成|挪到|往后挪|往前挪|换到|延后|延迟|推迟|提前|暂停|恢复|继续提醒|完成了?|做完了?|已经.+了|撤销|改错了|不是这个意思|查看.*(?:提醒|日程|安排)/.test(text);
}

export function shouldUseAiForConversationalReminder(text: string) {
  if (!isReminderDomainMessage(text) && !/(?:\d{1,2}|[一二两三四五六七八九十]+)点|不是.+是/.test(text)) return false;
  return /等下(?!班)|等一下|等会儿?|待会儿?|一会儿?|到时候|吃完|做完|弄完|结束以后?|刚刚|刚才|那条|第[一二三四五六七八九十\d]+个|那件事|那个提醒|之前(?:说|建|设)的|接下来|连续|都要|每天|工作日|每周|每月|不是.+是/.test(text);
}
