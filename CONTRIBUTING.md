# 贡献指南

感谢参与 Badminton Booking Assistant。

## 开发流程

1. Fork 仓库并从 `main` 创建功能分支。
2. 不要复制或提交真实账号、邮箱、手机号、路径、Cookie、Token、DPAPI 文件、日志或生成配置。
3. 修改配置行为时，同时覆盖四字段新配置和 46 字段旧配置测试。
4. 运行：

```powershell
node tests/node_syntax_check.mjs
node --test tests/*.test.mjs
powershell -NoProfile -File .\tools\test-project.ps1
```

5. 提交小而清晰的变更，并在 PR 中说明用户影响、兼容性和验证方式。

涉及新场馆适配时，请将机构特定逻辑隔离在兼容层，不要把机构名称放进项目品牌或公共默认任务名。
