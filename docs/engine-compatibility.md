# 引擎兼容层（开发态）

共享契约：`apps/desktop/src/shared/engine.ts`。界面菜单、设置和主进程校验使用同一份能力声明。生命周期、消息、工具活动和提问使用统一事件；每个适配器负责自己的协议与历史格式。

| 能力 | Prophey | pi | Claude Code | Codex |
| --- | --- | --- | --- | --- |
| 手动压缩 | 自研摘要替换 | RPC compact | SDK /compact | thread/compact/start |
| 自动压缩 | 桌面配置 | 桌面配置 | 原生管理 | 原生管理 |
| 恢复/分叉 | transcript | RPC | SDK 原生会话 | app-server 原生会话 |
| 模型目录 | provider 目录 | RPC | SDK 实时目录 | model/list |
| 思考等级 | 暂无独立控制 | RPC | SDK 支持等级 | 模型支持等级 |
| 图片 | provider 输入 | RPC images | image content | image input |
| 运行中引导 | 排队 | steer | 排队 | turn/steer |
| 命令发现 | 公共命令 | get_commands | supportedCommands | skills/list、review |
| 工具配置 | 桌面 MCP | 桌面 MCP | 本机工具禁用项 | 本机沙箱 |

公共命令按能力出现；/autocompact 只为可配置引擎提供桌面实现，Claude 自己报告同名命令时执行原生实现。/mcp 同样区分桌面与原生管理。不存在的命令不会偷偷发给模型。

## 验证

- 18 项无账号依赖的契约回归测试；主进程/渲染层类型检查；生产构建。
- pi：隔离配置中的真实启动、命令发现和新建会话。
- Claude：模型/命令目录、真实对话、原生会话读取、恢复、分叉和临时分支清理、原生 /usage 输出。
- Codex：模型/技能目录、真实对话、原生压缩、分叉与恢复；使用 Windows 系统代理。
- Windows 应用目录打包成功（使用本地 Electron、无签名）；从 app.asar 加载 SDK 并与本机 Claude CLI 握手成功。
- Electron 独立测试数据目录：真实 IPC、动态斜杠菜单、热切换、原生 MCP 命令、设置能力隔离及空会话不持久化。

## 外部验证限制

当前 Claude 上游对 source=compact 请求返回 HTTP 502：`upstream response could not be converted`。绕过适配器，直接使用官方 SDK 在空临时项目中也复现。适配层已调用原生命令并覆盖成功/历史不足/失败事件，但不能宣称此账号的真实压缩成功。CLI 按原生策略重试，用户可停止。

未逐一运行用户的所有自定义技能，因为它们可能修改文件、发布或发送消息；命令列表来自当前协议，不复制终端命令表。

## 协议参考

- Codex App Server：https://learn.chatgpt.com/docs/app-server
- Claude SDK 命令：https://code.claude.com/docs/en/agent-sdk/slash-commands
