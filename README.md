<p align="center"><img src="assets/logo.svg" width="96" alt="Badminton Booking Assistant"></p>
<h1 align="center">Badminton Booking Assistant</h1>
<p align="center">面向 Windows 的定时羽毛球场预约助手：先预检、再计划、按时执行，并保留完整候补链路。</p>
<p align="center"><a href="https://github.com/lifelinezzz90-cmd/badminton-booking-assistant/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lifelinezzz90-cmd/badminton-booking-assistant/ci.yml?branch=main&label=CI"></a> <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-126b4d"></a> <img alt="Windows" src="https://img.shields.io/badge/platform-Windows-0078D4"></p>
<p align="center"><a href="README.en.md">English</a> · <a href="docs/installation.md">安装</a> · <a href="docs/configuration.md">配置</a> · <a href="docs/troubleshooting.md">排障</a> · <a href="SECURITY.md">安全</a></p>

![脱敏状态面板](assets/dashboard-preview.svg)

## 快速开始

先克隆仓库并进入目录：

```powershell
git clone https://github.com/lifelinezzz90-cmd/badminton-booking-assistant.git
cd badminton-booking-assistant
```

然后只需三条命令：

```powershell
.\badminton.ps1 setup
.\badminton.ps1 doctor
.\badminton.ps1 schedule -TargetDate 2026-07-29 -Start 19:30 -End 21:00 -PlanOnly
```

第一次运行不需要编辑 JSON。执行 `.\badminton.ps1 setup` 后，向导会把每一项说清楚：

| 向导项目 | 应该填写什么 |
| --- | --- |
| 统一身份认证（CAS）账号 | 你平时登录目标预约系统使用的账号，通常是学号或工号 |
| 登录密码 | 与上述账号对应的密码；输入时不显示字符，并使用 Windows DPAPI 加密保存 |
| 首选/候补场馆 | 直接选择提示中的代码；候补默认开启 |
| EasyConnect 快捷方式 | 通常自动检测；找不到时会弹出窗口让你选择 `.lnk`，不需要手抄路径 |

不要把密码写进 `config/local.json`。密码需要更换时运行 `.\badminton.ps1 config -UpdatePassword`；VPN 没选好时运行 `.\badminton.ps1 config -SelectVpnShortcut`。

确认预览无误后，去掉 `-PlanOnly` 再运行一次即可安装五段式计划任务。首次使用前请阅读[安装指南](docs/installation.md)。

## 核心能力

- 单一入口：`setup`、`doctor`、`schedule`、`status`、`config`、`dashboard`、`uninstall`。
- 稳健候补：主校区失败后尝试候补校区；按场地优先级继续尝试，不会因一个场地失败就停止。
- 部分时段兜底：完整时段不可用时，可按最小时长继续匹配。
- 五段式任务链：WebBridge 预启动、VPN 预连接、预检、正式预约、结果复查。
- 安全默认：邮件和自动付款均默认关闭；密码、SMTP 授权码使用当前 Windows 用户的 DPAPI 加密。
- 向后兼容：旧版 46 字段扁平配置可直接读取，无需迁移。

## 工作原理

`badminton.ps1` 将内部默认值、`config/local.json` 与单次命令参数合并成唯一的生效配置。PowerShell 安装器、Node 预约执行器和可选状态面板使用同一解析结果。`schedule -PlanOnly` 只生成计划，不创建任务、日志或生成配置。

默认配置只需四项：

```json
{
  "version": 1,
  "username": "YOUR_CAS_ACCOUNT",
  "primaryCampus": "lxd",
  "fallbackCampus": "xlh"
}
```

场地顺序、VPN 快捷方式、邮件和高级轮询项仅在需要覆盖默认行为时写入。详见[配置与高级选项](docs/configuration.md)。

## 兼容性

首版支持 Windows、PowerShell 5.1+、Node.js 20+、Chrome、Kimi WebBridge 与 EasyConnect，当前内置适配留仙洞和西丽湖两个场馆入口。其他场馆系统需要适配页面路由和预约逻辑。

本项目是非官方社区工具，与任何学校、场馆、VPN 或浏览器扩展提供方均无隶属或授权关系。请遵守目标系统规则并自行承担使用风险。

## 安全说明

- 不要提交 `config/local.json`、`secrets/`、`logs/`、`config/generated/` 或浏览器会话。
- 明文密码、SMTP 授权码、Cookie 和 Token 会被配置解析器拒绝。
- VPN 默认扫描系统级和用户级开始菜单快捷方式；只有自动发现失败时才保存自定义 `.lnk` 路径。
- 自动付款只能通过 `.\badminton.ps1 config -EnableAutoPayment` 并输入确认短语开启。
- `uninstall` 仅删除本项目创建的 `BadmintonBookingAssistant_*` 任务。

完整威胁模型与报告方式见[安全模型](docs/security.md)和[SECURITY.md](SECURITY.md)。

## 常见问题

**为什么 doctor 提示 WebBridge 或 VPN 不可用？** 先确认 Chrome、Kimi WebBridge 和 EasyConnect 已安装，再查看[故障排查](docs/troubleshooting.md)。

**没有抢到首选场地会停止吗？** 不会。默认继续尝试后续场地、候补校区和满足下限的部分时段。

**可以不安装任务先验证吗？** 可以。始终先运行 `schedule ... -PlanOnly`。

**网页面板能修改自动付款吗？** 不能。面板只展示状态；高风险选项必须从 CLI 显式开启。

## 文档

- [安装指南](docs/installation.md)
- [配置与高级选项](docs/configuration.md)
- [故障排查](docs/troubleshooting.md)
- [架构说明](docs/architecture.md)
- [安全模型](docs/security.md)
- [贡献指南](CONTRIBUTING.md) · [更新日志](CHANGELOG.md)

## License

[MIT](LICENSE)
