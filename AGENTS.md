# pi-mcps

## Layout

- `apps/desktop` — Electron + React 桌面端。主进程 (`src/main`) 以 RPC 子进程方式启动 pi，渲染层 (`src/renderer`) 只通过 preload 暴露的 `window.pi` 通信。
- `packages/` — 给 pi 使用的 MCP 服务器。目前有 `mcp-ask-user`（桌面提问工具，零依赖 stdio MCP）。
- `scripts/electron-vite.mjs` — electron-vite 启动器。

## Commands

```bash
npm install          # 根目录，workspaces 安装
npm run dev          # electron-vite dev（HMR）
npm start            # 构建后预览生产包
npm run build        # 构建 main / preload / renderer 到 apps/desktop/out
npm run typecheck    # node + web 两个 tsconfig 分别检查
```

## Notes

- 从 Electron 宿主（如 Devin Desktop）派生的终端会带有 `ELECTRON_RUN_AS_NODE=1`。`scripts/electron-vite.mjs` 在启动前删除该变量，否则 Electron 会以纯 Node 模式运行并报 `electron.app is undefined`。不要改回直接调用 `electron-vite`。
- pi 的 CLI 从 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` 解析（该包没有 `main`/`exports`，不能用 `require.resolve`）。可用 `PI_CLI_PATH` 覆盖。
- 主进程用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动 pi RPC。
- RPC 协议：stdin/stdout 各一行一个 JSON 对象，只按 `\n` 切分（不要用 readline）。事件 `message_update` 只含增量，最终以 `message_end` 为准。
- pi 配置：用户级 `~/.pi/agent/mcp.json`，项目级 `.pi/mcp.json`（需项目信任）。桌面端默认工作目录存于 Electron `userData/config.json`。
- 未登录时 `get_state` 返回 `model.id = "unknown"`，主进程将其归一为 `undefined`，界面显示登录提示。

## Provider settings

- `src/main/providers.ts` 用 pi SDK 的 `ModelRuntime` 读取服务商、凭据状态并执行登录。SDK 是 ESM-only 且没有 CJS `main`，必须用 `await import('@earendil-works/pi-coding-agent')`，不要用 `require`。
- 登录：`runtime.login(providerId, 'oauth' | 'api_key', interaction)`。`interaction.prompt` / `notify` 通过 `providers:login-message` 发给渲染层，答案从 `providers:answer-login` 回来；OAuth 的授权 URL / device code 会自动用系统浏览器打开。
- 凭据写入 `~/.pi/agent/auth.json`；`models.json` 保存后必须 `resetRuntime()` 再重建，否则模型目录是旧的。`settings.json` 只合并 `defaultProvider` / `defaultModel` / `defaultThinkingLevel`。
- 凭据、models.json、settings 变更后主进程重启 pi，并用 `--session <当前会话文件>` 保留对话；如果正在流式输出则跳过重启，下次启动生效。
- 模型切换：输入条模型 chip 打开列表，数据来自 RPC `get_available_models`（只含已配置凭据的服务商），选择后调用 `set_model` 并广播新状态；不要再用 `cycle_model` 盲切。
- 同一会话内跨服务商切换是 pi 原生能力：`set_model` 只要求新服务商有凭据，会向会话追加 `model_change` 记录，历史保持不变，下一条 assistant 消息记录新的 `provider/model`。恢复会话时 pi 用会话里最后一个 `model_change` / assistant 消息恢复模型（`sdk.js` 的 `getBranchSelection` + `hasConfiguredAuth`）；凭据缺失才回退默认模型并给出 “Could not restore model …”。切换的代价是 prompt cache 归零、换到窗口更小的模型会触发自动压缩；没有 provider 签名的 thinking 块在发给 Anthropic 时会被降级成普通文本（`pi-ai/dist/api/anthropic-messages.js`）。

## Theme & sidebar

- 主题：`document.documentElement.dataset.theme` 为 `dark` / `light`，持久化在 localStorage `pi-desktop-theme`。样式全部走 `styles.css` 顶部的 CSS 变量；新增样式不要写死颜色，否则亮色主题会破。切换主题时同时调用 `app:set-theme` 同步 Electron 标题栏 overlay 颜色。
- 侧栏：按 `session.cwd` 分项目，默认每个项目显示 10 条，超出显示“显示其余 N 个”；折叠/展开状态在 `Sidebar` 内部。项目标题右侧 `+` 通过 `pi:new-project-session` 切换 cwd 并开新会话。
- `PiRpcClient` 的 `exit` / `error` 回调必须确认 `this.child === child` 再处理，否则重启时旧进程的退出事件会把新进程引用置空并误报“pi 进程已退出”。

## Session view, thinking, model allowlist

- 会话导航：`SessionNavigator.tsx` 在聊天区右侧渲染标题大纲（`buildOutline` 提取 assistant Markdown 标题，无标题时用首行兜底）和用户提问时间线。消息元素带 `data-message-id`，App 用 `jumpToMessage` 滚动定位；滚动时按消息相对位置更新 `activeUserIndex`，到底部时强制标记最后一条提问。

- 侧栏视图偏好存在 localStorage `pi-sidebar-prefs`（environment/group/sort/showEmptyGroups），归档会话存在 `pi-archived-sessions`。搜索和状态筛选是**项目级**的（项目头部的 `+ / 搜索 / 筛选`，状态存在组件内 `projectStatus`，搜索存在 `projectQueries`）；顶部的漏斗是全局“视图选项”（环境/分组/排序/显示空分组）。分组支持文件夹 / 日期 / 不分组，排序支持最近活动 / 创建时间 / 名称；归档通过会话悬停按钮切换。`showEmptyGroups` 会在文件夹分组下保留当前工作目录以及所有出现过会话的项目（即使筛选后为 0 条）。SSH 环境和 PR 状态 pi 没有数据来源，菜单里显示为禁用项。
- 思考等级必须用 RPC `get_available_thinking_levels` 获取（随模型变化），选择后调用 `set_thinking_level`；不要用 `cycle_thinking_level` 盲切。
- 模型隐藏走 pi 的 `settings.json.enabledModels` 允许列表：`setProviderModels` 会把“除隐藏项外的全部模型 ID”写进去，全部启用时删除该字段（空 = 全部）。`pi:list-models` 和 `listModelChoices` 都按该列表过滤。未勾选的模型不会出现在模型选择器/默认模型下拉中。
- 自定义服务商界面在 `CustomProvidersPanel.tsx`：表单模式维护 `models.json` 的 providers，保留未知字段（headers/compat/cost 等）并支持表单/JSON 切换；新建模型默认补零 cost。内置服务商判断用 `ProviderInfo.builtin`（单独创建 `modelsPath: null` 的 ModelRuntime 取基线 ID），不要用当前 runtime 的 provider 列表，否则自定义服务商会被误标为“覆盖内置”。
- OpenAI ChatGPT 订阅登录必须在 `runtime.login` 的 options 里传 `getDeviceId`（稳定的 UUID，保存在 Electron userData 的 `device-id` 文件），否则报 “Sign in with ChatGPT requires a device ID (UUID) for this installation”。
- 两个 OpenAI 服务商是 pi 内置的：`openai`（ChatGPT 订阅 / API Key，标准模型）和 `openai-codex`（旧版 Codex 渠道，仅 ChatGPT Plus/Pro，模型较少）。设置页对两者有说明文案。

## Composer & images

- 图片走 pi 原生能力：RPC `prompt` / `steer` 的 `images` 字段，元素是 `{type:'image', data: base64, mimeType}`；pi 会把它们写进会话 JSONL 的 image content block，`get_messages` 也返回同样的块。
- 渲染层 `lib/images.ts` 负责 File → base64（`blobToDraftImage`，上限 8MB）、`clipboardImages`（读 `clipboardData.items`）、`renumberInlineMarkers`（删图后重排文本里的 `[图片N]` 标记）。
- 粘贴/拖入规则：光标在 **0** 时图片进入「前导区」，在输入框**上方**统一展示（`DraftImageStrip placement="leading"`，无文本标记）；光标在中间时在插入点写入 `[图片N]` 标记，图片在输入框下方以 chip 展示（`placement="inline"`）。编号按附件在数组中的顺序（1 开始），发送时 `images` 按同一顺序传给 pi，所以标记和图片能对上。
- 点任意缩略图打开 `ImageLightbox`（Esc / 点背景关闭）；会话里用户消息用 `MessageImages` 渲染，图片在气泡**上方**右对齐（`.message.user` 是 column + align-items flex-end）。
- 允许只发图片不发文字：`prompt` 的 `message` 传空串，pi 接受（实测模型能收到图）。

## Updates & packaging

- 更新实现：`apps/desktop/src/main/updates.ts` 使用 `electron-updater`。打包版走 electron-updater（GitHub Release 的 `latest.yml` + NSIS 安装包）；开发模式用 GitHub Release API 只做版本检测，`canInstall=false`。启动 5 秒后及每 6 小时自动检查，开关存在 userData 的 `updates.json`。
- 更新源默认 `touwaeriol/agent-desktop`，可用环境变量覆盖：`PI_DESKTOP_UPDATE_REPO=owner/repo`、`PI_DESKTOP_UPDATE_URL=<generic feed>`、`PI_DESKTOP_RELEASES_URL=<发布页>`。`electron-builder.yml` 的 `publish` 也要同步 owner/repo。
- 打包：根目录 `npm run dist`（`electron-builder.yml`，NSIS，输出 `release/`）。`asarUnpack` 包含 `@earendil-works/**`、`quickjs-wasi`、`@silvia-odwyer/**`；`findBundledCli` 在打包版优先从 `process.resourcesPath/app.asar.unpacked` 找 pi CLI。
- 系统代理：`proxy.ts` 用 `session.resolveProxy` 解析系统代理，设置 `HTTP(S)_PROXY`/`NO_PROXY`/`NODE_USE_ENV_PROXY`，并通过 `setGlobalDispatcher(new EnvHttpProxyAgent())` 让主进程 fetch 走代理；pi 子进程继承同一环境。设置页「网络代理」显示检测结果。
- 应用名：`app.setName('agent-desktop')`，userData 为 `%APPDATA%\agent-desktop`；启动时会从旧 `%APPDATA%\@pi-mcps\desktop` 迁移 `config.json`/`device-id`/`updates.json`。
- GitHub Actions 用 `--publish never` 打包，再用 `gh release create` 上传资产，避免 electron-builder 并发上传时创建重复 draft release。
- 在带有 `ELECTRON_RUN_AS_NODE=1` 的终端里测试打包版必须 `env -u ELECTRON_RUN_AS_NODE`，否则 exe 会按 Node 运行并立即退出。

## Sessions & workspace

- 会话默认与 pi 共用 `~/.pi/agent/sessions`；desktop `config.json` 的 `sessionMode` 为 `isolated` 时，启动 pi 会附加 `--session-dir <userData>/sessions`，`listSessions` 也读该目录。两种模式都由 pi 写 JSONL，结构不变，可随时切回共用。
- 工作目录是**会话级**的：点击其他项目的会话必须走 `pi:open-session`（以该会话 cwd + `--session <path>` 重启 pi），不能只用 `switch_session`，否则工具会在错误目录运行。设置页只读显示当前会话目录，不提供全局工作目录编辑。
- `config.json` 保存 `{ cwd, sessionMode, mcp }`；`cwd` 只是下次启动/新建会话的默认目录。目录不存在时 `startPi` 会回退到 home，避免 spawn ENOENT。

## MCP & desktop tools

- 桌面提问工具 `ask_user_question` 是一条自建链路，四段：
  1. `packages/mcp-ask-user/server.mjs` — 零依赖 stdio MCP 服务器（手写 JSON-RPC：`initialize` / `tools/list` / `tools/call`，按 `\n` 分帧，日志只走 stderr）。
  2. `apps/desktop/resources/extension/desktop-mcp.js` — pi 扩展，读 `AGENT_DESKTOP_MCP_URL/TOKEN/SCRIPT` 后 `pi.registerMcpServer('desktop', {...})`。**必须 `exposure: 'direct'`**（默认 `codemode` 不会把工具声明给模型）。**`timeout` 必须传 `Number.POSITIVE_INFINITY`**：pi 把 `config.timeout`（秒）乘 1000 传给 MCP client，`armTimeout` 在 `!Number.isFinite(timeoutMs)` 时不 arm 定时器，所以只有非有限值才真正不超时；填大数字会踩 `setTimeout` 的 2^31-1 ms 上限而立刻超时（默认值是 60 秒）。
  3. `apps/desktop/src/main/bridge.ts` — 只监听 `127.0.0.1` 的 HTTP 桥，`POST /ask`（`x-agent-desktop-token` 校验）→ 渲染层弹窗 → 回答后返回 JSON。**不要加等待超时**（`server.requestTimeout`/`server.timeout` 都设 0）；取消只来自 `cancelAllAsks`：pi 重启、关窗、退出、以及 `pi:abort`（同时给渲染层发 `ask:cleared` 关掉面板）。
  4. 渲染层 `AskQuestionPanel.tsx` — **内联面板，固定在输入框上方**（不要做全屏弹窗），高度控制在 ~130-160px：标题行、问题行（tag 内联）、**选项一行一个（不要并排）**、底栏同一行放输入框和按钮。单选 / 多选 / 手动输入；手动输入框常驻，直接打字即可，不用先选“其他”；单选时选项与手动输入互斥，多选时两者可叠加。顶部步骤条（仅多问题时显示）可点击跳回任意问题重新回答，`上一步` / `下一步` / `跳过` / `提交` 支持前后修改。`App.tsx` 用队列保存请求（`askQueue`），一次只显示一个，回答后从队列移除。
- 工具命名是 pi 生成的 `mcp__desktop__ask_user_question`。验证链路最快的方式：向桥 `POST /ask`（端口和令牌在 `%APPDATA%\agent-desktop\config.json` 的 `mcp.bridgePort/bridgeToken`），不需要真实模型调用。
- 注册方式选扩展 + `--extension`，**不要**写 `~/.pi/agent/mcp.json`：这样桌面端的工具不会污染终端里的 pi，桥接端口/令牌也不用每次启动改写用户配置。`mcpArgs()` 在总开关关闭时传 `--no-mcp`，桌面工具关闭时不传 `--extension`。
- 路径解析：打包版从 `process.resourcesPath/extension|mcp` 取（`electron-builder.yml` 的 `extraResources` 负责拷贝），开发版用 `searchUp` 从 `app.getAppPath()` 向上找 `resources/extension/desktop-mcp.js` 和 `packages/mcp-ask-user/server.mjs`。改了资源位置要同时改这两处。
- 设置 → MCP（`McpPanel.tsx`）管理 `~/.pi/agent/mcp.json`：总开关（`config.json.mcp.enabled`）、桌面工具开关（`mcp.desktopTool`）、服务器启用/删除/新增（新增接受一段 JSON，需含 `command` 或 `url`）。任何变更都会 `reloadPiConfig()` 重启 pi。
- 项目级 `.pi/mcp.json` 只读展示并合并到列表（同名覆盖用户级），仅在信任项目时由 pi 生效。

