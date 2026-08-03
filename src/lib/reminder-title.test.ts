import assert from "node:assert/strict";
import test from "node:test";
import { cleanAiReminderTitle } from "./reminder-title";

test("keeps only the actual reminder subject from conversational model titles", () => {
  assert.equal(cleanAiReminderTitle("帮我添加一个提醒提醒我等一下7:30看歌手", "今天19:30"), "看歌手");
  assert.equal(cleanAiReminderTitle("等一下10点钟看电影", "今天22:00"), "看电影");
  assert.equal(cleanAiReminderTitle("钟看电影", "今天22:00"), "看电影");
  assert.equal(cleanAiReminderTitle("都要交社保", "每月15日14:00"), "交社保");
  assert.equal(cleanAiReminderTitle("每周都要跑步", "每周一20:00"), "跑步");
  assert.equal(cleanAiReminderTitle("每天都得吃药", "每天08:00"), "吃药");
  assert.equal(cleanAiReminderTitle("提醒大家都要戴口罩", "明天08:00"), "提醒大家都要戴口罩");
});
