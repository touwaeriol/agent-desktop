# 引擎固定与会话内模型切换

跨引擎上下文迁移已经移除。新会话开始前可以选择内建、pi、Claude Code 或 Codex；发送第一条请求后引擎固定，不能中止当前工作并搬运历史到另一个引擎。

现有旧版导入会话仍可读取和继续使用。旧会话镜像、Codex 展示前缀以及会话导航恢复记录保留兼容处理；不再提供新的历史导入接口或编码入口。

## 会话内切换模型

在当前回合结束后，可以选择已配置且已启用的模型。内建引擎切换 OpenAI / Anthropic 等模型时保持同一会话文件与原始 transcript，更新所选模型、可用思考等级和上下文窗口。运行中拒绝切换，避免模型选择与正在发送的请求错位。

这里没有另外一套“切换协议”。内建引擎与 pi 使用同一套 ModelRuntime.streamSimple 和 API 适配器：

- 原始 assistant 消息保存 api、provider、model，思考签名和工具调用记录原样持久化。
- 每次请求对 transcript 深拷贝，目标 API 的适配器把通用历史转成 Responses、Chat Completions 或 Messages 格式。
- 跨模型过滤其他模型的 thinking、加密推理和私有签名，按目标协议配对转换工具调用 ID 与结果 ID。
- 切回原模型仍能使用原始保存的签名；不把转换后的请求覆盖到会话历史中。
- 换到更小的上下文窗口时，下一轮按新窗口执行自动压缩策略。

## 验证

安装的 pi SDK 1.4.0 为当前实现依据。tests/model-switch.test.cjs 使用真实 SDK 与本地 HTTP 模拟端点验证 OpenAI Responses → Anthropic Messages → OpenAI Responses → Chat Completions → Anthropic Messages，并检查图片、工具结果配对、私有数据过滤、历史不变和模型恢复。

npm run test:handoff 保留原命令名，现验证已有会话锁定、新会话引擎选择、启动恢复与源数据保留。测试不调用付费模型，不等同于真实服务商账号的端到端验收。
