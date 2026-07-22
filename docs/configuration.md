# 配置与高级选项

配置优先级为：内部默认值 → 用户配置 → 单次命令参数。入口文件是 `config/local.json`。

## 最小配置

```json
{
  "version": 1,
  "username": "YOUR_CAS_ACCOUNT",
  "primaryCampus": "lxd",
  "fallbackCampus": "xlh"
}
```

`lxd` 表示留仙洞，`xlh` 表示西丽湖。候补可设为另一校区、`auto` 或 `none`。

## 可选场地顺序

仅在修改默认顺序时添加：

```json
{
  "courtPriority": {
    "lxd": [5, 6, 7, 8, 1, 2, 3, 4, 9, 10],
    "xlh": [5, 6, 7, 8, 1, 2, 3, 4, 9, 10, 11, 12]
  }
}
```

系统会按顺序继续尝试；单个场地失败不会终止整条链路。

## 账号与密码

`username` 是目标预约系统的统一身份认证（CAS）账号，通常是学号或工号。登录密码不会保存在 JSON 中；首次运行 `setup` 时在隐藏输入框中填写，并由 Windows DPAPI 加密。需要更新密码时运行：

```powershell
.\badminton.ps1 config -UpdatePassword
```

不要在 `config/local.json`、命令行参数或提交记录中保存明文密码。

## VPN

程序扫描以下开始菜单位置中的 EasyConnect 快捷方式：

- 系统级开始菜单
- 当前用户开始菜单

只有自动发现失败时才需要保存 `vpn.shortcutPath`。运行下面的命令会打开文件选择窗口：

```powershell
.\badminton.ps1 config -SelectVpnShortcut
```

请选择开始菜单中的 `.lnk`，不要选择 `.exe`，也不要复制其他人的绝对路径。查找方法：Windows 开始菜单搜索 EasyConnect → 右键“打开文件所在的位置”。

## 邮件

邮件默认关闭。运行 `.\badminton.ps1 config -EnableMail` 可选择 163、QQ 或自定义 SMTP。配置文件只保存提供商、发件地址、收件地址、服务器和端口；授权码写入当前 Windows 用户可解密的 DPAPI 文件，不进入 JSON。

## 自动付款

自动付款默认关闭。唯一开启方式：

```powershell
.\badminton.ps1 config -EnableAutoPayment
```

必须输入 `ENABLE AUTO PAYMENT` 确认。网页面板不会修改该选项。旧版无版本号的生产配置保持原有付款语义；新版配置必须显式启用。

## advanced

高级用户可在 `advanced` 节点覆盖轮询窗口、间隔、超时、金额、最小时长、WebBridge 路径或任务时间。字段来源和默认值见 `config/defaults.json`。不要复制默认值到本地配置，除非确实需要覆盖。

## 旧配置

现有 46 字段扁平配置可继续作为 `-ConfigPath` 输入。解析器保留候补校区、场地顺序、部分时段兜底、邮件和旧版付款行为，并将公共版任务名隔离到 `BadmintonBookingAssistant_*`。
