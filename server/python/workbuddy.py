#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkBuddy 保活 + 续期(青龙版 · 主动模式)

全部参数已内置在下方【配置区】, 直接编辑即可, 无需环境变量。
(环境变量仍可覆盖内置值, 便于青龙面板里临时调参而不改文件。)

用法:
    python3 keepalive.py
    nohup python3 keepalive.py > /dev/null 2>&1 &     # 后台常驻

机制来源: 反查官方前端 shared-account-http-*.js 的 StreamableHTTP ACP 客户端。

主动保活三途径(ACP 协议本身没有 ping 方法):
    1) 高频重建 SSE 连接   —— 不给上游"空闲"判定的机会
    2) TCP 层 keepalive    —— 内核级探活, 防中间设备静默掐断
    3) 独立脉冲通道  https://copilot.tencent.com/v2/as/conversations/{CONV_ID}/session       —— 定期刷新平台侧"会话活跃"标记
    4) 可选业务探测         —— 顺带探测你自己的站点是否还在响应

调参指引:
    频繁"心跳超时"     -> 调大 HEARTBEAT_TIMEOUT
    规律性断线         -> 设 IDLE_RECYCLE 略小于该周期, 主动前置轮换
    频繁"上游截断"     -> 代理在掐, 调小 HEARTBEAT_TIMEOUT / 开 IDLE_RECYCLE
"""
import os
import sys
import json
import gzip
import uuid
import time
import base64
import random
import signal
import threading
from datetime import datetime
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import ssl
import socket

# ==================================================================
#                       配置区(内置参数, 直接改这里)
# ==================================================================

# ---------- 平台与会话 ----------
# 切换保活对象时改这三项即可(或设 WB_CONV_ID 环境变量覆盖)。
#
#   当前沙箱(活着)   CONV_ID = "CONVERSATION_ID"
#   1panel 沙箱      CONV_ID = "CONVERSATION_ID"   # 曾长期 CREATING, 可能已回收
BASE    = "https://copilot.tencent.com"
CONV_ID = ""
UID = ""

# ---------- 凭据(已内置) ----------
# 注意: 该 RT 为长期令牌(Offline 类型), 等同于账号通行证。
#       本文件请勿分享 / 上传网盘 / 提交到仓库。
#       如已泄露, 请到后台吊销会话后重新签发, 再替换下面这一行。
JWT = ""
RT = ""

# ---------- 可选: 业务站点探测 ----------
# 探测你的服务是否还在响应, 连续失败 N 次就主动重连(顺带刷新沙箱活跃度)。
# 仅作为附加信号; 留空则关闭(保活完全依赖 ACP 通道本身)。
SITE = ""
SITE_ENABLE     = bool(SITE)
SITE_CHECK_INT  = 30          # 探测间隔(s)
SITE_FAIL_LIMIT = 2           # 连续失败多少次触发重连

# ---------- 保活参数(主动模式) ----------
HEARTBEAT_TIMEOUT = 10        # 无数据超过此秒数即主动重连(官方客户端为 60)
                              #   日志频繁"心跳超时" -> 调大
IDLE_RECYCLE      = 0         # >0: 连接存活超过此秒数就主动轮换(0=关闭)
                              #   日志规律性断线(如固定几小时) -> 设成略小于该周期
RECONNECT_BASE    = 300       # 重连退避基数(ms), 越小恢复越快
RECONNECT_MAX     = 3000      # 重连退避上限(ms)
RECONNECT_JITTER  = True      # ±25% 抖动, 防惊群

CONNECT_TIMEOUT   = 30        # 建连超时(s)
READ_TIMEOUT      = 2         # 单次 socket read 超时(s), 便于高频轮转检测

# ---------- TCP 层 keepalive(内核探活) ----------
TCP_KEEPALIVE = True
TCP_KEEPIDLE  = 10            # 空闲多少秒后开始探活
TCP_KEEPINTVL = 5             # 探活间隔(s)
TCP_KEEPCNT   = 3             # 连续多少次无响应判定死链

# ---------- 第二通道: 会话活跃脉冲 ----------
PULSE_ENABLE   = True
PULSE_INTERVAL = 30           # 每多少秒刷新一次"会话活跃"

# ---------- 续期 ----------
RENEW_THRESHOLD = 7 * 86400   # 令牌剩余不足此秒数时自动续期(默认 7 天)

# ---------- 状态 / 日志 ----------
STATE_ENABLE = True           # 续期后的令牌落盘, 重启可复用
STATE_FILE   = ""             # 留空 = 同目录 uid_<UID>.json
LOG_TO_FILE  = True           # 日志同时落盘(追写, 便于排查断线规律)
LOG_FILE     = ""             # 留空 = 同目录 keepalive.log

# ==================================================================
# 以上为全部可调项。以下为运行时初始化, 一般无需修改。
# ==================================================================

BASE    = os.environ.get("WB_BASE", BASE).rstrip("/")
CONV_ID = os.environ.get("WB_CONV_ID", CONV_ID)
UID     = os.environ.get("WB_UID", UID)
JWT     = os.environ.get("WB_JWT", JWT)
RT      = os.environ.get("WB_RT", RT)
SITE    = os.environ.get("WB_SITE", SITE)

HEARTBEAT_TIMEOUT = int(os.environ.get("WB_HEARTBEAT", HEARTBEAT_TIMEOUT))
HEARTBEAT_CHECK   = max(1, HEARTBEAT_TIMEOUT // 5)
IDLE_RECYCLE      = int(os.environ.get("WB_RECYCLE", IDLE_RECYCLE))
RECONNECT_BASE    = int(os.environ.get("WB_RECONNECT_BASE", RECONNECT_BASE))
RECONNECT_MAX     = int(os.environ.get("WB_RECONNECT_MAX", RECONNECT_MAX))

TCP_KEEPALIVE = str(os.environ.get("WB_TCP_KEEPALIVE", "1" if TCP_KEEPALIVE else "0")) != "0"
TCP_KEEPIDLE  = int(os.environ.get("WB_TCP_KEEPIDLE", TCP_KEEPIDLE))
TCP_KEEPINTVL = int(os.environ.get("WB_TCP_KEEPINTVL", TCP_KEEPINTVL))
TCP_KEEPCNT   = int(os.environ.get("WB_TCP_KEEPCNT", TCP_KEEPCNT))

PULSE_ENABLE   = str(os.environ.get("WB_PULSE", "1" if PULSE_ENABLE else "0")) != "0"
PULSE_INTERVAL = int(os.environ.get("WB_PULSE_INTERVAL", PULSE_INTERVAL))

RENEW_THRESHOLD = int(os.environ.get("WB_RENEW_DAYS", RENEW_THRESHOLD // 86400)) * 86400
STATE_ENABLE    = str(os.environ.get("WB_STATE", "1" if STATE_ENABLE else "0")) != "0"

SITE_ENABLE     = bool(SITE) and str(os.environ.get("WB_SITE_ENABLE", "1")) != "0"
SITE_CHECK_INT  = int(os.environ.get("WB_SITE_INTERVAL", SITE_CHECK_INT))
SITE_FAIL_LIMIT = int(os.environ.get("WB_SITE_FAIL_LIMIT", SITE_FAIL_LIMIT))

# 会话 ID 兜底
if not CONV_ID:
    CONV_ID = os.environ.get("CODEBUDDY_AGENTOS_SESSION_ID", "")

HERE = os.path.dirname(os.path.abspath(__file__))
if not STATE_FILE:
    STATE_FILE = os.path.join(HERE, f"uid_{UID}.json" if UID else "uid_unknown.json")
if not LOG_FILE:
    LOG_FILE = os.path.join(HERE, "keepalive.log")

# ==================================================================

_running = True


def _sigterm(signum, frame):
    global _running
    _running = False
    log(f"收到信号 {signum}, 准备退出...")
    sys.exit(0)


signal.signal(signal.SIGTERM, _sigterm)


now = lambda: datetime.now().strftime("%F %T")

_log_fp = None


def _init_log_fp():
    global _log_fp
    if not LOG_TO_FILE:
        return
    try:
        _log_fp = open(LOG_FILE, "a", encoding="utf-8", buffering=1)
    except Exception as e:
        print(f"[warn] 日志文件打开失败({e}), 仅输出控制台", flush=True)
        _log_fp = None


def log(*a):
    line = f"[{now()}] " + " ".join(str(x) for x in a)
    print(line, flush=True)
    if _log_fp:
        try:
            _log_fp.write(line + "\n")
        except Exception:
            pass


def b64d(s: str) -> bytes:
    s = s.strip()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def jwt_payload(t: str):
    try:
        t = t[7:] if t.startswith("Bearer ") else t
        return json.loads(b64d(t.split(".")[1]))
    except Exception:
        return None


def jwt_exp(t: str):
    p = jwt_payload(t)
    return p.get("exp") if p else None


# ==================== 状态保存 / 读取 ====================

def save_state():
    if not STATE_ENABLE:
        return
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump({"JWT": JWT, "RT": RT, "updated": datetime.now().isoformat()},
                      f, ensure_ascii=False, indent=2)
        log("状态已保存:", STATE_FILE)
    except Exception as e:
        log("!! 保存状态失败", e)


def load_state():
    global JWT, RT
    if not STATE_ENABLE or not os.path.exists(STATE_FILE):
        return False
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            d = json.load(f)
        # 配置区显式填了值就优先用配置区的, 否则用落盘的
        if d.get("JWT") and not JWT:
            JWT = d["JWT"]
        if d.get("RT") and not RT:
            RT = d["RT"]
        log("已读取状态文件(复用最新 token)")
        return True
    except Exception:
        return False


# ==================== 续期 ====================

def refresh():
    global JWT, RT
    if not RT:
        log("!! 无 RT, 无法续期")
        return False
    host = BASE.split("//")[-1].split("/")[0]
    h = {
        "User-Agent": "Dart/3.11 (dart:io)",
        "x-client-version": "1.2.2",
        "Host": host,
        "x-client-request-id": "c_" + uuid.uuid4().hex[:12],
        "x-refresh-token": RT,
    }
    try:
        req = Request(BASE + "/v2/plugin/auth/token/refresh", data=b"", headers=h, method="POST")
        with urlopen(req, timeout=20) as r:
            d = json.loads(r.read().decode("utf-8", "ignore"))["data"]
            JWT = d["accessToken"]
            if d.get("refreshToken"):
                RT = d["refreshToken"]
            save_state()
            log(f"续期成功! JWTlen={len(JWT)} RTlen={len(RT)}")
            return True
    except HTTPError as e:
        try:
            body = e.read().decode("utf-8", "ignore")[:150]
        except Exception:
            body = ""
        log("!! 续期 HTTP", e.code, body)
    except Exception as e:
        log("!! 续期失败", type(e).__name__, e)
    return False


def ensure_valid():
    exp = jwt_exp(JWT)
    left = (exp - time.time()) if exp else 0
    if exp and left < RENEW_THRESHOLD:
        log(f"JWT 剩余 {int(left / 86400)} 天, 触发续期")
        return refresh()
    return True


# ==================== HTTP 基础 ====================

_ctx = ssl.create_default_context()


def enable_tcp_keepalive(sock):
    """内核级保活: 中间设备静默丢包时, 内核能探出死链并报错, 而不是无限挂住"""
    if not TCP_KEEPALIVE or sock is None:
        return
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        for name, val in (("TCP_KEEPIDLE", TCP_KEEPIDLE),
                          ("TCP_KEEPINTVL", TCP_KEEPINTVL),
                          ("TCP_KEEPCNT", TCP_KEEPCNT)):
            opt = getattr(socket, name, None)
            if opt is not None:
                sock.setsockopt(socket.IPPROTO_TCP, opt, val)
    except Exception:
        pass


def sock_of(resp):
    """从 urllib 响应里挖出底层 socket"""
    for attr in ("fp", "raw", "_fp"):
        o = getattr(resp, attr, None)
        if o is None:
            continue
        s = getattr(o, "_sock", None) or getattr(o, "_sock" if hasattr(o, "_sock") else "sock", None)
        if s is not None:
            return s
    return None


def classify_exc(e):
    """给异常一个人类可读的中文标签, 便于判断是谁在掐连接"""
    n = type(e).__name__
    s = str(e)
    if "timed out" in s.lower() or isinstance(e, TimeoutError) or "Timeout" in n:
        return "读取超时"
    if "IncompleteRead" in n or "IncompleteRead" in s:
        return "上游截断(IncompleteRead)"
    if "RemoteDisconnected" in n or "RemoteDisconnected" in s:
        return "对端断开(RemoteDisconnected)"
    if "Connection reset" in s or "ConnectionReset" in n:
        return "连接重置"
    if isinstance(e, URLError):
        return f"网络错误({e.reason})"
    return n


def core():
    host = BASE.split("//")[-1].split("/")[0]
    return {
        "User-Agent": "Dart/3.11 (dart:io)",
        "Accept-Encoding": "gzip",
        "Authorization": "Bearer " + JWT,
        "x-user-id": UID,
        "Host": host,
    }


def http_get(url, hdrs, timeout=20):
    try:
        with urlopen(Request(url, headers=hdrs), timeout=timeout, context=_ctx) as r:
            raw = r.read()
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            return r.status, raw.decode("utf-8", "ignore")
    except HTTPError as e:
        raw = b""
        try:
            raw = e.read()
        except Exception:
            pass
        return e.code, raw.decode("utf-8", "ignore")
    except Exception as e:
        return -1, f"{type(e).__name__}: {e}"


# ==================== 会话信息 ====================

def get_session():
    url = f"{BASE}/v2/as/conversations/{CONV_ID}/session"
    c, b = http_get(url, core())
    if c == 401:
        log("session 401, 先续期再重试")
        if refresh():
            c, b = http_get(url, core())
    if c != 200:
        log("!! session 失败", c, b[:120])
        return None
    try:
        d = json.loads(b)["data"]
        link = d.get("link", "")
        token = d.get("token", "")
        sandbox = d.get("sandboxId", "")
        status = d.get("sessionStatus")
    except Exception as e:
        log("!! session 解析失败", e)
        return None
    if not link:
        log("!! link 为空")
        return None
    host = link.split("//")[-1].split("/")[0]
    parts = host.split("-", 1)
    port = parts[0]
    cluster = parts[1].split(".", 1)[1] if len(parts) > 1 and "." in parts[1] else host
    return {"token": token, "sandbox": sandbox, "port": port,
            "host": host, "proxy": f"miniprogram.{cluster}", "status": status}


# ==================== ACP 通道 ====================

def bheaders():
    tid = uuid.uuid4().hex[:32]
    sid = uuid.uuid4().hex[:16]
    return {
        "x-b3-traceid": tid, "x-b3-spanid": sid, "x-b3-sampled": "1",
        "traceparent": f"00-{tid}-{sid}-01", "x-trace-id": tid,
    }


def bootstrap_body():
    return {
        "initialize": {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {"readTextFile": False, "writeTextFile": False},
                    "elicitation": {"form": {}, "url": {}},
                    "extensions": ["_codebuddy.ai/question"],
                    "_meta": {"codebuddy.ai": {"cwd": "/workspace", "question": True}},
                },
            },
        },
        "sessionLoad": {
            "jsonrpc": "2.0", "id": 2, "method": "session/load",
            "params": {
                "sessionId": CONV_ID, "cwd": "/workspace",
                "mcpServers": [{"name": "workbuddy-device", "type": "acp"}],
                "_meta": {"codebuddy.ai": {"round": 3}},
            },
        },
        "setConfigOption": {
            "jsonrpc": "2.0", "id": 3, "method": "session/set_config_option",
            "params": {"configId": "language", "value": "简体中文"},
        },
    }


def open_bootstrap(sp):
    host = sp["proxy"]
    h = {
        "User-Agent": "Dart/3.11 (dart:io)",
        "Accept-Encoding": "gzip",
        "Authorization": "Bearer " + sp["token"],
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "x-cs-sandbox-id": sp["sandbox"],
        "x-cs-sandbox-port": sp["port"],
        "Host": host,
    }
    h.update(bheaders())
    try:
        r = urlopen(Request(f"https://{host}/acp/bootstrap",
                            data=json.dumps(bootstrap_body()).encode(),
                            headers=h, method="POST"),
                    timeout=CONNECT_TIMEOUT, context=_ctx)
        cid = r.headers.get("acp-connection-id") or r.headers.get("Acp-Connection-Id")
        enable_tcp_keepalive(sock_of(r))
        log(f">>> bootstrap 成功 connId={cid}")
        return r, cid
    except Exception as e:
        log("!! bootstrap 失败", classify_exc(e), e)
        return None, None


def backoff(attempt):
    d = min(RECONNECT_BASE * (2 ** (attempt - 1)), RECONNECT_MAX)
    if RECONNECT_JITTER:
        d *= 0.75 + random.random() * 0.5
    return max(int(d), 100)


# ==================== 业务站点探测(可选) ====================

_site_stat = {"ok": 0, "fail": 0}


def site_probe():
    """返回 (是否存活, 状态描述)。不用 subprocess, 纯 socket 探活。"""
    try:
        u = SITE.split("//", 1)
        scheme = u[0] if len(u) > 1 else "http"
        rest = u[1] if len(u) > 1 else u[0]
        hostport = rest.split("/", 1)[0]
        host = hostport.split(":")[0]
        port = int(hostport.split(":")[1]) if ":" in hostport else (443 if scheme == "https" else 80)
        s = socket.create_connection((host, port), timeout=8)
        s.close()
        _site_stat["ok"] += 1
        return True, "TCP连通"
    except Exception as e:
        _site_stat["fail"] += 1
        return False, type(e).__name__


# ==================== 第二通道: 会话活跃脉冲 ====================

_pulse_stat = {"ok": 0, "fail": 0}


def pulse_once(sp):
    h = core()
    h["Accept-Encoding"] = "gzip"
    c, b = http_get(f"{BASE}/v2/as/conversations/{CONV_ID}/session", h, timeout=15)
    if c == 200:
        _pulse_stat["ok"] += 1
        return True
    _pulse_stat["fail"] += 1
    return False


def pulse_worker():
    log(f"脉冲通道已启动(每 {PULSE_INTERVAL}s)")
    last_report = time.time()
    while _running:
        for _ in range(PULSE_INTERVAL):
            if not _running:
                return
            time.sleep(1)
        if not _running:
            return
        sp = get_session()
        if not sp:
            continue
        pulse_once(sp)
        if time.time() - last_report >= 300:
            log(f"脉冲通道: 成功 {_pulse_stat['ok']} / 失败 {_pulse_stat['fail']}")
            last_report = time.time()


# ==================== 主通道: SSE 流 ====================

def stream_loop(sp):
    """
    维持 SSE 长连接。返回 True 表示应当继续重连, False 表示应退出。
    高频轮转 + 心跳判定 + TCP keepalive + 可选站点探测, 共同压缩断线窗口。
    """
    host = sp["proxy"]
    h = {
        "User-Agent": "Dart/3.11 (dart:io)",
        "Accept": "text/event-stream",
        "Cache-Control": "no-cache",
        "Authorization": "Bearer " + sp["token"],
        "x-cs-sandbox-id": sp["sandbox"],
        "x-cs-sandbox-port": sp["port"],
        "Host": host,
        "Acp-Connection-Id": "",
    }
    h.update(bheaders())

    started = time.time()
    last_event_id = ""
    last_data = time.time()
    last_site = time.time()
    site_fails = 0

    try:
        req = Request(f"https://{host}/acp", headers=h, method="GET")
        resp = urlopen(req, timeout=CONNECT_TIMEOUT, context=_ctx)
        enable_tcp_keepalive(sock_of(resp))
        log(f">>> SSE 已连接 {host}  (心跳阈值 {HEARTBEAT_TIMEOUT}s)")
    except Exception as e:
        log(f"!! SSE 建连失败 [{classify_exc(e)}]")
        return True

    try:
        while _running:
            # 单次 read 超时短, 便于高频做健康判定
            try:
                sock = resp.fp.raw._sock if hasattr(resp, "fp") else None
                if sock is not None:
                    sock.settimeout(READ_TIMEOUT)
            except Exception:
                pass

            try:
                chunk = resp.read(65536)
                if not chunk:
                    log("!! SSE 流正常结束(EOF), 准备重连")
                    return True
                last_data = time.time()
                # 解析 SSE 的 id: 行, 便于断点续传
                try:
                    txt = chunk.decode("utf-8", "ignore")
                    if "id:" in txt:
                        for line in txt.splitlines():
                            if line.startswith("id:"):
                                last_event_id = line[3:].strip()
                except Exception:
                    pass
            except Exception as e:
                label = classify_exc(e)
                if label == "读取超时":
                    pass                                    # 正常, 走下面的健康判定
                else:
                    log(f"!! 读流中断 [{label}], 准备重连")
                    return True

            # ---- 健康判定: 1) 心跳 ----
            idle = time.time() - last_data
            if idle > HEARTBEAT_TIMEOUT:
                log(f"!! 心跳超时({int(idle)}s 无数据), 主动重连")
                return True

            # ---- 健康判定: 2) 主动轮换 ----
            if IDLE_RECYCLE > 0 and time.time() - started > IDLE_RECYCLE:
                log(f"!! 连接存活 {IDLE_RECYCLE}s, 主动轮换")
                return True

            # ---- 健康判定: 3) 业务站点 ----
            if SITE_ENABLE and time.time() - last_site > SITE_CHECK_INT:
                ok, st = site_probe()
                if ok:
                    if site_fails:
                        log(f"站点恢复: {st}")
                    site_fails = 0
                else:
                    site_fails += 1
                    log(f"!! 站点异常 ({st}) 连续 {site_fails} 次")
                    if site_fails >= SITE_FAIL_LIMIT:
                        log("!! 站点连续不通, 触发重连")
                        return True
                last_site = time.time()
    except Exception as e:
        log(f"!! 主循环异常 [{classify_exc(e)}], 准备重连")
        return True
    finally:
        try:
            resp.close()
        except Exception:
            pass


# ==================== 入口 ====================

def main():
    global JWT, RT, CONV_ID

    _init_log_fp()
    load_state()

    if not RT and not JWT:
        log("!! 缺少凭据: 请设置 WB_RT 环境变量(或在配置区填写 RT)")
        sys.exit(2)
    if not CONV_ID:
        log("!! 缺少 CONV_ID: 请在配置区填写")
        sys.exit(2)

    log("=== WorkBuddy 保活 + 续期 (主动模式) ===")
    log("平台      :", BASE)
    log("会话 ID   :", CONV_ID)
    log("用户 ID   :", UID)
    e_j, e_r = jwt_exp(JWT), jwt_exp(RT)
    log("JWT 过期  :", datetime.fromtimestamp(e_j) if e_j else "无 JWT")
    log("RT  过期  :", datetime.fromtimestamp(e_r) if e_r else "无 RT")
    log("心跳阈值  :", HEARTBEAT_TIMEOUT, "s")
    log("重连退避  :", RECONNECT_BASE, "->", RECONNECT_MAX, "ms + 抖动")
    log("连接轮换  :", f"{IDLE_RECYCLE}s" if IDLE_RECYCLE > 0 else "关闭")
    log("TCP keepalive:", f"开 (idle={TCP_KEEPIDLE}s intvl={TCP_KEEPINTVL}s cnt={TCP_KEEPCNT})"
        if TCP_KEEPALIVE else "关")
    log("脉冲通道  :", f"开 (每 {PULSE_INTERVAL}s)" if PULSE_ENABLE else "关")
    log("站点探测  :", f"{SITE} (每 {SITE_CHECK_INT}s)" if SITE_ENABLE else "关闭")
    log("续期阈值  :", RENEW_THRESHOLD // 86400, "天")
    log("日志文件  :", LOG_FILE if LOG_TO_FILE else "(仅控制台)")

    if PULSE_ENABLE:
        threading.Thread(target=pulse_worker, daemon=True, name="pulse").start()

    attempt = 0
    while _running:
        attempt += 1
        log(f"--- 第 {attempt} 次尝试 ---")

        if not ensure_valid():
            d = backoff(attempt)
            log(f"续期失败, {int(d / 1000)}s 后重试")
            time.sleep(d / 1000)
            continue

        sp = get_session()
        if not sp:
            d = backoff(attempt)
            log(f"获取会话失败, {int(d / 1000)}s 后重试")
            time.sleep(d / 1000)
            continue

        log(f"会话获取成功 proxy={sp['proxy']} status={sp['status']}")

        # 先 bootstrap 建立通道, 再挂 SSE 长连接
        br, cid = open_bootstrap(sp)
        if br:
            try:
                br.read()
                br.close()
            except Exception:
                pass

        keep_going = stream_loop(sp)
        if not keep_going:
            break

        d = backoff(attempt)
        log(f"重连中, {d}ms 后重试")
        time.sleep(d / 1000)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("已退出")
        sys.exit(0)
    except Exception as e:
        log(f"!! 致命错误: {type(e).__name__}: {e}")
        sys.exit(1)
