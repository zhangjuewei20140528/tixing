#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import smtplib
import socket
import ssl
import subprocess
import urllib.request
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path

APP_DIR = Path(os.environ.get("TIXING_APP_DIR", "/opt/tixing"))
ENV_FILE = APP_DIR / ".env.local"
STATE_FILE = Path("/var/lib/tixing-ops/state.json")
SERVICES = ("tixing-web", "tixing-worker")


def load_env(path: Path):
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def run(args, timeout=20):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def db_scalar(sql: str, default=0):
    result = run(["docker", "exec", "tixing-postgres", "psql", "-U", "tixing", "-d", "tixing", "-Atc", sql])
    if result.returncode != 0:
        raise RuntimeError(f"database check failed: {result.stderr.strip()[:160]}")
    value = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
    return value if value else default


def service_active(name: str):
    return run(["systemctl", "is-active", "--quiet", name]).returncode == 0


def restart_service(name: str):
    return run(["systemctl", "restart", name], timeout=45).returncode == 0


def memory_percent():
    values = {}
    for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
        key, value = line.split(":", 1)
        values[key] = int(value.strip().split()[0])
    total = values.get("MemTotal", 1)
    available = values.get("MemAvailable", 0)
    return round((total - available) * 100 / total, 1)


def certificate_days(host: str):
    context = ssl.create_default_context()
    with socket.create_connection((host, 443), timeout=10) as sock:
        with context.wrap_socket(sock, server_hostname=host) as wrapped:
            expires = wrapped.getpeercert()["notAfter"]
    expiry = datetime.strptime(expires, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    return (expiry - datetime.now(timezone.utc)).days


def web_healthy(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": "tixing-ops-monitor/1.0"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return 200 <= response.status < 400


def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"active_incidents": [], "last_report_date": "", "last_restarts": {}}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(STATE_FILE)


def send_email(subject: str, body: str):
    host = os.environ.get("SMTP_HOST", "smtp.qq.com")
    port = int(os.environ.get("SMTP_PORT", "465"))
    username = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASS", "")
    recipient = os.environ.get("OPS_ALERT_EMAIL", username)
    if not username or not password or not recipient:
        raise RuntimeError("SMTP configuration is incomplete")
    message = EmailMessage()
    message["From"] = username
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(body)
    with smtplib.SMTP_SSL(host, port, timeout=20, context=ssl.create_default_context()) as client:
        client.login(username, password)
        client.send_message(message)


def daily_summary(metrics):
    return "\n".join([
        "准点提醒助手每日运维摘要",
        "",
        f"生成时间：{datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}",
        f"注册用户：{metrics.get('users', '--')}",
        f"有效提醒：{metrics.get('active_reminders', '--')}",
        f"今日成功投递：{metrics.get('sent_today', '--')}",
        f"今日异常投递：{metrics.get('problem_today', '--')}",
        f"今日 AI 调用：{metrics.get('ai_today', '--')}",
        f"今日 AI Token：{metrics.get('tokens_today', '--')}",
        f"磁盘使用率：{metrics.get('disk_percent', '--')}%",
        f"内存使用率：{metrics.get('memory_percent', '--')}%",
        f"HTTPS 证书剩余：{metrics.get('certificate_days', '--')} 天",
        "",
        "本邮件由自动运维系统发送。",
    ])


def check_system():
    incidents = []
    actions = []
    metrics = {}
    state = load_state()
    now_ts = int(datetime.now().timestamp())
    restart_cooldown = int(os.environ.get("OPS_RESTART_COOLDOWN_SECONDS", "600"))

    for service in SERVICES:
        if service_active(service):
            continue
        incidents.append(f"{service} 服务已停止")
        last_restart = int(state.get("last_restarts", {}).get(service, 0))
        if now_ts - last_restart >= restart_cooldown:
            success = restart_service(service)
            state.setdefault("last_restarts", {})[service] = now_ts
            actions.append(f"{'已重启' if success else '重启失败'}：{service}")

    try:
        worker_age = int(db_scalar("select coalesce(extract(epoch from (now()-last_seen_at))::int,999999) from service_heartbeats where service='worker';", 999999))
        metrics["worker_heartbeat_age"] = worker_age
        if worker_age > int(os.environ.get("OPS_WORKER_STALE_SECONDS", "180")):
            incidents.append(f"worker 心跳已中断 {worker_age} 秒")
            last_restart = int(state.get("last_restarts", {}).get("tixing-worker", 0))
            if now_ts - last_restart >= restart_cooldown:
                success = restart_service("tixing-worker")
                state.setdefault("last_restarts", {})["tixing-worker"] = now_ts
                actions.append(f"{'已重启' if success else '重启失败'}：tixing-worker（心跳异常）")

        metrics["recent_delivery_problems"] = int(db_scalar("select count(*) from delivery_attempts where status in ('failed','blocked') and created_at > now()-interval '15 minutes';"))
        metrics["overdue_reminders"] = int(db_scalar("select count(*) from reminders where status='upcoming' and scheduled_at < now()-interval '5 minutes';"))
        metrics["recent_ai_failures"] = int(db_scalar("select count(*) from ai_intent_usages where status='failed' and created_at > now()-interval '15 minutes';"))
        if metrics["recent_delivery_problems"] >= int(os.environ.get("OPS_DELIVERY_FAILURE_THRESHOLD", "1")):
            incidents.append(f"最近 15 分钟异常投递 {metrics['recent_delivery_problems']} 次")
        if metrics["overdue_reminders"] > 0:
            incidents.append(f"发现 {metrics['overdue_reminders']} 条超过 5 分钟仍未处理的提醒")
        if metrics["recent_ai_failures"] >= int(os.environ.get("OPS_AI_FAILURE_THRESHOLD", "5")):
            incidents.append(f"最近 15 分钟 AI 解析失败 {metrics['recent_ai_failures']} 次")

        metrics["users"] = int(db_scalar("select count(*) from users;"))
        metrics["active_reminders"] = int(db_scalar("select count(*) from reminders where status in ('upcoming','paused');"))
        metrics["sent_today"] = int(db_scalar("select count(*) from delivery_attempts where status='sent' and created_at >= date_trunc('day',now());"))
        metrics["problem_today"] = int(db_scalar("select count(*) from delivery_attempts where status in ('failed','blocked') and created_at >= date_trunc('day',now());"))
        metrics["ai_today"] = int(db_scalar("select count(*) from ai_intent_usages where created_at >= date_trunc('day',now());"))
        metrics["tokens_today"] = int(db_scalar("select coalesce(sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)),0) from ai_intent_usages where created_at >= date_trunc('day',now());"))
    except Exception as error:
        incidents.append(f"数据库健康检查失败：{str(error)[:160]}")

    disk = shutil.disk_usage("/")
    metrics["disk_percent"] = round(disk.used * 100 / disk.total, 1)
    metrics["memory_percent"] = memory_percent()
    if metrics["disk_percent"] >= float(os.environ.get("OPS_DISK_WARNING_PERCENT", "85")):
        incidents.append(f"磁盘使用率达到 {metrics['disk_percent']}%")
    if metrics["memory_percent"] >= float(os.environ.get("OPS_MEMORY_WARNING_PERCENT", "90")):
        incidents.append(f"内存使用率达到 {metrics['memory_percent']}%")

    try:
        if not web_healthy(os.environ.get("OPS_HEALTH_URL", "http://localhost:3100/")):
            incidents.append("公网网站健康检查失败")
    except Exception as error:
        incidents.append(f"公网网站无法访问：{str(error)[:120]}")
    cert_host = os.environ.get("OPS_CERT_HOST", "").strip()
    if cert_host:
        try:
            metrics["certificate_days"] = certificate_days(cert_host)
            if metrics["certificate_days"] < int(os.environ.get("OPS_CERT_WARNING_DAYS", "14")):
                incidents.append(f"HTTPS 证书仅剩 {metrics['certificate_days']} 天")
        except Exception as error:
            incidents.append(f"HTTPS 证书检查失败：{str(error)[:120]}")

    previous = set(state.get("active_incidents", []))
    current = set(incidents)
    new_incidents = sorted(current - previous)
    recovered = sorted(previous - current)
    state["active_incidents"] = sorted(current)

    if new_incidents or recovered or actions:
        sections = [f"检查时间：{datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}"]
        if new_incidents:
            sections.append("\n新增异常：\n- " + "\n- ".join(new_incidents))
        if actions:
            sections.append("\n自动处理：\n- " + "\n- ".join(actions))
        if recovered:
            sections.append("\n已恢复：\n- " + "\n- ".join(recovered))
        subject = "[准点告警] 系统发现异常" if new_incidents else "[准点恢复] 系统状态已更新"
        send_email(subject, "\n".join(sections))

    today = datetime.now().astimezone().strftime("%Y-%m-%d")
    report_hour = int(os.environ.get("OPS_DAILY_REPORT_HOUR", "9"))
    if datetime.now().astimezone().hour >= report_hour and state.get("last_report_date") != today:
        send_email(f"[准点日报] {today} 运行摘要", daily_summary(metrics))
        state["last_report_date"] = today

    save_state(state)
    print(json.dumps({"incidents": incidents, "actions": actions, "metrics": metrics}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-email", action="store_true")
    args = parser.parse_args()
    load_env(ENV_FILE)
    global STATE_FILE
    STATE_FILE = Path(os.environ.get("OPS_STATE_FILE", str(STATE_FILE)))
    if args.test_email:
        send_email("[准点测试] 自动运维邮件已连接", "QQ 邮箱 SMTP 配置成功。准点自动运维系统可以发送故障、恢复和每日摘要邮件。")
        print("test email sent")
        return
    check_system()


if __name__ == "__main__":
    main()
