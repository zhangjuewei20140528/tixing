"use client";

import {
  AlarmClock,
  ArrowRight,
  Bell,
  BellRing,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Crown,
  Link2,
  LogOut,
  Menu,
  MessageCircle,
  Mic,
  MoreHorizontal,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Settings,
  Send,
  Smile,
  Smartphone,
  Sprout,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { parseChineseReminder, parseChineseReminders, type ParsedReminder } from "@/lib/reminder-parser";
import { formatDeliveryTiming, ON_TIME_THRESHOLD_MS } from "@/lib/delivery-timing";
import { isVipActive, membershipLabel, membershipStatusText } from "@/lib/membership";
import { reminderOccurrenceOnDate } from "@/lib/reminder-calendar";
import AdminDashboard from "./admin-dashboard";


type ReminderStatus = "upcoming" | "completed" | "cancelled" | "paused";
type Filter = "upcoming" | "paused" | "completed" | "all";
type WorkspaceView = "reminders" | "calendar" | "deliveries";
type DeliveryFilter = "all" | "sent" | "problem";
type BindStep = "idle" | "generating" | "waiting" | "scanned" | "verification" | "verification_blocked" | "connected" | "expired" | "already_bound" | "error";
type TestDeliveryState = "idle" | "queueing" | "queued" | "sent" | "failed" | "blocked" | "timeout";
type BindingStatus = "active" | "pending" | "offline" | "expired" | "revoked" | null;
type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  timezone?: string;
  role: "user" | "admin";
  vipType: "none" | "monthly" | "permanent";
  vipExpiresAt: string | null;
  reminderLimitOverride?: number | null;
  reminderLimit: number;
};

type ReminderQuota = { activeCount: number; limit: number; remaining: number };

type Reminder = {
  id: string;
  title: string;
  scheduledAt: string;
  repeat: string;
  repeatRule: string;
  repeatUntil: string | null;
  status: ReminderStatus;
  createdAt: string;
};

type DeliveryAttempt = {
  id: string;
  reminderId: string;
  title: string;
  status: "pending" | "sent" | "failed" | "blocked";
  attempt: number;
  scheduledAt: string;
  sentAt: string | null;
  providerMessageId: string | null;
  errorCode: string | null;
  latencyMs: number | null;
};

function fromApiReminder(item: { id: string; title: string; scheduledAt: string; repeatRule: string; repeatUntil: string | null; status: ReminderStatus; createdAt: string }): Reminder {
  const repeat = item.repeatRule === "daily" ? "每天" : item.repeatRule === "weekdays" ? "工作日" : item.repeatRule === "weekly" ? "每周" : item.repeatRule === "monthly:last" ? "每月最后一天" : item.repeatRule.startsWith("monthly:") ? `每月${item.repeatRule.slice(8)}号` : "仅一次";
  return { id: item.id, title: item.title, scheduledAt: item.scheduledAt, repeat, repeatRule: item.repeatRule, repeatUntil: item.repeatUntil, status: item.status, createdAt: item.createdAt };
}

function formatDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const prefix = sameDay(date, today) ? "今天" : sameDay(date, tomorrow) ? "明天" : `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${prefix} ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

export default function Home() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authMethod, setAuthMethod] = useState<"wechat" | "password">("wechat");
  const [authOpen, setAuthOpen] = useState(false);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authWechatStep, setAuthWechatStep] = useState<BindStep>("idle");
  const [authWechatSessionId, setAuthWechatSessionId] = useState("");
  const [authWechatQrValue, setAuthWechatQrValue] = useState("");
  const [authWechatVerifyCode, setAuthWechatVerifyCode] = useState("");
  const [authWechatPollVersion, setAuthWechatPollVersion] = useState(0);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryAttempt[]>([]);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("reminders");
  const [deliveryFilter, setDeliveryFilter] = useState<DeliveryFilter>("all");
  const [filter, setFilter] = useState<Filter>("upcoming");
  const [query, setQuery] = useState("");
  const [composer, setComposer] = useState("");
  const [composerClarification, setComposerClarification] = useState("");
  const [composerInterpreting, setComposerInterpreting] = useState(false);
  const [preview, setPreview] = useState<ParsedReminder[]>([]);
  const [quota, setQuota] = useState<ReminderQuota>({ activeCount: 0, limit: 1, remaining: 1 });
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [bindOpen, setBindOpen] = useState(false);
  const [membershipOpen, setMembershipOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [bindStep, setBindStep] = useState<BindStep>("idle");
  const [bound, setBound] = useState(false);
  const [bindingStatus, setBindingStatus] = useState<BindingStatus>(null);
  const [bindingSessionId, setBindingSessionId] = useState("");
  const [bindingQrValue, setBindingQrValue] = useState("");
  const [bindingPollVersion, setBindingPollVersion] = useState(0);
  const [testDeliveryState, setTestDeliveryState] = useState<TestDeliveryState>("idle");
  const [toast, setToast] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [editingReminder, setEditingReminder] = useState<Reminder | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDateTime, setEditDateTime] = useState("");
  const [editMinimum, setEditMinimum] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  useEffect(() => {
    async function restoreSession() {
      const response = await fetch("/api/auth/me");
      if (!response.ok) return;
      const data = await response.json();
      if (!data.user) return;
      setSessionUser(data.user);
      setLoggedIn(true);
      if (data.user.role !== "admin") await Promise.all([loadReminders(), loadBinding()]);
    }
    void restoreSession();
  }, []);

  async function loadReminders() {
    const response = await fetch("/api/reminders");
    if (!response.ok) return;
    const data = await response.json();
    setReminders(data.reminders.map(fromApiReminder));
    if (data.quota) setQuota(data.quota);
  }

  async function loadBinding() {
    const response = await fetch("/api/bindings");
    if (!response.ok) return;
    const data = await response.json();
    const status = (data.binding?.status || null) as BindingStatus;
    setBindingStatus(status);
    setBound(status === "active");
  }

  async function loadDeliveries() {
    const response = await fetch("/api/deliveries", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    setDeliveries(data.attempts);
  }

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (authOpen && authMethod === "wechat" && !authWechatSessionId && authWechatStep === "idle") void startWechatAuth();
  }, [authOpen, authMethod, authWechatSessionId, authWechatStep]);

  useEffect(() => {
    if (!loggedIn || sessionUser?.role === "admin") return;
    const refresh = () => document.visibilityState === "visible" && void Promise.all([loadBinding(), workspaceView === "deliveries" ? loadDeliveries() : loadReminders()]);
    const timer = window.setInterval(refresh, 10_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loggedIn, workspaceView, sessionUser?.role]);

  useEffect(() => {
    if (!bindOpen || !bindingSessionId) return;
    const controller = new AbortController();
    async function poll() {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`/api/bindings/sessions/${bindingSessionId}`, { signal: controller.signal, cache: "no-store" });
          const data = await response.json();
          if (!response.ok) { setBindStep("error"); return; }
          const next = data.status as BindStep;
          setBindStep(next);
          if (["connected", "expired", "verification", "verification_blocked", "already_bound"].includes(next)) {
            if (next === "connected") { setBound(true); setBindingStatus("active"); setToast("微信绑定成功"); }
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, next === "scanned" ? 500 : 1000));
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "AbortError")) setBindStep("error");
          return;
        }
      }
    }
    void poll();
    return () => controller.abort();
  }, [bindOpen, bindingSessionId, bindingPollVersion]);

  useEffect(() => {
    if (!authOpen || authMethod !== "wechat" || !authWechatSessionId) return;
    const controller = new AbortController();
    async function pollWechatAuth() {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`/api/auth/wechat/sessions/${authWechatSessionId}`, { signal: controller.signal, cache: "no-store" });
          const data = await response.json();
          if (!response.ok) { setAuthWechatStep("error"); setToast(data.error || "微信登录失败"); return; }
          const next = data.status as BindStep;
          setAuthWechatStep(next);
          if (next === "connected" && data.user) {
            setSessionUser(data.user);
            setLoggedIn(true);
            setBound(true);
            setBindingStatus("active");
            setAuthOpen(false);
            await Promise.all([loadReminders(), loadBinding()]);
            setToast(data.created ? "微信注册成功，已自动登录" : "微信登录成功");
            return;
          }
          if (["expired", "verification", "verification_blocked"].includes(next)) return;
          await new Promise((resolve) => window.setTimeout(resolve, next === "scanned" ? 500 : 1000));
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "AbortError")) setAuthWechatStep("error");
          return;
        }
      }
    }
    void pollWechatAuth();
    return () => controller.abort();
  }, [authOpen, authMethod, authWechatSessionId, authWechatPollVersion]);

  const visible = useMemo(() => reminders.filter((item) => {
    const statusMatch = filter === "all" || item.status === filter;
    return statusMatch && item.title.toLowerCase().includes(query.toLowerCase());
  }).sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()), [reminders, filter, query]);

  const counts = {
    upcoming: reminders.filter((r) => r.status === "upcoming").length,
    paused: reminders.filter((r) => r.status === "paused").length,
    completed: reminders.filter((r) => r.status === "completed").length,
  };

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const username = String(formData.get("username") || "").trim();
    const password = String(formData.get("password") || "");
    const confirmPassword = String(formData.get("confirmPassword") || "");
    const displayName = String(formData.get("displayName") || "").trim();
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) return setToast("用户名需为 3-32 位字母、数字或下划线");
    if (password.length < 8) return setToast("密码至少需要 8 位");
    if (authMode === "register" && !displayName.trim()) return setToast("请输入昵称");
    if (authMode === "register" && password !== confirmPassword) return setToast("两次输入的密码不一致");

    setAuthSubmitting(true);
    try {
      const response = await fetch(`/api/auth/${authMode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, displayName }),
      });
      const data = await response.json();
      if (!response.ok) return setToast(data.error || (authMode === "register" ? "注册失败" : "登录失败"));
      setSessionUser(data.user);
      setLoggedIn(true);
      if (data.user.role !== "admin") await Promise.all([loadReminders(), loadBinding()]);
      setToast(authMode === "register" ? "注册成功，请绑定微信" : "登录成功");
      if (authMode === "register") await startBinding();
    } catch {
      setToast("无法连接服务器，请稍后重试");
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function startWechatAuth() {
    setAuthMethod("wechat");
    setAuthWechatStep("generating");
    setAuthWechatSessionId("");
    setAuthWechatQrValue("");
    setAuthWechatVerifyCode("");
    try {
      const response = await fetch("/api/auth/wechat/sessions", { method: "POST" });
      const data = await response.json();
      if (!response.ok) { setAuthWechatStep("error"); return setToast(data.error || "二维码生成失败"); }
      setAuthWechatQrValue(data.session.qrValue);
      setAuthWechatSessionId(data.session.id);
      setAuthWechatStep("waiting");
    } catch {
      setAuthWechatStep("error");
      setToast("无法连接微信登录服务");
    }
  }

  async function submitWechatAuthVerification() {
    const response = await fetch(`/api/auth/wechat/sessions/${authWechatSessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: authWechatVerifyCode }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "验证码提交失败");
    setAuthWechatStep("scanned");
    setAuthWechatPollVersion((value) => value + 1);
  }

  async function startBinding() {
    setBindOpen(true);
    if (bound) return setBindStep("connected");
    setBindStep("generating");
    setBindingSessionId("");
    setBindingQrValue("");
    try {
      const response = await fetch("/api/bindings/sessions", { method: "POST" });
      const data = await response.json();
      if (!response.ok) { setBindStep("error"); return setToast(data.error || "二维码生成失败"); }
      setBindingQrValue(data.session.qrValue);
      setBindingSessionId(data.session.id);
      setBindStep("waiting");
    } catch {
      setBindStep("error");
      setToast("无法连接微信服务");
    }
  }

  async function submitVerification(code: string) {
    const response = await fetch(`/api/bindings/sessions/${bindingSessionId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "验证码提交失败");
    setBindStep("scanned");
    setBindingPollVersion((value) => value + 1);
  }

  async function unbind() {
    const activeCount = counts.upcoming + counts.paused;
    if (!window.confirm(activeCount ? `解绑后，当前 ${activeCount} 条有效提醒将无法发送到微信。确定继续吗？` : "确定解除当前微信绑定吗？")) return;
    const response = await fetch("/api/bindings", { method: "DELETE" });
    if (!response.ok) return setToast("解绑失败");
    setBound(false);
    setBindingStatus(null);
    setBindOpen(false);
    setBindStep("idle");
    setToast("微信已解绑");
  }

  async function sendTestReminder() {
    if (["queueing", "queued"].includes(testDeliveryState)) return;
    setTestDeliveryState("queueing");
    try {
      const response = await fetch("/api/bindings/test", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setTestDeliveryState("failed");
        return setToast(data.error || "测试提醒创建失败");
      }

      setTestDeliveryState("queued");
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const deliveryResponse = await fetch("/api/deliveries", { cache: "no-store" });
        if (!deliveryResponse.ok) continue;
        const deliveryData = await deliveryResponse.json();
        const attempt = deliveryData.attempts.find((item: { reminderId: string }) => item.reminderId === data.reminderId) as { status: "pending" | "sent" | "failed" | "blocked" } | undefined;
        if (!attempt || attempt.status === "pending") continue;
        setTestDeliveryState(attempt.status);
        await Promise.all([loadReminders(), loadDeliveries()]);
        setToast(attempt.status === "sent" ? "测试提醒已真实发送到微信" : attempt.status === "blocked" ? "测试提醒被阻塞" : "测试提醒发送失败");
        return;
      }
      setTestDeliveryState("timeout");
      setToast("暂未查到投递结果，请稍后重试");
    } catch {
      setTestDeliveryState("failed");
      setToast("测试提醒发送失败");
    }
  }

  async function submitComposer(event: FormEvent) {
    event.preventDefault();
    if (composerInterpreting) return;
    setComposerInterpreting(true);
    const result = parseChineseReminders(composer);
    try {
      if (result.reminders.length || result.clarification?.reason !== "unrecognized") {
        setPreview(result.reminders);
        setComposerClarification(result.clarification ? `${result.reminders.length ? `前 ${result.reminders.length} 条已识别；` : ""}${result.clarification.prompt}` : "");
        return;
      }
      const response = await fetch("/api/reminders/interpret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: composer }) });
      const interpreted = await response.json();
      if (!response.ok) { setComposerClarification(interpreted.error || "提醒内容解析失败，请稍后再试"); return; }
      if (interpreted.unsupported) { setComposerClarification("我是准点提醒助手，只能处理提醒事务。请告诉我时间和要做的事。"); return; }
      setPreview(interpreted.reminders || []);
      setComposerClarification(interpreted.clarification ? interpreted.clarification.prompt : interpreted.correctionNote ? `已理解：${interpreted.correctionNote}` : interpreted.reminders?.length ? "" : "还没有识别到准确时间，请补充日期和时间");
    } finally {
      setComposerInterpreting(false);
    }
  }

  async function createReminder() {
    if (!preview.length) return;
    const response = await fetch("/api/reminders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reminders: preview.map((item) => ({ title: item.title, originalInput: composer, scheduledAt: item.scheduledAt, repeatRule: item.repeatRule, repeatUntil: item.repeatUntil })) }),
    });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "提醒创建失败");
    const created = (data.reminders || [data.reminder]).map(fromApiReminder);
    setReminders((items) => [...created, ...items]);
    if (data.quota) setQuota({ activeCount: data.quota.activeCount, limit: data.quota.limit, remaining: Math.max(0, data.quota.limit - data.quota.activeCount) });
    setComposer("");
    setComposerClarification("");
    setPreview([]);
    setFilter("upcoming");
    setToast(created.length > 1 ? `已创建 ${created.length} 条提醒` : "提醒已创建");
  }

  async function cancelAllReminders() {
    if (!counts.upcoming && !counts.paused) return setToast("当前没有需要取消的提醒");
    if (!window.confirm(`确定取消全部 ${counts.upcoming + counts.paused} 条有效提醒吗？`)) return;
    const response = await fetch("/api/reminders", { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "取消全部提醒失败");
    await loadReminders();
    setToast(`已取消 ${data.cancelled} 条提醒`);
  }

  async function changeStatus(id: string, status: ReminderStatus) {
    const response = await fetch(`/api/reminders/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
    const data = await response.json();
    if (!response.ok) return setToast(data.error || "操作失败");
    setReminders((items) => items.map((item) => item.id === id ? fromApiReminder(data.reminder) : item));
    if (["completed", "cancelled"].includes(status)) setQuota((current) => ({ ...current, activeCount: Math.max(0, current.activeCount - 1), remaining: Math.min(current.limit, current.remaining + 1) }));
    setToast(status === "completed" ? "已标记完成" : status === "cancelled" ? "提醒已取消" : status === "paused" ? "重复提醒已暂停" : "重复提醒已恢复");
  }

  function openReminderEditor(reminder: Reminder) {
    const date = new Date(reminder.scheduledAt);
    const localValue = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    const now = new Date();
    const minimum = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    setEditingReminder(reminder);
    setEditTitle(reminder.title);
    setEditDateTime(localValue);
    setEditMinimum(minimum);
  }

  async function saveReminderTime() {
    if (!editingReminder || !editDateTime || !editTitle.trim() || editSaving) return;
    const scheduledAt = new Date(editDateTime);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) return setToast("请选择未来的提醒时间");
    setEditSaving(true);
    try {
      const response = await fetch(`/api/reminders/${editingReminder.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scheduledAt: scheduledAt.toISOString(), title: editTitle.trim() }),
      });
      const data = await response.json();
      if (!response.ok) return setToast(data.error || "修改提醒失败");
      setReminders((items) => items.map((item) => item.id === editingReminder.id ? fromApiReminder(data.reminder) : item));
      setEditingReminder(null);
      setToast("提醒时间已修改");
    } catch {
      setToast("无法连接服务器，请稍后重试");
    } finally {
      setEditSaving(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setLoggedIn(false);
    setSessionUser(null);
    setReminders([]);
    setDeliveries([]);
    setWorkspaceView("reminders");
    setBound(false);
    setBindingStatus(null);
    setMobileNav(false);
  }

  if (!loggedIn) {
    return (
      <main className="landing-shell">
        <header className="landing-header">
          <button className="landing-logo" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="返回首页">
            <Sprout size={28} />
            <span><b>准点</b><small>随口一句 · 排好一日</small></span>
          </button>
          <div className="landing-actions">
            <button className="landing-schedule" onClick={() => { setAuthMode("register"); setAuthOpen(true); }}><span />日程安排</button>
            <button className="landing-account" onClick={() => { setAuthMode("login"); setAuthOpen(true); }}><span>准</span>登录账号<ChevronDown size={15} /></button>
          </div>
        </header>

        <div className="landing-scroll">
        <div className="landing-meta"><span>NO. 01 / 一日</span><span>HANGZHOU · 2026</span></div>

        <section className="landing-hero">
          <div className="landing-copy">
            <em>for the people who think faster than they plan —</em>
            <h1>一句话，<br /><span>排好</span>你的一日。</h1>
            <div className="landing-rule" />
            <p>在微信里写下「明早八点喝水、十点开会、下午四点陪妈妈散步」，<br />准点把它折叠成今日的节奏 —— <i>不催促，不打扰，</i>只在恰好的时刻轻拍你一下。</p>
            <button className="landing-cta" onClick={() => { setAuthMode("register"); setAuthOpen(true); }}><span />现在体验<ArrowRight size={18} /></button>
            <div className="landing-trust"><em>trusted by early friends in</em><span>杭州</span><span>上海</span><span>深圳</span><span>成都</span><span>苏州</span></div>
          </div>

          <div className="landing-chat" aria-label="微信对话示例">
            <div className="chat-header"><button aria-label="返回"><ChevronLeft size={22} /><i>2</i></button><b>准点 <small>(2)</small></b><MoreHorizontal size={22} /></div>
            <div className="chat-body">
              <time>上午 8:14</time>
              <div className="chat-row user"><div className="chat-bubble user-bubble">明早八点喝水、十点跟阿杰开会、下午四点陪妈妈散步、晚上八点浇花。</div><span>我</span></div>
              <div className="chat-row bot"><span className="bot-avatar"><Sprout size={20} /></span><div className="chat-bubble bot-bubble"><b>已创建 4 条提醒：</b><p>08:00&nbsp; · &nbsp;喝水</p><p>10:00&nbsp; · &nbsp;跟阿杰开会</p><p>16:00&nbsp; · &nbsp;陪妈妈散步</p><p>20:00&nbsp; · &nbsp;浇花</p><small>到点我会提醒你</small></div></div>
              <div className="chat-row user short"><div className="chat-bubble user-bubble">把散步改到晚上六点。</div><span>我</span></div>
              <div className="chat-row bot compact"><span className="bot-avatar"><Sprout size={20} /></span><div className="chat-bubble bot-bubble">已修改：晚上 18:00 陪妈妈散步。</div></div>
              <time>下午 6:00</time>
              <div className="chat-row bot reminder"><span className="bot-avatar"><Sprout size={20} /></span><div className="chat-reminder"><b><AlarmClock size={15} />准点提醒</b><strong>18:00 <small>到了</small></strong><p>陪妈妈散步</p></div></div>
            </div>
            <div className="chat-composer"><Mic size={21} /><span>随口说就好</span><Smile size={21} /><Plus size={22} /></div>
          </div>
        </section>

        <section className="landing-section landing-how">
          <div className="landing-section-label"><i>№ 02</i><span />HOW IT WORKS<span /></div>
          <div className="how-grid">
            <article><small>i.</small><MessageCircle size={23} /><h2>说一句话，AI 帮你排好</h2><em>Just say it, the AI plans it</em><p>“明早八点开会，下午三点接孩子，晚上提醒我吃药”—— 用平时说话的方式写一句，准点自动识别时间、事项和重复规则，整理成清晰日程。</p></article>
            <article><small>ii.</small><Smartphone size={23} /><h2>就在微信里，不用下载</h2><em>Lives inside WeChat</em><p>不必安装新的 App，也不必改变习惯。在网页绑定微信后，直接在熟悉的对话框里说话，准点就是你的日程助手。</p></article>
            <article><small>iii.</small><AlarmClock size={23} /><h2>到点了，主动提醒你</h2><em>It taps you on time</em><p>会议、吃药、给家人打电话、傍晚散步—— 到点后准点主动发送微信消息，不用再反复打开日历确认。</p></article>
          </div>
        </section>

        <section className="landing-section landing-quiet">
          <div className="landing-section-label"><i>№ 03</i><span />WHAT MAKES IT QUIET<span /></div>
          <div className="quiet-grid">
            <article className="quiet-primary"><div><em>principle</em><small>feature 01</small></div><h2>不打扰，<span>是最大的功能。</span></h2><p>只有提醒到点，准点才会在微信中发来一条消息。没有连环弹窗，没有进度焦虑—— 像一位懂得分寸的朋友，安静地陪着你。</p><div className="quiet-stats"><span><b>1</b><small>次提醒 / 事件</small></span><span><b>0</b><small>个红点干扰</small></span><span><b>0</b><small>个新 App</small></span></div></article>
            <article className="quiet-secondary"><div><Pencil size={21} /><small>feature 02</small></div><h3>想改就改，说一句就行</h3><em>Plans change, just say so</em><p>“散步改到六点”“会议推迟半小时”“取消明天的散步”—— 用一句话调整，遇到多条同名提醒会先向你确认。</p></article>
            <article className="quiet-secondary"><div><Bell size={21} /><small>feature 03</small></div><h3>按平时的说法来</h3><em>Natural reminder phrases</em><p>支持常见的提醒说法。时间或事项不清楚时，准点会继续追问，确认后才执行。</p></article>
          </div>
        </section>

        <section className="landing-section landing-day">
          <div className="landing-section-label"><i>№ 04</i><span />A DAY, WITH ZHUNDIAN<span /></div>
          <div className="day-grid">
            <div className="day-copy"><em>an excerpt from</em><h2>星期三，<br /><span>安静的</span>一天。</h2><p>你早上给准点发了三行字，它替你折出这样一天—— 每一件事都有位置，留白也恰到好处。</p><small>from a real conversation, 杭州, 七月</small></div>
            <div className="day-schedule"><header><b>Wednesday <small>星期三 · 七月</small></b><span>TODAY&apos;S PATTERN</span></header>{[
              ["07:30", "起床 · 一杯温水", ""], ["09:00", "深度工作 · 写完那段稿子", "1h 30m"], ["10:30", "与阿杰 · 周会", "45m"], ["12:00", "午饭 · 楼下的面馆", ""], ["14:00", "回信 + 收尾邮件", "30m"], ["16:00", "茶歇 · 站起来走走", ""], ["18:00", "陪妈妈散步 · 沿着河", "1h"], ["20:00", "浇花 · 阳台那几盆", ""], ["22:30", "合上电脑 · 不再看消息", ""],
            ].map(([time, title, duration], index) => <div className="day-row" key={time}><time>{time}</time><i className={`tone-${index % 5}`} /><span>{title}</span><small>{duration}</small></div>)}<footer><span>9 件事 · 4 段留白</span><em>arranged by 准点</em></footer></div>
          </div>
        </section>

        <section className="landing-section landing-faq">
          <div className="landing-section-label"><i>№ 05</i><span />QUESTIONS, ANSWERED<span /></div>
          <div className="faq-grid">
            <div className="faq-copy"><em>frequently asked</em><h2>六个<br />常被问到的<br /><span>问题。</span></h2><p>还有别的好奇？登录后可以直接联系我们。</p></div>
            <div className="faq-list">{[
              ["准点是什么？", "准点是一款通过自然语言创建提醒、并在约定时间发送微信消息的轻量日程助手。"],
              ["需要下载 App 吗？", "不需要。你只需使用网页账号并扫码绑定微信，就能创建和接收提醒。"],
              ["它和普通日历有什么不同？", "准点更强调对话创建和微信送达，不要求你逐项填写复杂表单。"],
              ["想修改日程怎么办？", "可以在网页编辑，也可以在微信中直接说“把散步改到六点”。"],
              ["支持周期性安排吗？", "支持每天、工作日、每周及每月提醒，并能在日历中展开查看。"],
              ["数据安全吗？怎么收费？", "账号数据由系统隔离保存。普通用户可免费体验，VIP 可获得更高提醒上限。"],
            ].map(([question, answer], index) => <details key={question}><summary><span><i>{String(index + 1).padStart(2, "0")}</i>{question}</span><Plus size={17} /></summary><p>{answer}</p></details>)}</div>
          </div>
        </section>

        <section className="landing-section landing-ready">
          <div className="landing-section-label"><i>№ 06</i><span />READY WHEN YOU ARE<span /></div>
          <div className="ready-panel"><em>· invitation ·</em><h2>写下你的 <span>第一句。</span></h2><p>一句话写下你的一日——早一点开始，你就早一点拿回属于自己的节奏。</p><button className="landing-cta" onClick={() => { setAuthMode("register"); setAuthOpen(true); }}><span />现在体验<ArrowRight size={18} /></button></div>
          <footer className="landing-footer"><div><b>准点 — 一日一句话.</b><small>© 2026 准点 · 安静地陪你过日子。</small></div><nav><button onClick={() => { setAuthMode("login"); setAuthOpen(true); }}>注册 / 登录</button><button onClick={() => { setAuthMode("register"); setAuthOpen(true); }}>日程安排</button><button onClick={() => { setAuthMode("login"); setAuthOpen(true); }}>联系客服</button></nav></footer>
        </section>
        </div>

        {authOpen && <div className="landing-auth-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !authSubmitting && setAuthOpen(false)}>
          <section className="landing-auth-modal" role="dialog" aria-modal="true" aria-label={authMode === "login" ? "登录" : "注册"}>
            <button className="icon-button landing-auth-close" onClick={() => setAuthOpen(false)} disabled={authSubmitting} aria-label="关闭"><X size={20} /></button>
            <form className="login-form" onSubmit={authenticate}>
              <div className="mobile-brand"><div className="brand-mark"><Sprout size={20} /></div><b>准点</b></div>
              <div className="auth-method-tabs" role="tablist" aria-label="登录方式">
                <button type="button" className={authMethod === "wechat" ? "active" : ""} onClick={() => { setAuthMethod("wechat"); if (!authWechatSessionId || ["expired", "error"].includes(authWechatStep)) void startWechatAuth(); }}><QrCode size={16} />微信扫码</button>
                <button type="button" className={authMethod === "password" ? "active" : ""} onClick={() => setAuthMethod("password")}>账号密码</button>
              </div>
              {authMethod === "wechat" ? <div className="wechat-auth-panel">
                <span className="eyebrow">一次扫码完成</span>
                <h2>微信登录或注册</h2>
                <p className="form-lead">首次扫码会自动创建账号并绑定微信；再次扫码直接登录。</p>
                <div className={`auth-qr-frame ${authWechatStep}`}>
                  {authWechatStep === "generating" && <div className="qr-overlay"><RefreshCw className="spin" size={28} /><b>正在生成二维码</b></div>}
                  {authWechatStep === "expired" ? <div className="qr-overlay"><CircleAlert size={28} /><b>二维码已过期</b><button type="button" onClick={startWechatAuth}><RefreshCw size={15} />刷新</button></div> : authWechatQrValue && <QRCodeSVG value={authWechatQrValue} size={190} level="M" marginSize={1} />}
                  {authWechatStep === "scanned" && <div className="qr-overlay scanned"><Smartphone size={30} /><b>已扫码</b><span>请在微信中确认</span></div>}
                  {authWechatStep === "error" && <div className="qr-overlay"><CircleAlert size={28} /><b>二维码生成失败</b><button type="button" onClick={startWechatAuth}><RefreshCw size={15} />重试</button></div>}
                </div>
                {(authWechatStep === "verification" || authWechatStep === "verification_blocked") ? <div className="auth-verify-panel"><b>需要安全验证</b><span>输入微信中显示的数字验证码</span><div><input value={authWechatVerifyCode} onChange={(event) => setAuthWechatVerifyCode(event.target.value.replace(/\D/g, "").slice(0, 8))} inputMode="numeric" placeholder="数字验证码" /><button type="button" className="primary" onClick={submitWechatAuthVerification} disabled={authWechatVerifyCode.length < 4}>提交</button></div></div> : <div className="wechat-auth-hint"><MessageCircle size={18} /><span>{authWechatStep === "scanned" ? "等待微信确认，完成后自动进入" : "使用微信扫一扫，二维码 5 分钟内有效"}</span></div>}
              </div> : <>
                <div className="auth-tabs" role="tablist" aria-label="账号入口">
                  <button type="button" className={authMode === "login" ? "active" : ""} onClick={() => setAuthMode("login")}>登录</button>
                  <button type="button" className={authMode === "register" ? "active" : ""} onClick={() => setAuthMode("register")}>注册</button>
                </div>
                <span className="eyebrow">{authMode === "login" ? "欢迎回来" : "创建账号"}</span>
                <h2>{authMode === "login" ? "登录你的提醒空间" : "创建账号并绑定微信"}</h2>
                <p className="form-lead">{authMode === "login" ? "使用账号密码登录，继续管理你的提醒。" : "账号注册仍可使用，注册后需要扫码绑定微信。"}</p>
                {authMode === "register" && <label>昵称<input name="displayName" maxLength={30} placeholder="怎么称呼你" autoComplete="name" enterKeyHint="next" /></label>}
                <label>用户名<input name="username" maxLength={32} placeholder="3-32 位字母、数字或下划线" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" /></label>
                <label>密码<input name="password" type="password" maxLength={72} placeholder="至少 8 位" autoComplete={authMode === "login" ? "current-password" : "new-password"} enterKeyHint={authMode === "login" ? "go" : "next"} /></label>
                {authMode === "register" && <label>确认密码<input name="confirmPassword" type="password" maxLength={72} placeholder="再次输入密码" autoComplete="new-password" enterKeyHint="go" /></label>}
                <button className="primary wide" type="submit" disabled={authSubmitting}>{authSubmitting ? "请稍候..." : authMode === "login" ? "登录" : "注册并绑定微信"}</button>
              </>}
              <p className="terms">注册或登录即表示你同意《用户协议》和《隐私政策》</p>
            </form>
          </section>
        </div>}
        {toast && <Toast text={toast} />}
      </main>
    );
  }

  if (sessionUser?.role === "admin") {
    return <AdminDashboard displayName={sessionUser.displayName} username={sessionUser.username} onLogout={logout} />;
  }

  const memberLabel = membershipLabel(sessionUser?.vipType || "none", sessionUser?.vipExpiresAt || null);
  const memberStatus = membershipStatusText(sessionUser?.vipType || "none", sessionUser?.vipExpiresAt || null);
  const memberTone = sessionUser?.vipType === "permanent" ? "permanent" : sessionUser?.vipType === "monthly" ? "monthly" : "normal";

  return (
    <div className="app-shell">
      <aside className={mobileNav ? "sidebar open" : "sidebar"}>
        <div className="sidebar-head"><div className="brand-mark"><BellRing size={20} /></div><b>准点</b><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="关闭菜单"><X size={20} /></button></div>
        <nav>
          <button className={workspaceView === "reminders" && filter === "upcoming" ? "active" : ""} onClick={() => { setWorkspaceView("reminders"); setFilter("upcoming"); setMobileNav(false); }}><Clock3 size={18} />待提醒<span>{counts.upcoming}</span></button>
          <button className={workspaceView === "reminders" && filter === "paused" ? "active" : ""} onClick={() => { setWorkspaceView("reminders"); setFilter("paused"); setMobileNav(false); }}><Pause size={18} />已暂停<span>{counts.paused}</span></button>
          <button className={workspaceView === "reminders" && filter === "completed" ? "active" : ""} onClick={() => { setWorkspaceView("reminders"); setFilter("completed"); setMobileNav(false); }}><CheckCircle2 size={18} />已完成<span>{counts.completed}</span></button>
          <button className={workspaceView === "reminders" && filter === "all" ? "active" : ""} onClick={() => { setWorkspaceView("reminders"); setFilter("all"); setMobileNav(false); }}><CalendarClock size={18} />全部提醒</button>
          <button className={workspaceView === "calendar" ? "active" : ""} onClick={() => { setWorkspaceView("calendar"); setMobileNav(false); }}><CalendarClock size={18} />日历</button>
          <button className={workspaceView === "deliveries" ? "active" : ""} onClick={() => { setWorkspaceView("deliveries"); setMobileNav(false); void loadDeliveries(); }}><History size={18} />投递记录</button>
        </nav>
        <div className="sidebar-bottom">
          <button className="membership-entry" onClick={() => { setMembershipOpen(true); setMobileNav(false); }}>
            <span className="membership-entry-icon"><Crown size={17} /></span>
            <span><b>{memberLabel}</b><small>{sessionUser?.vipType === "none" ? "会员功能内测中" : memberStatus.replace(`${memberLabel} · `, "")}</small></span>
          </button>
          <div className={bound ? "channel connected" : bindingStatus === "expired" ? "channel expired" : "channel"}>
            <div className="channel-icon"><MessageCircle size={17} /></div>
            <div><b>{bound ? "微信已连接" : bindingStatus === "expired" ? "微信连接已失效" : "微信未连接"}</b><span>{bound ? "iLink · 当前账号" : bindingStatus === "expired" ? "请重新扫码连接" : "扫码后接收提醒"}</span></div>
            <button className="icon-button" onClick={startBinding} aria-label="管理微信连接"><MoreHorizontal size={18} /></button>
          </div>
          <button className="profile" onClick={() => { setProfileOpen(true); setMobileNav(false); }}><span className="avatar">{sessionUser?.displayName.slice(0, 1) || "用"}</span><span><b>{sessionUser?.displayName || "当前用户"}<em className={`profile-membership ${memberTone}`}><Crown size={10} />{memberLabel}</em></b><small>@{sessionUser?.username || "账号"} · 个人设置</small></span><Settings size={16} /></button>
        </div>
      </aside>
      {mobileNav && <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="关闭菜单遮罩" />}

      <main className="workspace">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMobileNav(true)} aria-label="打开菜单"><Menu size={21} /></button>
          <div><h1>{workspaceView === "deliveries" ? "投递记录" : workspaceView === "calendar" ? "提醒日历" : "提醒"}</h1><p>{workspaceView === "deliveries" ? "微信提醒的真实送达状态" : workspaceView === "calendar" ? "按日期查看提醒事项" : new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</p></div>
          <div className="top-actions">
            {workspaceView !== "calendar" && <div className="search"><Search size={17} /><input aria-label="搜索" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={workspaceView === "deliveries" ? "搜索投递记录" : "搜索提醒"} /></div>}
            <button className={`membership-pill ${memberTone}`} onClick={() => setMembershipOpen(true)} title={memberStatus}><Crown size={14} /><span>{memberLabel}</span></button>
            <button className={bound ? "connection-pill connected" : bindingStatus === "expired" ? "connection-pill expired" : "connection-pill"} onClick={startBinding}><span />{bound ? "微信已连接" : bindingStatus === "expired" ? "重新连接微信" : "连接微信"}</button>
          </div>
        </header>

        <div className="content user-content">
          {workspaceView === "reminders" ? <>
          <section className="composer-section">
            <div className="section-heading"><div><h2>新建提醒</h2><p>用自然语言告诉准点，什么时间提醒你做什么。</p></div><span className="quota-tag">有效提醒 {quota.activeCount} / {quota.limit}</span></div>
            <form className="composer" onSubmit={submitComposer}>
              <Bell size={20} />
              <input value={composer} onChange={(e) => { setComposer(e.target.value); setPreview([]); setComposerClarification(""); }} placeholder="例如：明早8点喝水、10点开会" />
              <button className="primary" type="submit" disabled={composerInterpreting}><Plus size={17} />{composerInterpreting ? "正在理解" : "创建提醒"}</button>
            </form>
            {composerClarification && <div className="composer-clarification" role="status"><CircleAlert size={17} /><span>{composerClarification}</span></div>}
            <div className="suggestions">
              {[
                "10分钟后提醒我喝水",
                "周五晚上8点提醒我交周报",
                "每天早上8点提醒我吃药",
                "工作日早上9点提醒我打卡",
                "每月1号上午9点提醒我交房租",
              ].map((text) => <button key={text} onClick={() => { setComposer(text); const parsed = parseChineseReminder(text); setPreview(parsed ? [parsed] : []); }}>{text}</button>)}
            </div>
            {preview.length > 0 && <div className="parse-preview batch">
              <div className="parse-icon"><Check size={18} /></div>
              <div className="parse-items"><span>已识别 {preview.length} 条提醒</span>{preview.map((item, index) => <div className="parse-item" key={`${item.scheduledAt}-${index}`}><b>{item.title}</b><p><Clock3 size={14} />{formatDate(item.scheduledAt)}<i>·</i>{item.repeatLabel}</p></div>)}</div>
              <button className="primary" onClick={createReminder}>确认创建{preview.length > 1 ? ` ${preview.length} 条` : ""}</button>
              <button className="icon-button" onClick={() => setPreview([])} aria-label="取消"><X size={18} /></button>
            </div>}
          </section>

          <section className="reminders-section">
            <div className="list-head">
              <div className="tabs">
                <button className={filter === "upcoming" ? "active" : ""} onClick={() => setFilter("upcoming")}>待提醒 <span>{counts.upcoming}</span></button>
                <button className={filter === "paused" ? "active" : ""} onClick={() => setFilter("paused")}>已暂停 <span>{counts.paused}</span></button>
                <button className={filter === "completed" ? "active" : ""} onClick={() => setFilter("completed")}>已完成</button>
                <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部</button>
              </div>
              <div className="list-tools"><button className="secondary cancel-all" onClick={cancelAllReminders} disabled={!counts.upcoming && !counts.paused}><Trash2 size={14} />取消全部</button><button className="sort-button">按时间排序 <ChevronDown size={15} /></button></div>
            </div>

            <div className="reminder-list">
              {visible.map((item) => <article className={`reminder-item ${item.status}`} key={item.id}>
                <button className="complete-check" onClick={() => item.status === "upcoming" && changeStatus(item.id, "completed")} aria-label={item.status === "paused" ? "提醒已暂停" : "标记完成"}>{item.status === "completed" && <Check size={14} />}{item.status === "cancelled" && <X size={14} />}{item.status === "paused" && <Pause size={11} />}</button>
                <div className="reminder-main"><h3>{item.title}</h3><p><Clock3 size={15} />{formatDate(item.scheduledAt)}<span className="repeat">{item.repeat}</span></p></div>
                <div className="delivery-state">{item.status === "paused" ? <><Pause size={15} />已暂停投递</> : <><MessageCircle size={15} />{bound ? "将发送到微信" : "等待连接微信"}</>}</div>
                {item.status === "upcoming" && <div className="reminder-actions">
                  {item.repeatRule !== "once" && <button className="icon-button lifecycle-reminder" onClick={() => changeStatus(item.id, "paused")} aria-label="暂停重复提醒" title="暂停重复提醒"><Pause size={16} /></button>}
                  <button className="icon-button edit-reminder" onClick={() => openReminderEditor(item)} aria-label="修改提醒时间" title="修改提醒时间"><Pencil size={16} /></button>
                  <button className="icon-button danger" onClick={() => changeStatus(item.id, "cancelled")} aria-label="取消提醒" title="取消提醒"><Trash2 size={17} /></button>
                </div>}
                {item.status === "paused" && <div className="reminder-actions">
                  <button className="icon-button lifecycle-reminder" onClick={() => changeStatus(item.id, "upcoming")} aria-label="恢复重复提醒" title="恢复重复提醒"><Play size={16} /></button>
                  <button className="icon-button danger" onClick={() => changeStatus(item.id, "cancelled")} aria-label="取消提醒" title="取消提醒"><Trash2 size={17} /></button>
                </div>}
              </article>)}
              {visible.length === 0 && <div className="empty"><CheckCircle2 size={30} /><h3>这里暂时没有提醒</h3><p>创建一条新提醒，事情会按时来到你面前。</p></div>}
            </div>
          </section>
          </> : workspaceView === "calendar" ? <ReminderCalendar reminders={reminders} month={calendarMonth} onMonth={setCalendarMonth} onEdit={openReminderEditor} /> : <DeliveryHistory attempts={deliveries} filter={deliveryFilter} query={query} onFilter={setDeliveryFilter} onRefresh={loadDeliveries} />}
        </div>
      </main>

      {bindOpen && <BindingModal step={bindStep} bound={bound} qrValue={bindingQrValue} testDeliveryState={testDeliveryState} onClose={() => setBindOpen(false)} onRefresh={startBinding} onVerify={submitVerification} onUnbind={unbind} onSendTest={sendTestReminder} />}
      {membershipOpen && sessionUser && <MembershipModal user={sessionUser} onClose={() => setMembershipOpen(false)} onComingSoon={() => setToast("会员功能目前处于内测阶段")} />}
      {profileOpen && sessionUser && <ProfileModal user={sessionUser} onClose={() => setProfileOpen(false)} onSaved={(user) => { setSessionUser(user); setProfileOpen(false); setToast("个人资料已更新"); }} onLogout={logout} />}
      {editingReminder && <EditReminderModal reminder={editingReminder} title={editTitle} value={editDateTime} minimum={editMinimum} saving={editSaving} onTitleChange={setEditTitle} onChange={setEditDateTime} onClose={() => setEditingReminder(null)} onSave={saveReminderTime} />}
      {toast && <Toast text={toast} />}
    </div>
  );
}

function ProfileModal({ user, onClose, onSaved, onLogout }: { user: SessionUser; onClose: () => void; onSaved: (user: SessionUser) => void; onLogout: () => void }) {
  const [username, setUsername] = useState(user.username);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [timezone, setTimezone] = useState(user.timezone || "Asia/Shanghai");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) return setError("用户名需要 3-32 位字母、数字或下划线");
    if (!displayName.trim()) return setError("请输入昵称");
    if (password && password.length < 8) return setError("新密码至少需要 8 位");
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/account/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, displayName, timezone, ...(password ? { password } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "个人资料保存失败");
      onSaved(data.user);
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "个人资料保存失败"); setSaving(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}><section className="modal profile-modal" role="dialog" aria-modal="true" aria-label="个人设置"><header><div><span className="eyebrow">账户</span><h2>个人设置</h2></div><button className="icon-button" onClick={onClose} disabled={saving}><X size={19} /></button></header><form className="profile-form" onSubmit={submit}>{error && <div className="form-error">{error}</div>}<label>昵称<input value={displayName} maxLength={30} onChange={(event) => setDisplayName(event.target.value)} /></label><label>用户名<input value={username} maxLength={32} onChange={(event) => setUsername(event.target.value.replace(/[^a-zA-Z0-9_]/g, ""))} /><small>用于账号密码登录，修改后请使用新用户名。</small></label><label>时区<select value={timezone} onChange={(event) => setTimezone(event.target.value)}><option value="Asia/Shanghai">中国标准时间</option><option value="Asia/Hong_Kong">香港时间</option><option value="Asia/Taipei">台北时间</option></select></label><label>设置新密码<input type="password" value={password} maxLength={72} onChange={(event) => setPassword(event.target.value)} placeholder="留空则不修改，至少 8 位" /><small>微信扫码注册用户可补设密码，之后两种方式都能登录。</small></label><div className="profile-form-actions"><button type="button" className="secondary danger-text" onClick={onLogout}><LogOut size={15} />退出登录</button><span /><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={saving}>{saving ? "保存中" : "保存资料"}</button></div></form></section></div>;
}

function MembershipModal({ user, onClose, onComingSoon }: { user: SessionUser; onClose: () => void; onComingSoon: () => void }) {
  const active = isVipActive(user.vipType, user.vipExpiresAt, new Date());
  const status = membershipLabel(user.vipType, user.vipExpiresAt, new Date());
  const expiry = user.vipType === "monthly" && user.vipExpiresAt
    ? new Date(user.vipExpiresAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })
    : null;

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal membership-modal" role="dialog" aria-modal="true" aria-label="VIP 会员">
      <header><div><span className="eyebrow">会员中心</span><h2>VIP 会员</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></header>
      <div className="membership-body">
        <div className={`membership-status ${active ? "active" : ""}`}>
          <span><Crown size={21} /></span>
          <div><small>当前状态</small><b>{status}</b>{expiry && <em>{active ? `${expiry} 到期` : `已于 ${expiry} 到期`}</em>}{user.vipType === "permanent" && <em>永久有效，无需续费</em>}</div>
        </div>
        <div className="membership-plan">
          <div><span>月卡 VIP</span><small>有效期 30 天 · 最多 10 条有效提醒</small></div>
          <strong>内测中</strong>
        </div>
        <button className="primary wide membership-pay" onClick={onComingSoon}>{active ? "续费暂未开放" : "会员开通暂未开放"}</button>
        <p className="membership-note">内测期间会员状态由管理员配置，暂不展示价格或开放在线支付。</p>
      </div>
    </section>
  </div>;
}

function ReminderCalendar({ reminders, month, onMonth, onEdit }: { reminders: Reminder[]; month: Date; onMonth: (month: Date) => void; onEdit: (reminder: Reminder) => void }) {
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - firstDay.getDay());
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return date;
  });
  const visibleReminders = reminders.filter((item) => item.status !== "cancelled");
  const today = new Date();
  return <section className="calendar-section">
    <div className="calendar-toolbar">
      <div><h2>{month.getFullYear()}年{month.getMonth() + 1}月</h2><p>点击待提醒事项可直接修改时间</p></div>
      <div><button className="icon-button" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="上个月" title="上个月"><ChevronLeft size={18} /></button><button className="secondary" onClick={() => onMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>今天</button><button className="icon-button" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="下个月" title="下个月"><ChevronRight size={18} /></button></div>
    </div>
    <div className="calendar-weekdays">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>周{day}</span>)}</div>
    <div className="calendar-grid">
      {days.map((date) => {
        const items = visibleReminders.flatMap((item) => {
          const occurrenceAt = reminderOccurrenceOnDate(item, date);
          return occurrenceAt ? [{ item, occurrenceAt }] : [];
        });
        const isToday = date.toDateString() === today.toDateString();
        return <div className={`calendar-day ${date.getMonth() === month.getMonth() ? "" : "outside"} ${isToday ? "today" : ""}`} key={date.toISOString()}>
          <span className="calendar-date">{date.getDate()}</span>
          <div className="calendar-events">{items.map(({ item, occurrenceAt }) => <button className={item.status} onClick={() => item.status === "upcoming" && onEdit(item)} disabled={item.status !== "upcoming"} title={`${formatDate(occurrenceAt.toISOString())} ${item.title}`} key={`${item.id}:${occurrenceAt.toISOString()}`}><time>{occurrenceAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time><span>{item.title}</span></button>)}</div>
        </div>;
      })}
    </div>
  </section>;
}

function EditReminderModal({ reminder, title, value, minimum, saving, onTitleChange, onChange, onClose, onSave }: { reminder: Reminder; title: string; value: string; minimum: string; saving: boolean; onTitleChange: (value: string) => void; onChange: (value: string) => void; onClose: () => void; onSave: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
    <section className="modal edit-reminder-modal" role="dialog" aria-modal="true" aria-label="修改提醒时间">
      <header><div><span className="demo-tag">提醒设置</span><h2>修改提醒时间</h2></div><button className="icon-button" onClick={onClose} disabled={saving} aria-label="关闭"><X size={20} /></button></header>
      <div className="edit-reminder-body">
        <div className="edit-reminder-title"><Clock3 size={18} /><div><span>当前提醒</span><b>{reminder.title}</b></div></div>
        <label htmlFor="edit-reminder-title">提醒事项</label>
        <input id="edit-reminder-title" value={title} maxLength={100} onChange={(event) => onTitleChange(event.target.value)} />
        <label htmlFor="edit-reminder-time">新的提醒时间</label>
        <input id="edit-reminder-time" type="datetime-local" value={value} min={minimum} onChange={(event) => onChange(event.target.value)} autoFocus />
        <div className="modal-actions"><button className="secondary" onClick={onClose} disabled={saving}>取消</button><button className="primary" onClick={onSave} disabled={saving || !value || !title.trim()}>{saving ? "保存中" : "保存修改"}</button></div>
      </div>
    </section>
  </div>;
}

function DeliveryHistory({ attempts, filter, query, onFilter, onRefresh }: { attempts: DeliveryAttempt[]; filter: DeliveryFilter; query: string; onFilter: (filter: DeliveryFilter) => void; onRefresh: () => void }) {
  const visible = attempts.filter((item) => {
    const statusMatch = filter === "all" || (filter === "sent" ? item.status === "sent" : ["failed", "blocked"].includes(item.status));
    return statusMatch && item.title.toLowerCase().includes(query.toLowerCase());
  });
  const sent = attempts.filter((item) => item.status === "sent").length;
  const problems = attempts.filter((item) => ["failed", "blocked"].includes(item.status)).length;
  const onTime = attempts.filter((item) => item.status === "sent" && item.latencyMs != null && item.latencyMs <= ON_TIME_THRESHOLD_MS).length;

  return <section className="delivery-history">
    <div className="delivery-summary" aria-label="投递状态统计">
      <div><span>投递总数</span><b>{attempts.length}</b></div>
      <div><span>已发送</span><b>{sent}</b></div>
      <div><span>准时送达</span><b>{onTime}</b></div>
      <div><span>需处理</span><b>{problems}</b></div>
    </div>
    <div className="list-head delivery-list-head">
      <div className="tabs">
        <button className={filter === "all" ? "active" : ""} onClick={() => onFilter("all")}>全部 <span>{attempts.length}</span></button>
        <button className={filter === "sent" ? "active" : ""} onClick={() => onFilter("sent")}>已发送</button>
        <button className={filter === "problem" ? "active" : ""} onClick={() => onFilter("problem")}>需处理</button>
      </div>
      <button className="icon-button" onClick={onRefresh} aria-label="刷新投递记录" title="刷新投递记录"><RefreshCw size={17} /></button>
    </div>
    <div className="delivery-records">
      {visible.map((item) => <DeliveryRecord key={item.id} attempt={item} />)}
      {visible.length === 0 && <div className="empty"><History size={30} /><h3>这里暂时没有投递记录</h3><p>提醒到期并进入发送流程后，结果会出现在这里。</p></div>}
    </div>
  </section>;
}

function DeliveryRecord({ attempt }: { attempt: DeliveryAttempt }) {
  const timing = formatDeliveryTiming(attempt.latencyMs);
  const status = {
    pending: { label: "等待发送", detail: "已进入投递流程" },
    sent: { label: "已发送", detail: timing ? `iLink 已确认 · ${timing}` : attempt.providerMessageId ? "iLink 已确认接收" : "投递成功" },
    failed: { label: "发送失败", detail: "系统将按策略重试" },
    blocked: { label: "已阻塞", detail: attempt.errorCode === "WECHAT_NOT_BOUND" ? "请先扫码绑定微信" : attempt.errorCode === "WECHAT_NOT_ACTIVATED" ? "请先在微信向准点发送“你好”" : attempt.errorCode === "ACCOUNT_DISABLED" ? "账号已停用，请联系管理员" : "微信连接不可用，请重新扫码" },
  }[attempt.status];
  const StatusIcon = attempt.status === "sent" ? CheckCircle2 : attempt.status === "pending" ? RefreshCw : CircleAlert;
  return <article className={`delivery-record ${attempt.status}`}>
    <div className="delivery-record-icon"><StatusIcon className={attempt.status === "pending" ? "spin" : ""} size={18} /></div>
    <div className="delivery-record-main"><h3>{attempt.title}</h3><p><Clock3 size={14} />计划时间 {formatDate(attempt.scheduledAt)}</p></div>
    <div className="delivery-attempt"><span>{attempt.attempt > 1 ? `第 ${attempt.attempt} 次尝试` : "首次尝试"}</span>{attempt.sentAt && <small>{new Date(attempt.sentAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</small>}</div>
    <div className="delivery-result"><b>{status.label}</b><span>{status.detail}</span></div>
  </article>;
}

function Toast({ text }: { text: string }) {
  return <div className="toast"><CheckCircle2 size={17} />{text}</div>;
}

function BindingModal({ step, bound, qrValue, testDeliveryState, onClose, onRefresh, onVerify, onUnbind, onSendTest }: { step: BindStep; bound: boolean; qrValue: string; testDeliveryState: TestDeliveryState; onClose: () => void; onRefresh: () => void; onVerify: (code: string) => void; onUnbind: () => void; onSendTest: () => void }) {
  const [verifyCode, setVerifyCode] = useState("");
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <section className="modal" role="dialog" aria-modal="true" aria-label="绑定微信">
      <header><div><span className="demo-tag real">微信 iLink</span><h2>{bound ? "管理微信连接" : "扫码绑定微信"}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></header>
      {step === "connected" ? <div className="bind-success">
        <div className="success-icon"><CheckCircle2 size={34} /></div><h3>微信已连接</h3><p>提醒将通过 iLink 发送到当前绑定的微信。</p>
        <div className="account-row"><span className="wechat-avatar"><MessageCircle size={21} /></span><div><b>当前微信账号</b><span>iLink 轻量连接器</span></div><i>已连接</i></div>
        <TestDeliveryStatus state={testDeliveryState} />
        <div className="modal-actions"><button className="secondary danger-text" onClick={onUnbind}><Unlink size={16} />解除绑定</button><button className="secondary" onClick={onSendTest} disabled={["queueing", "queued"].includes(testDeliveryState)}><Send size={16} />{["queueing", "queued"].includes(testDeliveryState) ? "正在测试" : "发送测试提醒"}</button><button className="primary" onClick={onClose}>完成</button></div>
      </div> : <div className="bind-body">
        <div className={`qr-frame ${step}`}>
          {step === "generating" && <div className="qr-overlay"><RefreshCw className="spin" size={28} /><b>正在生成二维码</b></div>}
          {step === "expired" ? <div className="qr-overlay"><CircleAlert size={28} /><b>二维码已过期</b><button onClick={onRefresh}><RefreshCw size={15} />刷新</button></div> : qrValue && <QRCodeSVG value={qrValue} size={184} level="M" marginSize={1} />}
          {step === "scanned" && <div className="qr-overlay scanned"><Smartphone size={30} /><b>已扫码</b><span>请在微信中确认</span></div>}
          {step === "error" && <div className="qr-overlay"><CircleAlert size={28} /><b>连接微信服务失败</b><button onClick={onRefresh}><RefreshCw size={15} />重试</button></div>}
          {step === "already_bound" && <div className="qr-overlay"><CircleAlert size={28} /><b>该微信已绑定</b><span>请先解除原有连接</span></div>}
        </div>
        {(step === "verification" || step === "verification_blocked") ? <div className="verify-panel"><b>{step === "verification_blocked" ? "验证码错误次数过多" : "需要安全验证"}</b><span>输入手机微信中显示的数字</span><div><input value={verifyCode} onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="数字验证码" inputMode="numeric" /><button className="primary" onClick={() => onVerify(verifyCode)} disabled={verifyCode.length < 4}>提交</button></div></div> : <div className="bind-instruction"><QrCode size={20} /><div><b>{step === "scanned" ? "等待微信确认" : "使用微信扫描二维码"}</b><span>{step === "scanned" ? "确认后会自动完成绑定" : "二维码 5 分钟内有效，仅用于连接提醒服务"}</span></div></div>}
        <div className="privacy-note"><Link2 size={16} />每个网站账号只绑定自己的微信；真实版本中令牌会加密存储。</div>
      </div>}
    </section>
  </div>;
}

function TestDeliveryStatus({ state }: { state: TestDeliveryState }) {
  if (state === "idle") return null;
  const content = {
    queueing: ["正在创建测试提醒", "将通过正式队列发送"],
    queued: ["等待微信投递结果", "通常会在几秒内完成"],
    sent: ["测试提醒已发送", "投递记录已确认 sent"],
    failed: ["测试提醒发送失败", "请稍后重试或检查连接"],
    blocked: ["测试提醒被阻塞", "当前微信连接不可用"],
    timeout: ["暂未取得投递结果", "可稍后再次测试"],
  }[state];
  const successful = state === "sent";
  return <div className={`test-delivery ${successful ? "success" : state}`}>
    {successful ? <CheckCircle2 size={19} /> : ["queueing", "queued"].includes(state) ? <RefreshCw className="spin" size={19} /> : <CircleAlert size={19} />}
    <div><b>{content[0]}</b><span>{content[1]}</span></div>
  </div>;
}
