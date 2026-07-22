# 故障排查

## 先运行 doctor

```powershell
.\badminton.ps1 doctor
```

它只执行诊断，不安装计划任务。

## Node 或 Chrome 未找到

确认 `node --version` 可用，并让 Chrome 保持在默认安装位置；如使用便携版，在高级配置中覆盖浏览器路径。

## WebBridge 不可用

确认 Kimi WebBridge 已安装、扩展 ID 正确且端口未被占用。可先手动启动 WebBridge，再重新运行 `doctor`。

## VPN 快捷方式未找到

确认 EasyConnect 的快捷方式存在于系统级或用户级开始菜单。如果仍无法发现，运行 `config` 选择实际的 `.lnk` 文件。不同电脑路径通常不同。

## DPAPI 密钥失败

密钥只能由创建它的 Windows 用户在同一用户上下文中解密。不要复制到另一账号或 CI。重新运行 `setup` 生成密钥。

## 任务没有运行

使用 `.\badminton.ps1 status` 检查下次运行时间和上次返回码。互动式浏览器链路通常要求同一 Windows 用户保持登录；注销会阻止使用交互令牌的任务。

## 首选场地失败

这是正常候补路径。程序会继续尝试场地优先级、候补校区和满足下限的部分时段。查看最近结果时重点关注最终失败原因，不要只看首个候选。
