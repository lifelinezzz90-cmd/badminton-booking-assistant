# 安装指南

## 前置条件

- Windows 10/11 与 PowerShell 5.1 或更高版本
- Node.js 20 或更高版本
- Google Chrome
- Kimi WebBridge（浏览器自动化链路）
- EasyConnect，以及能够访问目标场馆系统的有效账号

## 首次配置

在 PowerShell 中进入项目目录：

```powershell
.\badminton.ps1 setup
.\badminton.ps1 doctor
```

`setup` 创建最小 `config/local.json`，并在需要时通过 DPAPI 保存密钥。`doctor` 检查 Node、Chrome、WebBridge、VPN、密钥与场馆连通性。

## 计划预约

先预览：

```powershell
.\badminton.ps1 schedule -TargetDate 2026-07-29 -Start 19:30 -End 21:00 -PlanOnly
```

确认五项任务、主/候补校区、时间与付款状态无误后，移除 `-PlanOnly`。安装过程只管理 `BadmintonBookingAssistant_*`。

## 查看与删除

```powershell
.\badminton.ps1 status
.\badminton.ps1 dashboard
.\badminton.ps1 uninstall
```

`uninstall` 不会删除配置、密钥或其他计划任务。
