# 架构说明

`badminton.ps1` 是唯一公开入口。`scripts/config_resolver.mjs` 将内部默认值、用户配置和命令覆盖合并并校验，PowerShell 通过 `tools/common.ps1` 读取同一结果。

```text
CLI / Dashboard
      │
      ▼
Canonical config resolver
      │
      ├─ Task installer ─ WebBridge prestart ─ VPN preconnect ─ preflight
      └─ Booking runner ─ court/campus/partial fallbacks ─ postcheck/mail
```

计划任务使用 `BadmintonBookingAssistant_*` 命名空间。`schedule -PlanOnly` 在注册任务之前返回完整 JSON 计划。预约决策位于 `scripts/booking_logic.mjs`，浏览器执行器只负责页面与会话编排。

网页面板是可选的本地回环服务，只展示脱敏状态并调用同一计划生成器；它不保存自动付款选项。
