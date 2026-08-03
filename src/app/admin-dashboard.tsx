"use client";

import { Activity, BellRing, CheckCircle2, ChevronDown, CircleAlert, Clock3, Crown, FileClock, History, LayoutDashboard, Link2, LogOut, Menu, MessageCircle, Pencil, Plus, RefreshCw, Save, Search, Settings, Trash2, Users, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { formatDeliveryTiming } from "@/lib/delivery-timing";
import { defaultMonthlyExpiry, isVipActive } from "@/lib/membership";

const ADMIN_RENDER_TIME = new Date();
const DEFAULT_MONTHLY_EXPIRY = defaultMonthlyExpiry(ADMIN_RENDER_TIME).toISOString().slice(0, 10);
const TODAY = ADMIN_RENDER_TIME.toISOString().slice(0, 10);

type AdminUser = {
  id: string;
  username: string;
  displayName: string;
  adminNote: string | null;
  role: "user" | "admin";
  timezone: string;
  accountStatus: "active" | "disabled";
  vipType: "none" | "monthly" | "permanent";
  vipExpiresAt: string | null;
  reminderLimitOverride: number | null;
  reminderLimit: number;
  createdAt: string;
  reminderCount: number;
  reminders: AdminReminder[];
  bindingStatus: "active" | "pending" | "offline" | "expired" | "revoked" | null;
  lastInboundAt: string | null;
  lastSuccessfulSendAt: string | null;
};

type AdminReminder = {
  id: string;
  title: string;
  originalInput: string;
  scheduledAt: string;
  timezone: string;
  repeatRule: string;
  status: "upcoming" | "paused";
  createdAt: string;
  displayName?: string;
  username?: string;
};

type AdminBinding = { id: string; userId: string; displayName: string; username: string; accountId: string; weixinUserId: string; status: "active" | "pending" | "offline" | "expired" | "revoked"; boundAt: string | null; lastInboundAt: string | null; lastSuccessfulSendAt: string | null; updatedAt: string };
type AdminAudit = { id: string; action: string; targetType: string; targetId: string | null; summary: string; createdAt: string; actorDisplayName: string; actorUsername: string };
type AdminSettings = { accountRegistrationEnabled: boolean; wechatRegistrationEnabled: boolean; reminderCreationEnabled: boolean; aiEnabled: boolean; aiGlobalDailyLimit: number; alertEmail: string; updatedAt: string };

type AdminDelivery = {
  id: string;
  title: string;
  status: "pending" | "sent" | "failed" | "blocked";
  attempt: number;
  scheduledAt: string;
  sentAt: string | null;
  createdAt: string;
  errorCode: string | null;
  displayName: string;
  username: string;
  latencyMs: number | null;
  handledAt: string | null;
  handlingNote: string | null;
};

type Overview = {
  generatedAt: string;
  service: { workerLastSeenAt: string | null; workerHealthy: boolean; aiCallsLast24Hours: number; aiSuccessRate: number | null; aiAverageLatencyMs: number | null; aiTokensLast24Hours: number };
  stats: {
    users: number;
    vipUsers: number;
    activeBindings: number;
    upcomingReminders: number;
    totalDeliveries: number;
    sentDeliveries: number;
    problemDeliveries: number;
    deliveryRate: number | null;
    recentOnTimeRate: number | null;
    recentAverageLatencyMs: number | null;
  };
  users: AdminUser[];
  deliveries: AdminDelivery[];
  reminders: AdminReminder[];
  bindings: AdminBinding[];
  audits: AdminAudit[];
  settings: AdminSettings;
  errorGroups: { code: string; count: number }[];
};

type AdminView = "overview" | "users" | "reminders" | "bindings" | "deliveries" | "settings";
type AdminDeliveryFilter = "all" | "sent" | "problem" | "handled";

function formatAdminDate(value: string | null) {
  if (!value) return "暂无";
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function AdminDashboard({ displayName, username, onLogout }: { displayName: string; username: string; onLogout: () => void }) {
  const [view, setView] = useState<AdminView>("overview");
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [deliveryFilter, setDeliveryFilter] = useState<AdminDeliveryFilter>("all");
  const [mobileNav, setMobileNav] = useState(false);
  const [retryingDeliveryId, setRetryingDeliveryId] = useState("");
  const [bulkRetrying, setBulkRetrying] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null | undefined>(undefined);
  const [editingReminder, setEditingReminder] = useState<AdminReminder | null>(null);
  const overviewRequestId = useRef(0);
  const hasOverviewData = useRef(false);

  async function loadOverview(showRefreshing = false) {
    const refreshStartedAt = showRefreshing ? Date.now() : 0;
    if (showRefreshing) setRefreshing(true);
    const requestId = ++overviewRequestId.current;
    try {
      const response = await fetch("/api/admin/overview", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "管理员数据加载失败");
      if (requestId !== overviewRequestId.current) return;
      setData(result);
      hasOverviewData.current = true;
      setError("");
    } catch (loadError) {
      if (requestId !== overviewRequestId.current) return;
      setError(loadError instanceof Error && loadError.message !== "Failed to fetch" ? loadError.message : "管理员数据加载失败，请检查网络后重试");
    } finally {
      if (requestId === overviewRequestId.current) setLoading(false);
      if (showRefreshing) {
        const feedbackDelay = 450 - (Date.now() - refreshStartedAt);
        if (feedbackDelay > 0) await new Promise((resolve) => window.setTimeout(resolve, feedbackDelay));
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadOverview(), 0);
    const refresh = () => document.visibilityState === "visible" && void loadOverview();
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const visibleUsers = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return data?.users || [];
    return (data?.users || []).filter((user) => `${user.displayName} ${user.username} ${user.adminNote || ""}`.toLowerCase().includes(keyword));
  }, [data, query]);

  const visibleDeliveries = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (data?.deliveries || []).filter((delivery) => {
      const statusMatch = deliveryFilter === "all" || (deliveryFilter === "sent" ? delivery.status === "sent" : deliveryFilter === "handled" ? Boolean(delivery.handledAt) : ["failed", "blocked"].includes(delivery.status) && !delivery.handledAt);
      const queryMatch = !keyword || `${delivery.title} ${delivery.displayName} ${delivery.username} ${delivery.errorCode || ""}`.toLowerCase().includes(keyword);
      return statusMatch && queryMatch;
    });
  }, [data, deliveryFilter, query]);

  const visibleReminders = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (data?.reminders || []).filter((reminder) => !keyword || `${reminder.title} ${reminder.displayName} ${reminder.username} ${reminder.originalInput}`.toLowerCase().includes(keyword));
  }, [data, query]);

  const visibleBindings = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (data?.bindings || []).filter((binding) => !keyword || `${binding.displayName} ${binding.username} ${binding.accountId} ${binding.weixinUserId}`.toLowerCase().includes(keyword));
  }, [data, query]);

  const switchView = (next: AdminView) => {
    setView(next);
    setQuery("");
    setDeliveryFilter("all");
    setMobileNav(false);
  };

  async function retryDelivery(id: string) {
    if (retryingDeliveryId) return;
    setRetryingDeliveryId(id);
    try {
      setError("");
      const response = await fetch(`/api/admin/deliveries/${id}/retry`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "投递重试失败");
      await loadOverview();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "投递重试失败");
    } finally {
      setRetryingDeliveryId("");
    }
  }

  async function retryProblems() {
    if (bulkRetrying) return;
    setBulkRetrying(true);
    try {
      const response = await fetch("/api/admin/deliveries/retry-problems", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "批量重试失败");
      setError(result.queued ? `已安排 ${result.queued} 条异常投递重试` : "没有可重试的异常投递");
      await loadOverview();
    } catch (retryError) { setError(retryError instanceof Error ? retryError.message : "批量重试失败"); }
    finally { setBulkRetrying(false); }
  }

  async function handleDelivery(delivery: AdminDelivery) {
    const note = window.prompt("填写处理备注（可留空）", "已人工确认，无需继续重试");
    if (note === null) return;
    const response = await fetch(`/api/admin/deliveries/${delivery.id}/handle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }) });
    const result = await response.json();
    if (!response.ok) return setError(result.error || "标记处理失败");
    await loadOverview();
  }

  async function updateBinding(binding: AdminBinding, action: "offline" | "active" | "delete") {
    if (action === "delete" && !window.confirm(`确定解除“${binding.displayName}”的微信连接吗？解除后需要用户重新扫码。`)) return;
    const response = await fetch(`/api/admin/bindings/${binding.id}`, action === "delete" ? { method: "DELETE" } : { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: action }) });
    const result = await response.json();
    if (!response.ok) return setError(result.error || "微信连接操作失败");
    await loadOverview();
  }

  async function saveSettings(settings: AdminSettings) {
    const response = await fetch("/api/admin/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "系统设置保存失败");
    await loadOverview();
  }

  async function saveUser(payload: UserEditorPayload) {
    const editing = editingUser && "id" in editingUser ? editingUser : null;
    const response = await fetch(editing ? `/api/admin/users/${editing.id}` : "/api/admin/users", {
      method: editing ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "用户资料保存失败");
    setEditingUser(undefined);
    await loadOverview();
  }

  async function deleteUser(user: AdminUser) {
    if (!window.confirm(`确定删除用户“${user.displayName}”吗？该用户的提醒和微信绑定也会被删除。`)) return;
    const response = await fetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) return setError(result.error || "用户删除失败");
    await loadOverview();
  }

  async function saveReminder(payload: { title: string; scheduledAt: string; status: "upcoming" | "paused" | "cancelled" }) {
    if (!editingReminder) return;
    const response = await fetch(`/api/admin/reminders/${editingReminder.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "提醒保存失败");
    setEditingReminder(null);
    await loadOverview();
  }

  return <div className="app-shell admin-shell">
    <aside className={mobileNav ? "sidebar admin-sidebar open" : "sidebar admin-sidebar"}>
      <div className="sidebar-head"><div className="brand-mark"><BellRing size={20} /></div><b>准点管理台</b><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="关闭菜单"><X size={20} /></button></div>
      <div className="admin-role"><Activity size={14} /><span>系统管理员</span></div>
      <nav>
        <button className={view === "overview" ? "active" : ""} onClick={() => switchView("overview")}><LayoutDashboard size={18} />运营总览</button>
        <button className={view === "users" ? "active" : ""} onClick={() => switchView("users")}><Users size={18} />用户管理<span>{data?.stats.users || 0}</span></button>
        <button className={view === "reminders" ? "active" : ""} onClick={() => switchView("reminders")}><Clock3 size={18} />提醒管理<span>{data?.stats.upcomingReminders || 0}</span></button>
        <button className={view === "bindings" ? "active" : ""} onClick={() => switchView("bindings")}><Link2 size={18} />微信连接<span>{data?.stats.activeBindings || 0}</span></button>
        <button className={view === "deliveries" ? "active" : ""} onClick={() => switchView("deliveries")}><History size={18} />投递监控{Boolean(data?.stats.problemDeliveries) && <span className="problem-count">{data?.stats.problemDeliveries}</span>}</button>
        <button className={view === "settings" ? "active" : ""} onClick={() => switchView("settings")}><Settings size={18} />系统设置</button>
      </nav>
      <div className="sidebar-bottom">
        <div className={`admin-service ${data?.service.workerHealthy ? "" : "unhealthy"}`}><span /><div><b>{data?.service.workerHealthy ? "提醒服务运行中" : "提醒服务状态异常"}</b><small>{data?.service.workerLastSeenAt ? `最近心跳 ${formatAdminDate(data.service.workerLastSeenAt)}` : "尚未收到 worker 心跳"}</small></div></div>
        <button className="profile" onClick={onLogout}><span className="avatar">{displayName.slice(0, 1)}</span><span><b>{displayName}</b><small>@{username} · 退出登录</small></span><LogOut size={16} /></button>
      </div>
    </aside>
    {mobileNav && <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="关闭菜单遮罩" />}

    <main className="workspace">
      <header className="topbar">
        <button className="icon-button menu-button" onClick={() => setMobileNav(true)} aria-label="打开菜单"><Menu size={21} /></button>
        <div><h1>{{ overview: "运营总览", users: "用户管理", reminders: "提醒管理", bindings: "微信连接", deliveries: "投递监控", settings: "系统设置" }[view]}</h1><p>{{ overview: "提醒服务的实时运行情况", users: "查看用户、会员和使用情况", reminders: "检索并处置所有用户的有效提醒", bindings: "处理微信连接异常与重新绑定", deliveries: "定位每一次微信提醒的投递结果", settings: "控制业务入口、AI 成本并查看操作记录" }[view]}</p></div>
        <div className="top-actions">
          {view !== "overview" && <div className="search"><Search size={17} /><input aria-label={view === "users" ? "搜索用户" : "搜索投递"} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === "users" ? "搜索用户" : "搜索投递"} /></div>}
          {view === "users" && <button className="primary admin-add-user" onClick={() => setEditingUser(null)}><Plus size={16} />新增用户</button>}
          {view === "deliveries" && Boolean(data?.stats.problemDeliveries) && <button className="secondary admin-bulk-action" onClick={() => void retryProblems()} disabled={bulkRetrying}><RefreshCw className={bulkRetrying ? "spin" : ""} size={16} />批量重试</button>}
          <button className="icon-button admin-refresh" onClick={() => void loadOverview(true)} disabled={refreshing} aria-label="刷新数据" title={refreshing ? "正在刷新" : "刷新数据"}><RefreshCw className={refreshing ? "spin" : ""} size={18} /></button>
        </div>
      </header>

      <div className="content admin-content">
        {error && <div className="admin-error"><span>{error}</span><button onClick={() => void loadOverview()}>重新加载</button></div>}
        {["users", "reminders", "bindings", "deliveries"].includes(view) && <div className="admin-mobile-search"><Search size={16} /><input aria-label="移动端搜索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索用户、提醒或连接" /></div>}
        {view === "overview" ? <AdminOverview data={data} loading={loading} /> : view === "users" ? <AdminUsers users={visibleUsers} loading={loading} onEdit={setEditingUser} onDelete={deleteUser} onReminderEdit={setEditingReminder} /> : view === "reminders" ? <AdminReminderList reminders={visibleReminders} loading={loading} onEdit={setEditingReminder} /> : view === "bindings" ? <AdminBindings bindings={visibleBindings} loading={loading} onAction={updateBinding} /> : view === "deliveries" ? <AdminDeliveries deliveries={visibleDeliveries} allDeliveries={data?.deliveries || []} filter={deliveryFilter} onFilter={setDeliveryFilter} onRetry={retryDelivery} onHandle={handleDelivery} retryingId={retryingDeliveryId} loading={loading} errorGroups={data?.errorGroups || []} /> : <AdminSystemSettings key={data?.settings.updatedAt || "loading"} settings={data?.settings || null} audits={data?.audits || []} onSave={saveSettings} />}
      </div>
    </main>
    {editingUser !== undefined && <UserEditorModal key={editingUser?.id || "new"} user={editingUser} onClose={() => setEditingUser(undefined)} onSave={saveUser} />}
    {editingReminder && <AdminReminderEditor reminder={editingReminder} onClose={() => setEditingReminder(null)} onSave={saveReminder} />}
  </div>;
}

function AdminOverview({ data, loading }: { data: Overview | null; loading: boolean }) {
  const stats = data?.stats;
  return <>
    <section className="admin-stat-grid" aria-label="运营统计">
      <AdminStat icon={<Users size={19} />} label="注册用户" value={stats?.users} detail={`${stats?.vipUsers || 0} 位 VIP 用户`} loading={loading} />
      <AdminStat icon={<MessageCircle size={19} />} label="微信已连接" value={stats?.activeBindings} detail={stats?.users ? `${Math.round(((stats.activeBindings || 0) / stats.users) * 100)}% 绑定率` : "暂无用户"} loading={loading} />
      <AdminStat icon={<Clock3 size={19} />} label="待发送提醒" value={stats?.upcomingReminders} detail="当前任务量" loading={loading} />
      <AdminStat icon={<CheckCircle2 size={19} />} label="投递成功率" value={stats?.deliveryRate == null ? "--" : `${stats.deliveryRate}%`} detail={stats?.recentOnTimeRate == null ? `${stats?.sentDeliveries || 0} / ${stats?.totalDeliveries || 0} 次成功` : `最近投递 ${stats.recentOnTimeRate}% 在5秒内`} loading={loading} />
    </section>

    <section className="admin-operations">
      <div className="admin-section-head"><div><h2>服务状态</h2><p>用于快速发现连接和投递异常</p></div><span>{data ? `更新于 ${formatAdminDate(data.generatedAt)}` : "正在读取"}</span></div>
      <div className="operation-list">
        <div><span className="operation-icon healthy"><MessageCircle size={18} /></span><div><b>微信连接</b><small>当前可用连接</small></div><strong>{stats?.activeBindings || 0}</strong></div>
        <div><span className="operation-icon healthy"><History size={18} /></span><div><b>成功投递</b><small>{stats?.recentAverageLatencyMs == null ? "服务商已确认接收" : `最近平均延迟 ${(stats.recentAverageLatencyMs / 1000).toFixed(1)} 秒`}</small></div><strong>{stats?.sentDeliveries || 0}</strong></div>
        <div><span className={`operation-icon ${(stats?.problemDeliveries || 0) > 0 ? "problem" : "healthy"}`}><Activity size={18} /></span><div><b>异常投递</b><small>失败或被阻塞</small></div><strong className={(stats?.problemDeliveries || 0) > 0 ? "problem-text" : ""}>{stats?.problemDeliveries || 0}</strong></div>
        <div><span className="operation-icon healthy"><Activity size={18} /></span><div><b>AI 理解质量</b><small>{data?.service.aiAverageLatencyMs == null ? "暂无模型数据" : `平均 ${(data.service.aiAverageLatencyMs / 1000).toFixed(1)} 秒 · ${data.service.aiTokensLast24Hours} tokens`}</small></div><strong>{data?.service.aiSuccessRate == null ? "--" : `${data.service.aiSuccessRate}%`}</strong></div>
      </div>
    </section>

    <section className="admin-recent-users">
      <div className="admin-section-head"><div><h2>最近注册</h2><p>最新加入的用户及使用状态</p></div></div>
      <AdminUsers users={(data?.users || []).slice(0, 5)} loading={loading} compact />
    </section>
  </>;
}

function AdminStat({ icon, label, value, detail, loading }: { icon: ReactNode; label: string; value: string | number | undefined; detail: string; loading: boolean }) {
  return <article className="admin-stat"><div className="admin-stat-icon">{icon}</div><span>{label}</span><b>{loading && value == null ? "--" : value ?? 0}</b><small>{detail}</small></article>;
}

function AdminUsers({ users, loading, compact = false, onEdit, onDelete, onReminderEdit }: { users: AdminUser[]; loading: boolean; compact?: boolean; onEdit?: (user: AdminUser) => void; onDelete?: (user: AdminUser) => void; onReminderEdit?: (reminder: AdminReminder) => void }) {
  const [expandedUserId, setExpandedUserId] = useState("");
  if (loading && users.length === 0) return <div className="admin-loading"><RefreshCw className="spin" size={20} />正在加载用户数据</div>;
  if (users.length === 0) return <div className="empty"><Users size={30} /><h3>没有找到用户</h3><p>用户注册后会显示在这里。</p></div>;
  return <div className={compact ? "admin-user-table compact" : "admin-user-table"}>
    <div className="admin-user-head"><span>用户</span><span>会员</span><span>账号</span><span>微信</span><span>有效提醒</span>{!compact && <span>操作</span>}</div>
    {users.map((user) => <Fragment key={user.id}><article className="admin-user-row">
      <div className="admin-user-name"><span className="avatar">{user.displayName.slice(0, 1)}</span><div><b>{user.displayName}{user.role === "admin" && <em>管理员</em>}</b><small>@{user.username}</small>{user.adminNote && <small className="admin-user-note" title={user.adminNote}>备注：{user.adminNote}</small>}</div></div>
      <div><VipBadge user={user} /></div>
      <div><span className={`account-badge ${user.accountStatus}`}>{user.accountStatus === "active" ? "正常" : "已禁用"}</span></div>
      <div><span className={`binding-badge ${user.bindingStatus === "active" ? "active" : "inactive"}`} title={`最近消息：${formatAdminDate(user.lastInboundAt)}；最近发送：${formatAdminDate(user.lastSuccessfulSendAt)}`}><i />{user.bindingStatus === "active" ? "已连接" : user.bindingStatus ? "失效" : "未绑定"}</span></div>
      <div className="admin-reminder-count">{compact ? user.reminderCount : <button onClick={() => setExpandedUserId((value) => value === user.id ? "" : user.id)} aria-expanded={expandedUserId === user.id}><b>{user.reminderCount}</b><span>/ {user.reminderLimit}</span><ChevronDown className={expandedUserId === user.id ? "expanded" : ""} size={15} /></button>}</div>
      {!compact && <div className="admin-user-actions"><button className="icon-button" onClick={() => onEdit?.(user)} aria-label="编辑用户" title="编辑用户"><Pencil size={15} /></button><button className="icon-button danger" onClick={() => onDelete?.(user)} disabled={user.role === "admin"} aria-label="删除用户" title={user.role === "admin" ? "管理员不能删除" : "删除用户"}><Trash2 size={15} /></button></div>}
    </article>{!compact && expandedUserId === user.id && <div className="admin-user-reminders">
      <div className="admin-user-reminders-head"><b>{user.displayName}的有效提醒</b><span>当前 {user.reminderCount} 条，上限 {user.reminderLimit} 条</span></div>
      {user.reminders.length ? user.reminders.map((reminder) => <div className="admin-user-reminder" key={reminder.id}><span className={`reminder-state ${reminder.status}`}>{reminder.status === "upcoming" ? "待提醒" : "已暂停"}</span><div><b>{reminder.title}</b><small>{formatAdminDate(reminder.scheduledAt)} · {reminder.repeatRule === "once" ? "仅一次" : reminder.repeatRule === "daily" ? "每天" : reminder.repeatRule === "weekdays" ? "工作日" : reminder.repeatRule === "weekly" ? "每周" : reminder.repeatRule === "monthly:last" ? "每月最后一天" : `每月${reminder.repeatRule.slice(8)}号`}</small></div><button className="icon-button" onClick={() => onReminderEdit?.(reminder)} aria-label="编辑提醒" title="编辑提醒"><Pencil size={15} /></button></div>) : <div className="admin-user-reminders-empty">当前没有有效提醒</div>}
    </div>}</Fragment>)}
  </div>;
}

function VipBadge({ user }: { user: AdminUser }) {
  const activeMonthly = isVipActive(user.vipType, user.vipExpiresAt, new Date());
  if (user.vipType === "permanent") return <span className="vip-badge permanent"><Crown size={13} />永久 VIP</span>;
  if (activeMonthly) return <span className="vip-badge monthly"><Crown size={13} />月卡</span>;
  return <span className="vip-badge">普通用户</span>;
}

function AdminReminderList({ reminders, loading, onEdit }: { reminders: AdminReminder[]; loading: boolean; onEdit: (reminder: AdminReminder) => void }) {
  if (loading && !reminders.length) return <div className="admin-loading"><RefreshCw className="spin" size={20} />正在加载提醒</div>;
  return <section className="admin-management-panel"><div className="admin-section-head"><div><h2>全部有效提醒</h2><p>显示最近 100 位用户的待提醒与已暂停任务</p></div><span>{reminders.length} 条</span></div><div className="admin-simple-list">
    {reminders.map((reminder) => <article key={reminder.id}><span className={`reminder-state ${reminder.status}`}>{reminder.status === "upcoming" ? "待提醒" : "已暂停"}</span><div><b>{reminder.title}</b><small>{reminder.displayName} · @{reminder.username} · {formatAdminDate(reminder.scheduledAt)} · {reminder.repeatRule}</small></div><button className="icon-button" onClick={() => onEdit(reminder)} title="编辑提醒"><Pencil size={15} /></button></article>)}
    {!reminders.length && <div className="empty"><Clock3 size={30} /><h3>没有找到有效提醒</h3></div>}
  </div></section>;
}

function AdminBindings({ bindings, loading, onAction }: { bindings: AdminBinding[]; loading: boolean; onAction: (binding: AdminBinding, action: "offline" | "active" | "delete") => void }) {
  if (loading && !bindings.length) return <div className="admin-loading"><RefreshCw className="spin" size={20} />正在加载微信连接</div>;
  return <section className="admin-management-panel"><div className="admin-section-head"><div><h2>微信连接</h2><p>停用只暂停收发，解除绑定会要求用户重新扫码</p></div><span>{bindings.length} 个</span></div><div className="admin-binding-list">
    {bindings.map((binding) => <article key={binding.id}><div className="admin-user-name"><span className="avatar">{binding.displayName.slice(0, 1)}</span><div><b>{binding.displayName}</b><small>@{binding.username}</small></div></div><span className={`binding-badge ${binding.status === "active" ? "active" : "inactive"}`}><i />{binding.status === "active" ? "已连接" : binding.status === "offline" ? "已停用" : "已失效"}</span><div className="binding-times"><small>最近消息 {formatAdminDate(binding.lastInboundAt)}</small><small>最近发送 {formatAdminDate(binding.lastSuccessfulSendAt)}</small></div><div className="admin-row-actions"><button className="secondary" onClick={() => onAction(binding, binding.status === "active" ? "offline" : "active")}>{binding.status === "active" ? "停用" : "恢复"}</button><button className="icon-button danger" onClick={() => onAction(binding, "delete")} title="解除绑定"><Trash2 size={15} /></button></div></article>)}
    {!bindings.length && <div className="empty"><Link2 size={30} /><h3>没有找到微信连接</h3></div>}
  </div></section>;
}

function AdminSystemSettings({ settings, audits, onSave }: { settings: AdminSettings | null; audits: AdminAudit[]; onSave: (settings: AdminSettings) => Promise<void> }) {
  const [form, setForm] = useState<AdminSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  if (!form) return <div className="admin-loading"><RefreshCw className="spin" size={20} />正在加载系统设置</div>;
  const toggle = (key: keyof AdminSettings) => setForm((value) => value ? { ...value, [key]: !value[key] } : value);
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); setMessage(""); try { await onSave(form!); setMessage("设置已保存并生效"); } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); } finally { setSaving(false); } }
  return <div className="admin-settings-grid"><section className="admin-management-panel"><div className="admin-section-head"><div><h2>业务开关</h2><p>关闭入口不会删除已有用户或提醒数据</p></div></div><form className="admin-settings-form" onSubmit={submit}>
    {([['accountRegistrationEnabled','账号密码注册','关闭后仍可正常登录'],['wechatRegistrationEnabled','微信新用户注册','已有微信绑定仍可扫码登录'],['reminderCreationEnabled','新增提醒','关闭后保留查看、编辑和发送已有提醒'],['aiEnabled','AI 智能理解','关闭后自动退回本地规则解析']] as const).map(([key,label,detail]) => <label className="setting-toggle" key={key}><span><b>{label}</b><small>{detail}</small></span><input type="checkbox" checked={form[key]} onChange={() => toggle(key)} /><i /></label>)}
    <label className="setting-field"><span><b>AI 全站每日调用上限</b><small>达到后自动使用本地规则，控制 API 成本</small></span><input type="number" min="0" max="100000" value={form.aiGlobalDailyLimit} onChange={(event) => setForm({ ...form, aiGlobalDailyLimit: Number(event.target.value) })} /></label>
    <label className="setting-field"><span><b>运维告警邮箱</b><small>用于记录当前告警接收地址</small></span><input type="email" value={form.alertEmail} onChange={(event) => setForm({ ...form, alertEmail: event.target.value })} /></label>
    {message && <div className="settings-message">{message}</div>}<button className="primary settings-save" disabled={saving}><Save size={16} />{saving ? "保存中" : "保存设置"}</button>
  </form></section><section className="admin-management-panel"><div className="admin-section-head"><div><h2>操作审计</h2><p>追踪管理员对用户、提醒、连接和系统的操作</p></div><span>最近 {audits.length} 条</span></div><div className="admin-audit-list">{audits.map((audit) => <article key={audit.id}><FileClock size={16} /><div><b>{audit.summary}</b><small>{audit.actorDisplayName} · {formatAdminDate(audit.createdAt)}</small></div></article>)}{!audits.length && <div className="empty"><FileClock size={28} /><h3>暂无操作记录</h3></div>}</div></section></div>;
}

type UserEditorPayload = {
  username: string;
  displayName: string;
  adminNote: string | null;
  password?: string;
  timezone: string;
  accountStatus: "active" | "disabled";
  vipType: "none" | "monthly" | "permanent";
  vipExpiresAt: string | null;
  reminderLimitOverride: number | null;
};

function UserEditorModal({ user, onClose, onSave }: { user: AdminUser | null; onClose: () => void; onSave: (payload: UserEditorPayload) => Promise<void> }) {
  const [username, setUsername] = useState(user?.username || "");
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [adminNote, setAdminNote] = useState(user?.adminNote || "");
  const [password, setPassword] = useState("");
  const [timezone, setTimezone] = useState(user?.timezone || "Asia/Shanghai");
  const [accountStatus, setAccountStatus] = useState<"active" | "disabled">(user?.accountStatus || "active");
  const [vipType, setVipType] = useState<"none" | "monthly" | "permanent">(user?.vipType || "none");
  const [vipExpiresAt, setVipExpiresAt] = useState(user?.vipExpiresAt ? new Date(user.vipExpiresAt).toISOString().slice(0, 10) : DEFAULT_MONTHLY_EXPIRY);
  const [reminderLimitOverride, setReminderLimitOverride] = useState(user?.reminderLimitOverride == null ? "" : String(user.reminderLimitOverride));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) return setFormError("用户名需为 3-32 位字母、数字或下划线");
    if (!displayName.trim()) return setFormError("请输入昵称");
    if (!user && password.length < 8) return setFormError("新用户密码至少需要 8 位");
    if (password && password.length < 8) return setFormError("密码至少需要 8 位");
    setSaving(true);
    setFormError("");
    try {
      await onSave({
        username,
        displayName,
        adminNote: adminNote.trim() || null,
        ...(password ? { password } : {}),
        timezone,
        accountStatus,
        vipType,
        vipExpiresAt: vipType === "monthly" ? new Date(`${vipExpiresAt}T23:59:59+08:00`).toISOString() : null,
        reminderLimitOverride: reminderLimitOverride === "" ? null : Number(reminderLimitOverride),
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "用户资料保存失败");
      setSaving(false);
    }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
    <section className="modal admin-user-modal" role="dialog" aria-modal="true" aria-label={user ? "编辑用户" : "新增用户"}>
      <header><div><span className="eyebrow">用户管理</span><h2>{user ? "编辑用户资料" : "创建新用户"}</h2></div><button className="icon-button" onClick={onClose} disabled={saving} aria-label="关闭"><X size={19} /></button></header>
      <form className="admin-user-form" onSubmit={submit}>
        {formError && <div className="form-error">{formError}</div>}
        <div className="admin-form-grid">
          <label>用户名<input value={username} onChange={(event) => setUsername(event.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32))} /></label>
          <label>昵称<input value={displayName} onChange={(event) => setDisplayName(event.target.value.slice(0, 30))} /></label>
        </div>
        <label>管理员备注<textarea value={adminNote} onChange={(event) => setAdminNote(event.target.value.slice(0, 200))} placeholder="例如：测试账号、客户来源、特殊需求（仅管理员可见）" /><small>{adminNote.length} / 200，仅在管理后台显示。</small></label>
        <label>{user ? "重置密码（留空则不修改）" : "初始密码"}<input type="password" value={password} onChange={(event) => setPassword(event.target.value.slice(0, 72))} placeholder={user ? "不修改密码" : "至少 8 位"} /></label>
        <label>时区<select value={timezone} onChange={(event) => setTimezone(event.target.value)}><option value="Asia/Shanghai">中国标准时间</option><option value="Asia/Hong_Kong">香港时间</option><option value="Asia/Taipei">台北时间</option></select></label>
        <fieldset><legend>账号状态</legend><div className="segmented"><button type="button" className={accountStatus === "active" ? "active" : ""} onClick={() => setAccountStatus("active")}>正常</button><button type="button" className={accountStatus === "disabled" ? "active" : ""} onClick={() => setAccountStatus("disabled")} disabled={user?.role === "admin"}>禁用</button></div></fieldset>
        <fieldset><legend>VIP 类型</legend><div className="segmented three"><button type="button" className={vipType === "none" ? "active" : ""} onClick={() => setVipType("none")}>普通用户</button><button type="button" className={vipType === "monthly" ? "active" : ""} onClick={() => setVipType("monthly")}>月卡 VIP</button><button type="button" className={vipType === "permanent" ? "active" : ""} onClick={() => setVipType("permanent")}>永久 VIP</button></div></fieldset>
        {vipType === "monthly" && <label>VIP 到期日<input type="date" value={vipExpiresAt} min={TODAY} onChange={(event) => setVipExpiresAt(event.target.value)} /></label>}
        <label>提醒数量上限<input type="number" min="0" max="1000" value={reminderLimitOverride} onChange={(event) => setReminderLimitOverride(event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder={`跟随会员默认（当前 ${user?.reminderLimit ?? (vipType === "permanent" ? 20 : vipType === "monthly" ? 10 : 1)} 条）`} /><small>留空时自动使用：普通用户 1 条、月卡 VIP 10 条、永久 VIP 20 条。</small></label>
        <div className="modal-actions"><button className="secondary" type="button" onClick={onClose} disabled={saving}>取消</button><button className="primary" type="submit" disabled={saving}>{saving ? "保存中" : "保存用户"}</button></div>
      </form>
    </section>
  </div>;
}

function AdminReminderEditor({ reminder, onClose, onSave }: { reminder: AdminReminder; onClose: () => void; onSave: (payload: { title: string; scheduledAt: string; status: "upcoming" | "paused" | "cancelled" }) => Promise<void> }) {
  const reminderDate = new Date(reminder.scheduledAt);
  const [title, setTitle] = useState(reminder.title);
  const [scheduledAt, setScheduledAt] = useState(new Date(reminderDate.getTime() - reminderDate.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  const [status, setStatus] = useState<"upcoming" | "paused">(reminder.status);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return setFormError("请输入提醒事项");
    const date = new Date(scheduledAt);
    if (status === "upcoming" && (Number.isNaN(date.getTime()) || date <= new Date())) return setFormError("待提醒时间必须晚于现在");
    setSaving(true);
    setFormError("");
    try {
      await onSave({ title: title.trim(), scheduledAt: date.toISOString(), status });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "提醒保存失败");
      setSaving(false);
    }
  }

  async function cancelReminder() {
    if (!window.confirm(`确定取消提醒“${reminder.title}”吗？`)) return;
    setSaving(true);
    try {
      await onSave({ title: title.trim() || reminder.title, scheduledAt: new Date(scheduledAt).toISOString(), status: "cancelled" });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "取消提醒失败");
      setSaving(false);
    }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
    <section className="modal admin-reminder-modal" role="dialog" aria-modal="true" aria-label="编辑用户提醒">
      <header><div><span className="eyebrow">提醒管理</span><h2>编辑提醒</h2></div><button className="icon-button" onClick={onClose} disabled={saving} aria-label="关闭"><X size={19} /></button></header>
      <form className="admin-user-form" onSubmit={submit}>
        {formError && <div className="form-error">{formError}</div>}
        <label>提醒事项<input value={title} onChange={(event) => setTitle(event.target.value.slice(0, 200))} /></label>
        <label>提醒时间<input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /></label>
        <fieldset><legend>提醒状态</legend><div className="segmented"><button type="button" className={status === "upcoming" ? "active" : ""} onClick={() => setStatus("upcoming")}>待提醒</button><button type="button" className={status === "paused" ? "active" : ""} onClick={() => setStatus("paused")}>已暂停</button></div></fieldset>
        <div className="modal-actions"><button className="secondary danger-text" type="button" onClick={cancelReminder} disabled={saving}><Trash2 size={15} />取消提醒</button><button className="secondary" type="button" onClick={onClose} disabled={saving}>关闭</button><button className="primary" type="submit" disabled={saving}>{saving ? "保存中" : "保存修改"}</button></div>
      </form>
    </section>
  </div>;
}

function AdminDeliveries({ deliveries, allDeliveries, filter, onFilter, onRetry, onHandle, retryingId, loading, errorGroups }: { deliveries: AdminDelivery[]; allDeliveries: AdminDelivery[]; filter: AdminDeliveryFilter; onFilter: (filter: AdminDeliveryFilter) => void; onRetry: (id: string) => void; onHandle: (delivery: AdminDelivery) => void; retryingId: string; loading: boolean; errorGroups: { code: string; count: number }[] }) {
  const sent = allDeliveries.filter((item) => item.status === "sent").length;
  const problems = allDeliveries.filter((item) => !item.handledAt && ["failed", "blocked"].includes(item.status)).length;
  const handled = allDeliveries.filter((item) => item.handledAt).length;
  if (loading && allDeliveries.length === 0) return <div className="admin-loading"><RefreshCw className="spin" size={20} />正在加载投递数据</div>;
  return <section className="admin-deliveries">
    {errorGroups.length > 0 && <div className="admin-error-groups">{errorGroups.slice(0, 5).map((group) => <span key={group.code}><b>{group.count}</b>{group.code}</span>)}</div>}
    <div className="list-head admin-delivery-head">
      <div className="tabs">
        <button className={filter === "all" ? "active" : ""} onClick={() => onFilter("all")}>最近投递 <span>{allDeliveries.length}</span></button>
        <button className={filter === "sent" ? "active" : ""} onClick={() => onFilter("sent")}>已发送 <span>{sent}</span></button>
        <button className={filter === "problem" ? "active" : ""} onClick={() => onFilter("problem")}>异常 <span>{problems}</span></button>
        <button className={filter === "handled" ? "active" : ""} onClick={() => onFilter("handled")}>已处理 <span>{handled}</span></button>
      </div>
      <small>最多显示最近 100 条</small>
    </div>
    <div className="admin-delivery-table">
      <div className="admin-delivery-table-head"><span>提醒与用户</span><span>状态</span><span>尝试</span><span>计划时间</span><span>处理结果</span></div>
      {deliveries.map((delivery) => <AdminDeliveryRow delivery={delivery} onRetry={onRetry} onHandle={onHandle} retrying={retryingId === delivery.id} key={delivery.id} />)}
      {deliveries.length === 0 && <div className="empty"><History size={30} /><h3>没有符合条件的投递</h3><p>提醒进入发送流程后会显示在这里。</p></div>}
    </div>
  </section>;
}

function AdminDeliveryRow({ delivery, onRetry, onHandle, retrying }: { delivery: AdminDelivery; onRetry: (id: string) => void; onHandle: (delivery: AdminDelivery) => void; retrying: boolean }) {
  const timing = formatDeliveryTiming(delivery.latencyMs);
  const status = {
    pending: { label: "等待发送", detail: "已进入队列" },
    sent: { label: "已发送", detail: delivery.sentAt ? formatAdminDate(delivery.sentAt) : "投递成功" },
    failed: { label: "发送失败", detail: delivery.errorCode || "等待重试" },
    blocked: { label: "已阻塞", detail: delivery.errorCode || "连接不可用" },
  }[delivery.status];
  const StatusIcon = delivery.status === "sent" ? CheckCircle2 : delivery.status === "pending" ? RefreshCw : CircleAlert;
  return <article className={`admin-delivery-row ${delivery.handledAt ? "handled" : delivery.status}`}>
    <div className="admin-delivery-primary"><span className="admin-delivery-icon"><StatusIcon className={delivery.status === "pending" ? "spin" : ""} size={17} /></span><div><b>{delivery.title}</b><small>{delivery.displayName} · @{delivery.username}</small></div></div>
    <div className="admin-delivery-status"><b>{delivery.handledAt ? "已处理" : status.label}</b><small>{delivery.handledAt ? delivery.handlingNote || formatAdminDate(delivery.handledAt) : status.detail}</small></div>
    <div className="admin-delivery-attempt">{delivery.attempt > 1 ? `第 ${delivery.attempt} 次` : "首次"}</div>
    <div className="admin-date">{formatAdminDate(delivery.scheduledAt)}</div>
    <div className="admin-delivery-result"><span>{delivery.handledAt ? "已关闭告警" : delivery.status === "sent" ? timing || "iLink 已确认" : delivery.status === "pending" ? "处理中" : "待处理"}</span>{!delivery.handledAt && ["failed", "blocked"].includes(delivery.status) && <div className="delivery-actions"><button className="icon-button admin-retry-delivery" onClick={() => onRetry(delivery.id)} disabled={retrying} aria-label="重试投递" title="重试投递"><RefreshCw className={retrying ? "spin" : ""} size={15} /></button><button className="icon-button admin-handle-delivery" onClick={() => onHandle(delivery)} aria-label="标记已处理" title="标记已处理"><CheckCircle2 size={15} /></button></div>}</div>
  </article>;
}
