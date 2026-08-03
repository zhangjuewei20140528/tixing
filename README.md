# 准点

以微信 iLink 为送达渠道的轻量提醒产品。项目内置轻量微信 Connector，不要求安装 OpenClaw。

这是一个可自托管的开源 MVP。网页负责账户、微信绑定和提醒管理，后台负责解析、调度、投递和失败记录。生产环境请自行配置微信 iLink、数据库、AI 服务和运维告警；仓库不包含任何生产凭据或用户数据。

## 界面预览

### 用户首页

![准点用户首页](docs/screenshots/tixing-new-landing-v2.png)

### 管理员运营后台

![准点管理员运营后台](docs/screenshots/tixing-production-admin-final.png)

### 常见问题与产品说明

![准点常见问题页面](docs/screenshots/tixing-full-section6.png)

## 安全配置

```bash
Copy-Item .env.example .env.local
```

然后填写唯一的 `SESSION_SECRET`、`TOKEN_ENCRYPTION_KEY`、数据库密码和第三方服务密钥。不要提交 `.env.local`、数据库目录、二维码截图、日志或发布压缩包。公开部署前还应启用 HTTPS、限制管理员账号访问并配置密钥轮换。

## 本地运行

本地默认使用 PGlite（嵌入式 PostgreSQL），不需要安装数据库或 Docker。

```bash
pnpm install
pnpm db:migrate:local
pnpm dev
```

PGlite 模式的到期任务执行器会运行在 Next.js 进程内，不需要另开 worker。

访问 `http://localhost:3100`，使用用户名和密码注册或登录。

## 已实现

- 用户名和密码注册、登录
- HttpOnly Cookie 登录会话
- 用户数据隔离
- 普通用户与管理员独立工作台，管理员 API 执行服务端权限校验
- 管理员运营总览、用户列表及用户资料增删改查
- 账号正常/禁用状态管理，禁用后现有会话同步失效
- 月卡 VIP（¥4.99 / 30 天）和永久 VIP 状态
- 管理员可授权、取消或调整用户 VIP 到期时间
- 管理员投递监控，支持状态筛选以及按提醒、用户和错误码搜索
- 提醒创建、查询、完成和取消 API
- 网页端支持修改待提醒时间，改期与状态变更均使用版本校验
- 一次、每天、每周提醒
- 工作日重复提醒，周六和周日自动跳过
- 每月指定日期和每月最后一天提醒，短月份自动落到月末且后续恢复原目标日期
- Drizzle 数据模型和版本化 SQL 迁移
- pg-boss 延迟任务、重试和幂等投递键
- 服务启动及运行期间自动补排遗漏任务，支持跨天提醒
- 稳定的 iLink 客户端消息 ID，网络重试不会重复发送同一期提醒
- 微信修改、取消、暂停和恢复命令使用独立持久化回执防重放，180 天后自动清理
- 每次投递的成功、失败、阻塞记录
- 网页“投递记录”工作视图，提供真实状态统计、筛选、尝试次数和自动刷新
- 当前用户投递记录查询 API（包含尝试次数和服务商消息 ID）
- AES-256-GCM 加密微信 iLink 凭据
- 真实微信 iLink 二维码申请、扫码轮询和数字验证
- 无 OpenClaw 的轻量微信文本投递
- 微信对话创建、查看、修改时间和取消提醒，无需大模型
- 本地中文规则支持中文钟点、点半/一刻、明早/明晚、明确月日和一个半小时等常用表达
- 每天、每周重复提醒支持在网页或微信暂停与恢复
- 微信收到提醒后可回复“10分钟后再提醒我”等命令，延后最近一次真实发送成功的事项
- 恢复或延迟执行时直接安排下一次未来周期，不连续补发已错过的旧周期
- 改期后的旧队列任务会校验预期执行时间，避免在原时间提前投递
- 连接成功后通过正式队列发送测试提醒，并以投递审计状态确认结果
- 同一微信身份只能绑定一个网站账号，避免跨账号串绑
- PGlite 本地开发和 PostgreSQL 生产模式

## VIP 模块

当前只提供一种可售套餐：月卡 VIP，价格 `¥4.99`，有效期 30 天。系统同时支持管理员直接配置永久 VIP。

VIP 状态独立于支付渠道保存，字段为 `none`、`monthly`、`permanent`；月卡使用独立到期时间。当前版本尚未接入在线支付，用户端仅展示套餐和会员状态，后续支付成功回调只需更新对应用户的 VIP 状态即可。

管理员可以新增、查看、编辑、禁用和删除普通用户，也可以重置密码、修改昵称和时区。管理员账号不能被禁用或删除。

## 生产 PostgreSQL

Docker 可用时：

```bash
docker compose up -d
```

然后设置：

```env
DATABASE_MODE=postgres
DATABASE_URL=postgresql://tixing:tixing_dev_password@localhost:54329/tixing
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请使用至少12位的强密码
ADMIN_LEGACY_PHONE=旧管理员手机号（仅首次迁移需要）
```

用户通过用户名和密码注册、登录，登录后扫码绑定自己的微信。注册接口只能创建普通用户；管理员角色保存在数据库中，首次部署或从手机号登录迁移时执行 `pnpm admin:bootstrap` 初始化管理员。

执行：

```bash
pnpm db:migrate
pnpm dev
pnpm worker
```

PGlite 只用于单机开发。它在 Windows 上不能被多个进程同时打开，因此本地 worker 采用进程内模式；部署和多实例 worker 必须使用 PostgreSQL。

## 微信连接

内置 Connector 直接调用腾讯 iLink 协议，职责只包括申请二维码、查询扫码状态和发送提醒。业务数据库仍然是提醒和账号归属的事实来源。真实投递始终同时使用：

```ts
{
  accountId: string;
  to: string; // weixin_user_id
  botToken: string; // AES-256-GCM 加密存储
  baseUrl: string;
  content: string;
  idempotencyKey: string;
}
```

网页扫码已经是真实微信流程，不再提供“模拟扫码成功”入口。iLink 协议的长期稳定性、主动发送时限和商业使用边界仍需通过 7 天 POC 验证，不能在验证完成前承诺付费提醒必达。

绑定完成后可在“管理微信连接”中发送测试提醒。测试消息仍经过提醒表、pg-boss 队列和投递审计链路；只有服务商返回成功且投递记录变为 `sent`，网页才会显示发送成功。

微信入站使用 iLink `getupdates` HTTP 长轮询。每个绑定只保存轮询游标，不保存完整聊天历史；自然语言时间由本地规则解析，消息来源 ID 用于防止重复创建提醒。PGlite 模式由 Next.js 进程启动入站轮询，生产 PostgreSQL 模式由 `pnpm worker` 同时承担提醒投递与入站轮询。

提醒创建后不需要用户每天发送消息激活。任务会持久化在 PostgreSQL/pg-boss 中，维护进程每分钟检查一次未排队或到期未完成的提醒；投递失败会复用稳定客户端消息 ID 重试，并在投递审计中累计尝试次数。服务器持续运行且 iLink 凭据有效仍是按时发送的必要条件。

## 验证

```bash
pnpm test
pnpm lint
pnpm build
```

生产构建固定使用 PostgreSQL 驱动进行编译，避免构建 worker 并发打开本地 PGlite 文件。
