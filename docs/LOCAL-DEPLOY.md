# 本地部署 — Mac 上运行，手机监控

---

## 1. 手机访问本地 Mac 的方案

核心问题：你的 Mac 在局域网内，手机怎么访问？

### 方案对比

| 方案 | 原理                                     | 优点 | 缺点 |
|------|----------------------------------------|------|------|
| **同一 WiFi 局域网** | Mac 开 Web 服务，手机直接访问 `192.168.x.x:8403` | 零配置、零成本 | 只能在家用 |
| **Tailscale** | 虚拟局域网，任何网络下设备互通                        | 免费、安全、无需公网 IP | 需要装客户端 |
| **Cloudflare Tunnel** | 免费内网穿透，给你一个公网域名                        | 免费、HTTPS、不开端口 | 依赖 Cloudflare |
| **ngrok** | 临时隧道                                   | 一行命令搞定 | 免费版地址每次变 |
| **frp** | 自建内网穿透                                 | 完全自控 | 需要一台有公网 IP 的服务器 |

### 推荐组合：Tailscale（推荐） + 局域网（备选）

```
┌─────────────────────────────────┐
│         你的 Mac                 │
│                                 │
│  my-workflow server             │
│  ├── REST API    :8403          │
│  ├── WebSocket   :8403/ws       │
│  └── Dashboard   :8403          │
│                                 │
│  Tailscale IP: 100.x.x.x       │
│  局域网 IP:    192.168.x.x      │
└──────────┬──────────────────────┘
           │
           │  Tailscale 虚拟网络（加密）
           │
┌──────────┴──────────────────────┐
│         你的手机                 │
│                                 │
│  浏览器 → 100.x.x.x:8403       │  ← 任何网络下都能访问
│  或 Safari → 192.168.x.x:8403  │  ← 同一 WiFi 下
│                                 │
└─────────────────────────────────┘
```

**Tailscale 的好处：**
- 免费（个人用户 100 台设备）
- Mac 和手机都装一个客户端就完了
- 在公司、咖啡厅、4G 网络下都能访问你家里的 Mac
- 加密传输，不暴露任何端口到公网
- 以后迁移到云服务器，只需要在服务器上装 Tailscale，手机地址改一下就行

### 快速开始

```bash
# 1. Mac 安装 Tailscale
brew install tailscale
# 或从 Mac App Store 安装

# 2. 登录
tailscale up

# 3. 查看你的 Tailscale IP
tailscale ip -4
# 输出: 100.64.x.x

# 4. 手机安装 Tailscale App，同一账号登录

# 5. 启动 my-workflow
mw server start
# → Dashboard: http://100.64.x.x:8403

# 手机浏览器打开这个地址即可
```

### Mac 不休眠配置

如果你想离开电脑后 agent 继续跑：

```bash
# 方法 1: 系统设置 → 电池 → 防止自动休眠（接电源时）

# 方法 2: 命令行临时阻止休眠
caffeinate -d -i -s &

# 方法 3: 用 launchd 注册为系统服务（推荐）
# 即使合盖，接着电源也不休眠
# 见下方 "注册为系统服务" 部分
```

### 注册为系统服务（开机自启 + 崩溃自重启）

```xml
<!-- ~/Library/LaunchAgents/com.zliu.my-workflow.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.zliu.my-workflow</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/mw</string>
        <string>server</string>
        <string>start</string>
        <string>--foreground</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/my-workflow.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/my-workflow.err</string>
</dict>
</plist>
```

```bash
# 注册服务
launchctl load ~/Library/LaunchAgents/com.zliu.my-workflow.plist

# 查看状态
launchctl list | grep my-workflow
```

---

## 2. 未来迁移到云端

本地跑通后，迁移非常简单：

```
本地开发阶段:
  手机 → Tailscale → Mac:8403

迁移到云端:
  手机 → Tailscale → VPS:8403   (只是 IP 变了)
  或
  手机 → https://workflow.yourdomain.com  (Cloudflare Tunnel)
```

不需要改任何代码，只是服务跑在不同的机器上。
