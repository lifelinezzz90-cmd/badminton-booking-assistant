# 安装指南

## 前置条件

- Windows 10/11 与 PowerShell 5.1 或更高版本
- Node.js 20 或更高版本
- Google Chrome
- Kimi WebBridge（浏览器自动化链路）
- EasyConnect，以及能够访问目标场馆系统的有效账号

## 第一次怎么用

先克隆项目，在 PowerShell 中进入项目目录，然后运行：

```powershell
.\badminton.ps1 setup
```

第一次使用不要编辑 JSON。向导会依次说明并询问：

1. **统一身份认证（CAS）账号**：就是平时登录目标预约系统使用的账号，通常是学号或工号，不是 GitHub 账号。
2. **登录密码**：与上述账号对应的密码。输入时屏幕不会显示字符，这是正常的。
3. **首选和候补场馆**：根据提示选择代码；候补默认开启，一个场地失败后仍会继续尝试。
4. **EasyConnect 快捷方式**：程序先自动扫描系统级和用户级开始菜单。找不到时会自动打开文件选择窗口，只需选择 `.lnk` 快捷方式，不要选择 `.exe`。

密码只保存在当前 Windows 用户可解密的 DPAPI 文件中，不会写进 `config/local.json`，也不要手动把密码放进任何 JSON。

如果文件选择窗口中找不到 EasyConnect：打开 Windows 开始菜单，搜索 EasyConnect，右键选择“打开文件所在的位置”，然后在窗口中选择对应的 `.lnk` 文件。也可以稍后单独运行：

```powershell
.\badminton.ps1 config -SelectVpnShortcut
```

密码需要更换时运行：

```powershell
.\badminton.ps1 config -UpdatePassword
```

邮件通知默认关闭，不影响首次配置。需要邮件时再运行 `.\badminton.ps1 config -EnableMail`。

## 运行自检

```powershell
.\badminton.ps1 doctor
```

`doctor` 检查 Node、Chrome、WebBridge、VPN 快捷方式、DPAPI 密钥与场馆连通性。若 VPN 快捷方式失败，按提示运行 `config -SelectVpnShortcut` 即可重新选择。

## 计划预约

先预览：

```powershell
.\badminton.ps1 schedule -TargetDate 2026-07-29 -Start 19:30 -End 21:00 -PlanOnly
```

确认五项任务、主/候补场馆、时间与付款状态无误后，移除 `-PlanOnly`。安装过程只管理 `BadmintonBookingAssistant_*`。

## 查看与删除

```powershell
.\badminton.ps1 status
.\badminton.ps1 dashboard
.\badminton.ps1 uninstall
```

`uninstall` 不会删除配置、密钥或其他计划任务。
