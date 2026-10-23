# 跨引擎上下文迁移

## 用户行为

输入框旁的 agent 下拉框和设置中的引擎选择器共用切换入口。选择另一个引擎会在原项目中新建目标原生会话，复制当前对话后继续。源会话保留，可从侧栏重新打开。

- 保留用户正文、图片、AI 正文、工具名称/参数/结果及错误标记。
- 去除 thinking、reasoning、签名、原服务商状态及系统指令；目标引擎继续使用自己的工具、权限和系统规则。
- 运行中显示“停止并切换到”；先中止当前回合，等待空闲后取历史，不在执行中的工具之间抢走会话。
- 未返回结果的工具补明确的“状态未知”错误记录。缺少原调用的结果保留为带说明的历史文本，不伪造成功执行。
- 切换期间互斥会话/配置修改，并暂停排队发送；失败恢复源引擎。磁盘中的 `pendingEngineSwitch` 让下次启动恢复未提交迁移的源会话。
- 原历史不被覆盖，也不调用模型自动总结或截断。迁移内容仍占目标模型的上下文窗口，后续压缩由目标引擎处理。

## 适配实现

`agent/history.ts` 负责中立历史与编码；`AgentEngine.importHistory()` 是应用调用的统一入口。

| 引擎 | 原生导入/恢复 | 平台保存 |
| --- | --- | --- |
| pi | `SessionManager.create/appendMessage` 生成 v3 会话，再 `switch_session` | `userData/imports/pi` 中的原生 JSONL |
| Claude Code | 构造 user/assistant 与 tool_use/tool_result 的 parentUuid 链，经 SDK SessionStore 物化 JSONL 并 resume | `userData/imports/claude`，镜像后续增量，按 UUID 去重 |
| Codex | 新线程 `thread/inject_items`，由原生引擎持久化，后续 `thread/resume` | 原生 rollout，加 `userData/imports/codex` 的界面前缀 |
| Prophey | 新 transcript，严格落盘成功后切换内存历史 | `userData/transcripts` |

Codex 0.163.0 的 `thread/inject_items` 写入模型可见历史，但导入的条目不一定出现在 `thread/read` 的 turns 中。因此适配器在恢复和分叉时合并应用前缀用于显示与下次导出；不会把它重复注入模型。CC 的 SessionStore 是 SDK alpha 接口，原生条目编码集中在适配层。导入接口不可用时显式失败并恢复源会话，不偷偷退化成一大段 user 提示词。

## 验证

本机：pi 1.4.0、Claude Agent SDK 0.3.309、Claude Code 2.1.304、Codex CLI 0.163.0。

```sh
npm test
npm run typecheck
npm run build
npm run test:smoke
npm run test:handoff
npm run test:handoff -- --native
```

默认 handoff 测试只要求随应用安装的 pi；native 测试要求本机 CC/Codex CLI。测试均使用临时工作区和用户配置，不读写用户原会话。

native 测试实际启动 Electron 和三个 CLI，覆盖 pi/CC/Codex 六个方向切换、渲染后的历史、图片/工具配对、运行中停止切换、应用重启、未完成迁移标记恢复、缺失 CLI 回滚、源文件不变。CC/Codex 下一轮请求发送给本地模拟模型服务，并断言请求确实包含导入的结构化历史且不含思考标记；没有访问外部付费模型。它验证真实原生读写与请求构造，不声称已验证所有历史格式版本或真实模型对历史的理解。

参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。CC/ pi 的恢复接口同时依据当前安装包 SDK 类型与实现，并以原生运行结果验证。
