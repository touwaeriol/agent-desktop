# Prophey（仓库原名 pi-mcps，本地目录不变）

## Layout

- `apps/desktop` — Electron + React 桌面端。主进程 (`src/main`) 以 RPC 子进程方式启动 pi，渲染层 (`src/renderer`) 只通过 preload 暴露的 `window.pi` 通信。
- `packages/` — 给 pi 使用的 MCP 服务器。目前有 `mcp-core`：桌面端核心交互 MCP（零依赖 stdio），当前提供 `ask_user_question`，新工具加到 `packages/mcp-core/tools/` 并在 `tools/index.mjs` 注册即可。
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
- 凭据、models.json、settings 变更后主进程重启 pi，并用 `--session <当前会话文件>` 保留对话；如果正在流式输出则跳过重启，下次启动生效（`configPending`，见「运行状态」）。
- **自定义接口地址**只对 `BASE_URL_PROVIDERS`（anthropic / openai / google / deepseek）开放，写进 `models.json` 的 `providers.<id>.baseUrl`——pi 文档保证「只给已有服务商设 baseUrl/headers 会保留其内置模型」，所以不需要重写模型列表。`setProviderBaseUrl` 会保留该 provider 的其他字段，清空时连空的 provider 对象一起删掉。改完必须重启 pi（`reloadPiConfig()`），web 引擎则通过 `providers.getRuntime()` 立刻看到新地址。
- **自定义服务商的每个模型必须填 `contextWindow`**（`CustomProvidersPanel` 保存时校验）。缺了它 pi 只能用默认 16K 余量做自动压缩，用量显示也会失准；官方内置服务商的窗口 pi 目录里已有，不需要用户填。
- 区域/订阅版本是 pi 的**独立 provider id**，不要合并：`moonshotai-cn`/`moonshotai`（Kimi 国内/海外）、`kimi-coding`（Kimi 订阅）、`minimax-cn`/`minimax`、`zai`/`zai-coding-cn`（Z.AI 海外/国内订阅）、`google`（AI Studio）/`google-vertex`。设置页用 `PROVIDER_NOTES` 给这些 id 加中文说明，而不是改名字或做映射。
- 模型切换：输入条模型 chip 打开列表，数据来自 RPC `get_available_models`（只含已配置凭据的服务商），选择后调用 `set_model` 并广播新状态；不要再用 `cycle_model` 盲切。
- 同一会话内跨服务商切换是 pi 原生能力：`set_model` 只要求新服务商有凭据，会向会话追加 `model_change` 记录，历史保持不变，下一条 assistant 消息记录新的 `provider/model`。恢复会话时 pi 用会话里最后一个 `model_change` / assistant 消息恢复模型（`sdk.js` 的 `getBranchSelection` + `hasConfiguredAuth`）；凭据缺失才回退默认模型并给出 “Could not restore model …”。切换的代价是 prompt cache 归零、换到窗口更小的模型会触发自动压缩；没有 provider 签名的 thinking 块在发给 Anthropic 时会被降级成普通文本（`pi-ai/dist/api/anthropic-messages.js`）。

## Theme & sidebar

- 主题：`document.documentElement.dataset.theme` 为 `dark` / `light`，持久化在 localStorage `pi-desktop-theme`。样式全部走 `styles.css` 顶部的 CSS 变量；新增样式不要写死颜色，否则亮色主题会破。切换主题时同时调用 `app:set-theme` 同步 Electron 标题栏 overlay 颜色。
- 侧栏顶部按参考产品（Claude 桌面端）排：`.sidebar-toolbar`（☰ 收起侧栏 / ▭ 视图选项 / ← → 会话前进后退）、`.sidebar-nav`（新建 / 自定义 / 更多，更多展开 `.nav-menu`）、`.pinned-block`（置顶会话，编号徽标）。
- 会话前进后退由 `App.tsx` 的 `historyRef`（stack + index，上限 50）驱动：`selectSession(session, { remember: false })` 用于历史跳转，避免再次入栈。
- 置顶存在 localStorage `pi-pinned-sessions`（路径数组），会话悬停时的第一个 `.session-archive` 按钮是置顶、第二个是归档。**置顶的会话只在 `.pinned-block` 里出现，必须从项目分组里过滤掉**（`groups` 用 `visible = sessions.filter(!pinned)`）——否则同一个会话在两处重复，用户会以为有两条。
- 侧栏：按 `session.cwd` 分项目，默认每个项目显示 10 条，超出显示“显示其余 N 个”；折叠/展开状态在 `Sidebar` 内部。项目标题右侧 `+` 通过 `pi:new-project-session` 切换 cwd 并开新会话。
- **一个会话 = 一个 git 仓库**（单仓库会话模式；多仓库 project 是后面一层）。`src/main/repo.ts` 用 `git -C <dir> rev-parse --show-toplevel` 把目录归一化到仓库根，`pi:new-project-session` / `pi:choose-workspace` 都会先归一化，所以 `session.cwd` 就是仓库根、侧栏分组天然按仓库走。仓库信息（分支 / remote / 未提交数）5 秒缓存，`PiStatus.repo` 给输入框的 workspace chip 用，`pi:repos` 给侧栏每组头部的 `⎇ main 8` 徽标用；**不要在渲染层直接跑 git**。
- 目录不是仓库时 `isRepo: false`，此时不显示分支徽标、行为退回“普通文件夹会话”，不要报错——用户可能就想在非仓库目录里跑。
- `PiRpcClient` 的 `exit` / `error` 回调必须确认 `this.child === child` 再处理，否则重启时旧进程的退出事件会把新进程引用置空并误报“pi 进程已退出”。

## Conversation layout

- assistant 消息不再有头像，正文直接铺开（文档式）；用户消息是右对齐气泡，图片在气泡上方（`.message.user` 为 column + align-items flex-end）。
- 工具调用按“活动行”聚合：`Activity` 把同一轮的工具按 read/write/bash/search/other 汇总成 `读取 2 个文件 · 运行 1 条命令 ›`，点开才显示具体 `.tool-card`；运行中/失败才显示圆点。**一轮 = 一条 assistant 消息**：不要为了“看起来少一点”去跨消息合并思考块或工具，模型真的一次发多个调用时，聚合行自然会变长。
- 每轮结束的统计行（`.run-status`）来自 `App.tsx` 的 `run` 状态：`agent_start` 记开始时间、`tool_execution_start/end` 加减运行中数量、`agent_settled` 记结束时间并通过 `pi:session-stats`（RPC `get_session_stats`）取 `tokens.total`。1 秒定时器只为刷新计时，不要用它做别的。

## Session view, thinking, model allowlist

- 会话导航：`SessionNavigator.tsx` 在聊天区右侧渲染标题大纲（`buildOutline` 提取 assistant Markdown 标题，无标题时用首行兜底）和用户提问时间线。消息元素带 `data-message-id`，App 用 `jumpToMessage` 滚动定位；滚动时按消息相对位置更新 `activeUserIndex`，到底部时强制标记最后一条提问。

- 侧栏视图偏好存在 localStorage `pi-sidebar-prefs`（environment/group/sort/showEmptyGroups），归档会话存在 `pi-archived-sessions`。搜索和状态筛选是**项目级**的（项目头部的 `+ / 搜索 / 筛选`，状态存在组件内 `projectStatus`，搜索存在 `projectQueries`）；顶部的漏斗是全局“视图选项”（环境/分组/排序/显示空分组）。分组支持文件夹 / 日期 / 不分组，排序支持最近活动 / 创建时间 / 名称；归档通过会话悬停按钮切换。`showEmptyGroups` 会在文件夹分组下保留当前工作目录以及所有出现过会话的项目（即使筛选后为 0 条）。SSH 环境和 PR 状态 pi 没有数据来源，菜单里显示为禁用项。
- 思考等级必须用 RPC `get_available_thinking_levels` 获取（随模型变化），选择后调用 `set_thinking_level`；不要用 `cycle_thinking_level` 盲切。
- 模型隐藏走 pi 的 `settings.json.enabledModels` 允许列表：`setProviderModels` 会把“除隐藏项外的全部模型 ID”写进去，全部启用时删除该字段（空 = 全部）。`pi:list-models` 和 `listModelChoices` 都按该列表过滤。未勾选的模型不会出现在模型选择器/默认模型下拉中。
- 允许列表必须**压缩**写入：某个服务商的所有模型都启用时写 `provider/*`（pi 用 minimatch 匹配 `provider/id`），只有部分启用才写具体 ID。历史上写成 1560 条精确 ID 会让 `isModelEnabled` 变成 O(模型×模式) 的 2 秒级卡顿（打开设置卡住的原因）。
- `isModelEnabled` 用 `getMatchers`：精确模式进 Set、通配模式预编译成 RegExp，按模式串缓存，禁止再在循环里 `new RegExp`。`listModelChoices` 结果也按「模式 + 已配置服务商」缓存，凭据/`models.json`/`settings.json` 变化时调用 `invalidateCache()`（登录、登出、保存设置、保存模型列表都会调用）。
- `listModelChoices` 默认只返回**已配置凭据**的服务商模型（1560 → 5），否则 contextBridge 跨隔离世界复制上千个对象会让设置页卡 2 秒。需要全部模型时传 `{ includeUnconfigured: true }`。
- 主进程启动时在后台 `listProviders()` / `listModelChoices()` 预热（`whenReady` 里），让第一次打开设置不用等 `ModelRuntime` 冷启动（约 500ms）。
- 自定义服务商界面在 `CustomProvidersPanel.tsx`：表单模式维护 `models.json` 的 providers，保留未知字段（headers/compat/cost 等）并支持表单/JSON 切换；新建模型默认补零 cost。内置服务商判断用 `ProviderInfo.builtin`（单独创建 `modelsPath: null` 的 ModelRuntime 取基线 ID），不要用当前 runtime 的 provider 列表，否则自定义服务商会被误标为“覆盖内置”。
- OpenAI ChatGPT 订阅登录必须在 `runtime.login` 的 options 里传 `getDeviceId`（稳定的 UUID，保存在 Electron userData 的 `device-id` 文件），否则报 “Sign in with ChatGPT requires a device ID (UUID) for this installation”。
- 两个 OpenAI 服务商是 pi 内置的：`openai`（ChatGPT 订阅 / API Key，标准模型）和 `openai-codex`（旧版 Codex 渠道，仅 ChatGPT Plus/Pro，模型较少）。设置页对两者有说明文案。

## Composer & images

- 图片走 pi 原生能力：RPC `prompt` / `steer` 的 `images` 字段，元素是 `{type:'image', data: base64, mimeType}`；pi 会把它们写进会话 JSONL 的 image content block，`get_messages` 也返回同样的块。
- 渲染层 `lib/images.ts` 负责 File → base64（`blobToDraftImage`，上限 8MB）和 `clipboardImages`（读 `clipboardData.items`）。**图片是纯附件**：不写文件名、不插入 `[图片N]` 标记，统一在输入框上方以 42×42 圆角方块展示（`object-fit: cover`，不同长宽比也对齐），悬停才出现删除按钮；发送时按数组顺序传给 pi。
- **粘贴入口在 `Composer.tsx` 的 window 级 `paste` 监听**（不是 textarea 的 `onPaste`）：焦点在 chip / 滚动区时 Cmd+V 也要能附图，而落到其他控件（设置、@ 搜索框、队列编辑）的粘贴要放过去不拦。命中图片时 `preventDefault()`，纯文本粘贴仍走浏览器默认。`addImages` 和 `removeImage` 都用 `imagesRef` 而不是 props 里的 `images`：连贴两张时两次解码并发、连删两个时两次点击同批，用 props 会让后一次覆盖前一次。输入框 `disabled`（pi 未就绪或 `/btw` 开着）时给提示而不是静默丢弃——剪贴板里那张图已经没了。
- 验证方式（不用手点）：PowerShell `[Windows.Forms.Clipboard]::SetImage()` 放一张图到系统剪贴板，再用 CDP `Input.dispatchKeyEvent`（`modifiers: 2` + `KeyV`）发真正的 Ctrl+V，然后数 `.draft-image` 的数量；合成 `ClipboardEvent` + `DataTransfer` 只能测到监听器，测不到系统剪贴板这一层。
- 点任意缩略图打开 `ImageLightbox`（Esc / 点背景关闭）；会话里用户消息用 `MessageImages` 渲染，图片在气泡**上方**右对齐（`.message.user` 是 column + align-items flex-end）。
- 允许只发图片不发文字：`prompt` 的 `message` 传空串，pi 接受（实测模型能收到图）。
- **上下文用量**：输入框右下角的小圆环 + `2% 20K / 1M`，数据来自 `get_session_stats().contextUsage`（`{tokens, contextWindow, percent}`）。`App.tsx` 在 `loadMessages`、`agent_settled`、`status.autoCompactPercent` 以及 **`status.model.id` / `contextWindow` 变化时**刷新（换模型是新的窗口、新的阈值，用量和配色必须跟着变）；`percent` 在刚压缩完时是 `null`，此时按 `tokens/ceiling` 兜底、拿不到就显示 0。**不要**显示 prompt cache 到期时间——pi 不提供，也不该猜。
- **分母是“可用上限”，不是窗口**：自动压缩开着时 `ceiling = round(window × autoCompactPercent / 100)`（1M 窗口 50% → 500K），界面显示 `211K / 500K`，提示里才写 `（窗口 1M，到 50% 自动压缩）`。显示 1M 等于给用户一个这轮永远到不了的上限（压缩先发生）。压缩关掉时分母回到窗口本身，提示写「自动压缩已关闭」。颜色：`>= 100%` 红、`>= 85%` 琥珀。
- **自动压缩**：默认目标是窗口的 90%（`AUTO_COMPACT_RATIO`）。pi 在 `contextTokens > contextWindow - reserveTokens` 时压缩，所以 `reserveTokens = window × (1 - ratio)`（1M 窗口 → 100K 余量）。写入 `~/.pi/agent/settings.json` 的 `compaction.{enabled,reserveTokens}`；**pi 只在启动时读这个值**，所以改完必须重启（`reloadPiConfig`，忙时会延后）。`syncAutoCompact()` 在启用、换模型、启动时各跑一次，值没变就不重启。
- 阈值只有一个真源：`config.json` 的 `autoCompact.ratio`（按比例存，换模型时按新窗口重算）。三个入口都写它并立刻 `broadcastStatus()`：设置 → 通用 → 「自动压缩」开关（`pi:set-auto-compact`）、设置 → 通用 → 「自动压缩阈值」下拉（`pi:set-auto-compact-ratio`，10–99%）、`/autocompact <tokens>`（换算成比例）。**设阈值必须把 `autoCompactEnabled` 置 true**：`statusSnapshot()` 只在它为真时给出 `autoCompactPercent`，漏了这一步界面会一直显示「已关闭 / 90%」，用户看到的阈值就不跟随设置变。
- 渲染层不要用 `status.autoCompactPercent ?? 90` 兜底成一个假阈值（历史上设置页这么写过，等于把真实值藏掉）；拿不到就说明没窗口信息或压缩已关，按这个含义显示。模型没有 `contextWindow` 时保留 pi 默认的 16K 余量并提示用户补 `contextWindow`。

## 斜杠命令

- 输入框打 `/` 弹出命令菜单（`Composer.tsx` 的 `SLASH_COMMANDS`），↑/↓ 选择、Enter/Tab 填入、Esc 清空。**填入后 `slashPicked` 记住当前值**，否则菜单会一直打开、Enter 永远只是重复填入，命令发不出去。
- 命令在渲染层拦截（`App.tsx` 的 `runCommand`），**不管是否在流式输出都会先走命令，认不出的 `/xxx` 才当普通消息**（`send()` 里先 `runCommand`，返回 true 才算消费、清空输入框）。命令本身永远不进入对话。
  - `/mcp`、`/btw` 是**本地命令，立刻执行**：`/mcp` 读一次 `getMcpState()` 弹浮层；`/btw` 立刻打开面板，主进程等本轮结束再 `clone`（面板里显示「正在回答…」）。两者都不排队，`send()` 里命令处理必须排在 `/btw` 面板守卫之前，否则面板打开时连 `/mcp` 都被拒。
  - 需要空闲会话的命令（`/clear`、`/compact`、`/autocompact <数字>`）**排队而不是拒绝**：忙碌时 `queueCommand()` 往消息队列里塞一条 `command: true` 的条目（输入框上方显示「命令」标签，没有「立即发送」按钮），回合结束后由同一个 flush effect 调 `runCommand(text, { queued: true })` 执行。`queued: true` 时若 pi 又忙起来就返回 false，flush 会把条目放回队列而不是丢掉。
  - `/clear`：开新会话（= 侧栏「新建」），不是清空当前 JSONL。
  - `/compact [提示词]`：RPC `compact` + `customInstructions`；会话太小时 pi 会返回 `Nothing to compact`，原样提示给用户。
  - `/autocompact <token 数 | on | off>`：写 `~/.pi/agent/settings.json` 的 `compaction.enabled` / `compaction.reserveTokens`（`reserveTokens = contextWindow - 阈值`，按当前模型的 `contextWindow` 换算），再按比例存进 `config.json` 的 `autoCompact.ratio` 并重启 pi；`on/off` 额外调 RPC `set_auto_compaction` 立即生效。同一个阈值也能在 设置 → 通用 → 「自动压缩阈值」里按百分比选。
  - `/mcp`：用 `getMcpState()` 弹浮层列出所有服务器（名称/传输/内置/启用状态）与全部工具名。
  - `/btw <问题>`：在当前分支节点开一个**新的侧边对话**（`BtwChat` 面板，全屏浮层）。主进程 `pi:btw-start` 用 RPC `clone`（不是 `fork`——`fork` 需要具体 entry id，传 leaf 会报 `Invalid entry ID for forking`）拿到分支文件，然后在这个分支上 `prompt` + `waitForSettle` + `get_last_assistant_text`；**分支保留到面板关闭**，面板里的追问走 `pi:btw-ask`（同一个分支，可多轮），关闭走 `pi:btw-close`：切回原会话、删掉分支文件。整个过程 `btwActive` 为真：`pi:event` 不发给窗口（否则渲染层会把分支会话加载进主记录），`sessionArgs()` 也强制返回原会话，重启不会落到分支上；任何切换/重开会话的 IPC 与 `reloadPiConfig()` 都先 `closeSideChat()`。左侧栏、输入框在面板打开时不可用（输入框 `disabled`），避免消息发进分支。
  - `/btw` 不排队：正在跑时先 `waitForIdle()` 等本轮结束再 `clone`（面板立刻打开显示「正在回答…」）；再次 `/btw` 会先 `closeSideChat()` 丢掉旧分支，从**当前**节点重新分支。`btwGeneration` 在每次 start/close 自增，用于取消还在等待的 start——否则面板关掉后它仍会把进程停在分支上。
  - 面板打开期间 `setStatus` 不广播，但 `status.isStreaming` 仍会随分支运行更新（`pi:btw-ask` 用它判断上一轮是否结束）。

## 设置界面

- 设置弹窗可拖右下角缩放（CSS `resize: both`，最小 720×460），尺寸存 `localStorage["pi-settings-size"]`，由 `ResizeObserver` 在 400ms 防抖后写入；`SettingsModal` 常驻挂载，所以关闭再打开尺寸不会丢。
- 服务商列表左侧的 `.provider-mark` 用**品牌图标**（`ProviderMark.tsx`）：路径来自 `@lobehub/icons-static-svg`（MIT）并**内联进源码**，不要再装那个包。图标是单色、用 `currentColor` 上色，颜色取 `--provider-color`；品牌色在黑/白主题之一会消失时（OpenAI、Kimi、Anthropic 这类近黑，Hugging Face 这类近黄）退回 `currentColor`。图标集里没有的品牌（Radius、小米）显示首字母，不要自己重画 logo。
- MCP 页的行要压扁：描述一律单行省略（`.mcp-row-sub` 的 `nowrap`），行内边距 6px 10px，内置引擎卡片 7px 10px，工具列表默认折叠。不要再让一段说明换两三行——一个服务器占半屏时下面的服务器列表会被挤出视野。

## 消息队列

- 运行中（`status.isStreaming` 或 `status.compacting`）发消息**默认进队列**，不再直接 `steer`：队列在渲染层（`App.tsx` 的 `queued`），输入框上方显示「N 条排队消息」，每条可编辑（放回输入框）、删除、立即发送。
- 「立即发送」和 `Ctrl+Enter` 是**强制引导**：走 `prompt(text, 'steer')` 注入当前回合，不等待本轮结束。
- 回合结束后自动按顺序发送队列里的下一条。**flush 的 effect 只能依赖 `status.isStreaming` / `status.compacting` / `status.phase`，不能依赖 `queued`**——否则加入第二条时会和第一条抢跑（`isStreaming` 还没变 true 就再发一次），实测第二条会被 pi 拒绝并丢失。
- 发送失败时把该条放回队首并提示，避免静默丢消息。放回后必须**自己再排一次**（`restore()` 重新读 `pi:get-status` 并 2 秒后 `setQueueTick`）：条目出队又回队不产生任何状态变化，flush 不会重跑，否则排队项会永远躺在那里。

## bash 工具（Windows）

- pi 的 bash 工具用 `where bash.exe` 找 shell：先 `%ProgramFiles%\Git\bin\bash.exe`，再 PATH 里的第一个。**Git 装在别处（按用户安装、`D:\app\Git`）时，PATH 里的第一个是 `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`——那是 WSL 的 App Execution Alias，没装发行版时它永远不返回**。表现是每条 bash 都 `Command timed out after N seconds`，连 `echo hi` 也一样，从记录里完全看不出 shell 根本没启动。
- 所以 `shell.ts` 的 `withRealBash()` 会在**每个 pi 子进程**（主进程 `runStart`、子代理 `SubagentManager.start`）的环境里把真实 Git Bash 的目录放到 PATH 最前面（`%LOCALAPPDATA%\Programs\Git\bin`、`%ProgramFiles%\Git\bin`、以及从 PATH 里的 `git.exe` 反推的 `…\Git\bin`），WindowsApps 里的 stub 一律跳过。
- 注意 `withRealBash(env)` 的 `env` 只是**要追加的变量**（`launch.env` 通常没有 PATH），PATH 必须从 `process.env` 取；写成从 `env` 取会把整条 PATH 换成单个目录，`where.exe` 自己就找不到了（表现成 `No bash shell found`）。合并后只保留一种大小写（`PATH` / `Path` 同时出现时 Windows 取哪个是不确定的）。
- 用户在 `settings.json` 里写 `shellPath` 时仍然优先（pi 先看它），不要覆盖。

## 引擎边界（`src/main/agent/`）

- 目标形态是「我们自己的 agent，pi 只是可替换的引擎」。`agent/engine.ts` 是契约（`state/busy/compacting/running/start/stop/request/refresh/waitForSettle/waitForIdle`），`agent/pi-engine.ts` 是 pi 的实现。
- **引擎只负责跑一轮和运行状态机**：子进程、`agent_start → agent_settled` 的 busy、压缩、settle waiter、`get_state` 权威校正、崩溃退出通知。**应用策略全部留在 `index.ts`**：MCP 服务器、`/btw` 分支、压缩阈值、速度档位、config、profile、子代理。
- 引擎要的启动参数（MCP 参数、扩展、profile、速度档位、项目根）由 `prepare(workspace)` 回调提供，所以引擎不认识 MCP/profile 这些概念；`sessionArgs()` / `sessionDirArgs()` 同理。
- **`AgentWorkspace = { primary, additional[] }`** 是「一个会话跨多个目录」在 agent 层的表达：`primary` 是工作目录（相对路径、bash、搜索默认都对它解析），`additional` 是项目里的其他目录（只能用绝对路径访问，绝不当子目录）。`engine.start()` 收 `string | AgentWorkspace`，`engine.workspace()` 报告当前生效的根；不存在的 additional 根在启动时被丢弃。**会话在项目内启动时覆盖整个项目，在项目外就是一个根**（`currentWorkspace()`），这条是行为分界，别在别处再拼一遍根列表。
- **根感知工具**（`packages/mcp-core/tools/workspace.mjs`）：`workspace_roots` / `read_file` / `grep_files` / `write_file` / `edit_file` / `run_bash`，入参是 `root`（目录名）+ 相对路径，越界（`..`、绝对路径、符号出根）直接拒绝。**只在多根会话里列出**（`AGENT_DESKTOP_ROOTS` 多于一个），单目录会话继续用 pi 自带的工具，不重复造轮子。主进程在 `prepare()` 里把根清单写进 `AGENT_DESKTOP_ROOTS`、把解析到的 Git Bash 写进 `AGENT_DESKTOP_SHELL`（core server 没有修好的 PATH），扩展转给 core server；`<project>` 段会告诉模型优先用它们。
- `run_bash` 的 `root` 只决定**工作目录**，shell 本身仍有完整文件系统权限（`cd ../别的仓库` 照样能跑）——要真正限制得靠沙箱，现在没有。
- 实测（两目录项目）：模型全程只用 `mcp__desktop__*`，`root: "Git"` 读到/写入第二个目录，`run_bash` 在 `Git` 里跑 `ls | head -3` 拿到真实输出；`../beta/x`、`C:/Windows/win.ini`、未知 root 全部被拒绝并列出可用目录。
- `index.ts` 里的 `status` 只是**镜像**：引擎通过 `onStatus` 推过来，`statusSnapshot()` 再加应用自己的字段（压缩百分比、档位、仓库）。写状态必须走 `engine.setStatus()`，不要直接赋值。
- 新增 pi 调用时用引擎的**语义方法**（`setModel` / `thinkingLevels` / `stats` / `messages` / `compact` / `newSession` / `switchSession` / `clone` / `abort` / `send`），**不要**再写 `engine.request('set_model')` 这种命令名：那等于把 pi 的命令表写进窗口，第二个引擎就接不进来。`PiEngine` 里这些方法只是薄封装，`index.ts` 已无一处 `engine.request(`。
- `engine.prompt()` 承担「窗口和 pi 对忙碌判断不一致」的全部兜底（压缩中等空闲后重试、`already processing` 改发 `followUp` 并回 `queued: true`），所以它是唯一发送入口；不要在别处再包一层重试。
- **Prophey 引擎（v1）**：`agent/prophey-engine.ts`，`config.engine = 'prophey'` 或设置 → 引擎切换（默认 `pi`）。它自己调 `ModelRuntime.streamSimple` 跑循环：一轮 = 一次模型回复，回复里有 `toolCall` 就执行、把 `toolResult` 塞回 transcript、再来一轮（上限 `MAX_ROUNDS = 16`），事件流和 pi 一致（`agent_start → message_start → message_update… → message_end → tool_execution_start/end → agent_end → agent_settled`）。transcript 只在内存里。
- Prophey 引擎的工具**复用 pi 那边同一份实现**：`agent/core-tools.ts` 按绝对路径 import `packages/mcp-core/tools/workspace.mjs`（打包后在 `resources/mcp/tools/`），不复制第二份；工具调用的 `root` 语义、越界拒绝、Git Bash 路径全部一致。
- **会话持久化**：`transcript-store.ts` 把 transcript 写 `userData/transcripts/<sessionId>.jsonl`（头行 + 每条消息一行，全量重写、原子 rename）；`start()` 时 resume 一次并把历史按 `message_end` 重放给窗口，所以刷新/重启后对话还在。sessionId 存在 `config.propheySessionId`，新建会话时轮换。
- **重试**：`streamRoundWithRetry` 对瞬时错误（429/5xx/timeout/ECONNRESET/流提前关闭）退避重试 3 次，发 `auto_retry_start/end`；鉴权/参数错误不重试。
- **压缩**：`compact()` 让模型把对话压成一段结构化中文摘要（目标/决定/改过的文件/未完成/继续所需事实），摘要作为唯一一条 user 消息替换 transcript；`shouldCompact()` 在**每轮开始前**按 `contextWindow × 比例` 判断是否自动压缩（配置来自窗口同一个阈值设置，不重启），并发 `compaction_start/end`。`stats()` 用 transcript 估算 token（~4 字符/token）填 `contextUsage`，所以用量环和自动压缩阈值在 Prophey 引擎下也工作。
- **子代理**：Prophey 引擎把 `packages/mcp-core/tools/subagent.mjs` 也加载进来，但**不走 MCP**——`agent/core-tools.ts` 的 `bridgeContext()` 直接对桥接的 JSON API 发请求（同一个 token、同一批端点），所以子代理管理器只有一份实现。
- **`/btw` 也通了**：`clone()` 把 transcript 复制成新 id 并返回它的路径，`switchSession()` 按路径载入，所以 `pi:btw-start` 那套「记住原会话 → fork → 关闭时切回」的记账不用改就成立（实测：起侧边对话 → 追问 → 关闭后 sessionFile 回到原值）。
- **MCP 也通了**：`agent/mcp-client.ts` 直接连桥接的 `/mcp/<key>`（streamable HTTP，`initialize` + `tools/list` + `tools/call`），工具名保持 `mcp__<server>__<tool>`，和 pi 完全一致。端点由 `mcpEndpointsFor(workspace)` 生成（同一套 `buildEngineTargets` / `buildEngineRegistrations`，所以多根仓库的 `codegraph__<repo>` 也在）。实测：Prophey 引擎下调 `mcp__codegraph__codegraph_search` 拿到了真实路径。
- **速度档位（OpenAI 部分）**：`streamSimple` 的 `samplingParams` 会原样并进请求体，所以 `service_tier: fast|ultrafast` 在 Prophey 引擎下也生效（`speed.resolveSpeedMode` 按模型判断，非 OpenAI 不会发）。Anthropic 的 `speed: "fast"` 需要另一个体字段，SDK 没暴露，所以 Claude 快速模式仍只有 pi 引擎有。**注意：这条没有在真实付费账号上验证过**（当前账号不支持该档位）。
- **`ask_user_question` 也通了**：工具直接调桥接 `/ask`（走 `node:http`，**不要用 fetch**——主进程装了全局 undici proxy dispatcher，loopback 请求会 `fetch failed`，而且 undici 有 300s headers 超时，等待用户回答必然超时）。实测：引擎调工具 → 窗口弹窗 → 回答后模型拿到选择。
- **默认引擎是 Prophey**（`config.engine` 不设或不是 `'pi'` 时都走它）；`pi` 仍是可切换的另一套实现。
- **MCP 工具名不带 `mcp__` 前缀**：那个前缀是 pi 为了给 MCP 工具分命名空间才有的，我们自己的循环不需要——工具名就是 `<server>__<tool>`（如 `codegraph__codegraph_search`、`codegraph__git__codegraph_search`）。pi 引擎那边仍然是 `mcp__…`，所以两边的工具名不同，提示词不要写死名字。
- **系统提示词由引擎自己拼**（`systemPrompt()`）：角色、`<workspace>`（主目录 + 附加目录）、`<tools>`（root 语义、先读后改、run_bash 指目录）、多根时再加 `<project>`（绝对路径、每条 bash 是新 shell、按目录选工具集）。没有扩展钩子参与。
- Prophey 引擎还缺：Anthropic 快速模式。切换引擎是热替换（`desktop:set-engine` 重建引擎对象并重启会话），不需要退出应用。
- 改名说明：产品名是 Prophey，但 `app.setName('agent-desktop')` **故意保留**——它决定 `%APPDATA%/agent-desktop`，改了等于丢失用户的配置、会话、项目和凭据。
- 还没搬完的部分：`/btw` 的 clone/switch、压缩阈值同步、登录消息、MCP 启动参数装配（`prepare` 仍由 `index.ts` 提供，这是刻意的）。

## 会话存储（我们自己的）

- `src/main/session-store.ts`：`SessionStore` 拥有会话列表（`%APPDATA%/agent-desktop/sessions.json`：`id / path / cwd / additional / projectId / title / createdAt / updatedAt`）。**窗口只读这个 store**，pi 的 JSONL 只是 `path` 这个引擎私有字段，换引擎时列表、排序、分组都不用动。
- 首次启动 `importPiSessions()` 把已有 pi 会话导入一次（走 `sessions.ts` 的 `listSessions`/`readSummary`）；之后 `rememberSession()` 在 `sessionFile` 变化、`session_info_changed`、`agent_settled` 时 upsert。新会话还没有名字时用 `readSummary` 读文件头取第一条用户消息当标题——否则侧栏会显示文件名。
- `pi:list-sessions` 先 `prune()` 掉文件已不存在的记录，再返回 `toSummary()`（形状和以前一样，渲染层不用改）。
- 别在渲染层或别处再扫 pi 的 session 目录：那等于把引擎的存储格式当数据模型，正是这层要解掉的耦合。

## 项目（多仓库）

- `src/main/projects.ts`：`ProjectStore`（`projects.json`，原子写、坏文件静默当空）+ `renderProjectSection()`。一个 project = 多个仓库根，**恰好一个 primary**，它是 pi 的 cwd。
- **项目是可选的上层，不是会话的前提**：默认侧栏还是「按文件夹分组」的老样子，没有项目时不出现任何 chip、不建任何文件。只有在需要「把多个目录合成一个工作单元」时才建项目，项目激活后会话才覆盖它的全部根。**不要**在启动时给每个会话目录自动建项目，也不要在新建会话/选目录时强制建项目（试过，等于把界面形状改了，被否掉）。
- 激活项目：`projects:activate` 把 `config.activeProject` 存下并重启 pi 到主仓库；扩展通过环境变量 `AGENT_DESKTOP_PROJECT`（`{id,name,roots}`）收到根清单，在 `before_agent_start` 里注入 `<project>` 段——**只在多根时注入**，单仓库就是普通会话。这个段和速度档位一样，注册在 `if (!url) return` 之前，MCP 全关也要生效。
- pi 没有 `--add-dir`：跨仓库靠提示词约定（绝对路径、每条 bash 是新 shell 要 `cd`、跨仓库搜索用 grep 的 `path` 参数）。实测模型能准确复述两个仓库的绝对路径。
- 侧栏在项目激活时把该项目所有仓库的会话归到同一个组头（`project:<id>`），组头的 `+` 和分支徽标用主仓库。
- 最近仓库 `config.recentRepos`（最多 12 个，启动时更新），侧栏「更多 → 最近仓库」；每仓库默认模型/思考等级存 `config.repoDefaults[cwd]`，**只在新建会话时应用**（带 `--session` 的重启不覆盖用户当前选择）。
- 项目激活时**会话目录也归到项目**：`--session-dir <profile>/sessions/projects/<projectId>`，`listSessions()` 仍然从 profile 根递归读，所以旧会话不会消失。
- 索引按项目铺开：`afterStart` 对主仓库和项目的每个根都调 `startCodegraphIndex`（`indexedRoots` 去重），否则跨仓库时代码图只覆盖主仓库。
- **引擎按仓库分端点**：`buildEngineTargets({ roots })` 给每个根生成一个 target，key 是 `codegraph`（主仓库）或 `codegraph__<repo>`（其余，小写 slug），上限 `ENGINE_ROOT_LIMIT = 3`（每个根一个上游进程 + 一套工具）。网关的 `Map` 键、桥接 `/mcp/<key>` 路由、扩展里的 server 名都用这个 key；单仓库会话的 key 就是原来的 id，行为不变。
- 两个坑：桥接的 `MCP_ENDPOINT` 正则必须允许大小写（曾经只认 `[a-z0-9_-]`，`codegraph__Git` 直接 404）；扩展的 `reportTools` 不能用 `^mcp__(.+?)__(.+)$` 拆服务器名（惰性匹配会把 `codegraph__git` 的工具记到 `codegraph` 名下），要按已注册的服务器名做最长前缀匹配。
- 实测：两仓库项目里 `mcp-tools.json` 出现 `codegraph__git`(8) / `warpgrep__git`(1)；模型用 `tool_search` 激活后真的调用了 `mcp__codegraph__git__codegraph_search`。注意 CodeGraph 是符号索引、只覆盖源码文件，全文检索仍要用 grep。
- 项目编辑在 `ProjectEditor.tsx`（改名 / 加仓库 / 移除仓库 / 换主仓库），保存走 `projects:update`；取目录用 `repos:pick-folders`（**无副作用**，不要复用 `pi:choose-workspace`，它会切会话）。移除仓库和删除项目都要**两步确认**，并且最后一个仓库不能被移除（`项目至少要有一个仓库`）。
- `@` 上下文选择器（`workspace:files`）覆盖项目的**所有根**：主仓库给相对路径（模型从 cwd 解析），其他仓库给绝对路径（`read`/`edit` 接受），预算主仓库 60%、其余平分——一个装了几千文件的工具目录否则会把列表淹掉。
- 侧栏视图选项里有「只看「项目名」」（`prefs.onlyActiveProject`），用来隐藏不属于当前项目的会话。

## 速度档位（fast / ultrafast）

- 两家都把它放在**请求体**里，但字段不同，Anthropic 还要 beta 头：OpenAI `service_tier`（`fast` 即原来的 `priority`，`ultrafast` 只有 `gpt-6-astra` / `gpt-6.1-sol`）；Anthropic `speed: "fast"` + `anthropic-beta: fast-mode-2026-02-01`，且只支持 Claude Opus 5.5 / 5 / 4.8（Opus 4.7 直接报错，4.6 静默按标准速度跑）。
- pi 自己没有这个开关（`service_tier` 只出现在内置 ai-sdk 的 chunk 里），所以走扩展的两个钩子：`before_provider_request`（改 payload）和 `before_provider_headers`（原地改 headers，返回值被忽略）。它们在 `apps/desktop/resources/extension/desktop-mcp.js` 的 `registerSpeed()` 里，**注册在 `if (!url) return` 之前**：MCP 全关时也要能改请求。
- 判定必须按 **provider**，不能只看 `model.api`：DeepSeek / Moonshot / Z.AI / Groq 都是 `openai-completions`，但都不实现 `service_tier`（发过去是 400 或未知字段）。`src/main/speed.ts` 与扩展里的 `tierFor()` 各判一次，扩展那次是防止模型中途切换后仍把档位塞给不支持的模型。
- 界面：输入框右侧 `.pill-seg.speed`（只有 `status.speed.available.length > 1` 时出现，非 `standard` 时高亮），点开是「标准 / 快速 / 极速」。`PiStatus.speed = { mode, available, note }`，`note` 说明缺哪档、为什么。
- 档位通过环境变量 `AGENT_DESKTOP_SPEED` 传给 pi 子进程（扩展在加载时读），所以切换会重启 pi；`sessionArgs()` 因此必须带上 `--provider/--model`：没有消息的新会话在磁盘上还没有文件，不带这两个参数重启会退回 settings.json 的默认模型，用户看到的是「切了档位模型自己变了」。
- 档位不是所有账号都能用：ChatGPT 订阅登录实测返回 `OpenAI API error (400): {"detail":"Unsupported service_tier: fast"}`（需要 API 计费或支持该档位的套餐，Claude 那边同理）。**没有接口能提前问出来**，所以第一次 400 就是信号：`forwardEvent` 在 `message_end` 里看到 assistant `stopReason === 'error'` 且错误匹配 `TIER_REJECTED` 时，把 `config.speed.mode` 写回 `standard`、`broadcastStatus()`、发一条 `speed_unsupported` 事件给窗口（提示「已回退标准，请重新发送」），再 `reloadPiConfig()` 让扩展不再注入。用户重新发送就正常了。
- 用户 `settings.json` 里显式写了别的 shell/模型默认值时不要覆盖；`ultrafast` 与 `flex` 的计价不同，UI 里要写清是按服务商计价的档位。

## 运行状态（busy）

- **`agent_end` 不是空闲**：自动重试、溢出恢复、压缩重试和队列消息都可能再开一轮，pi 在这段时间里会拒绝 `prompt`（`Agent is already processing…` / `Cannot submit a prompt while compaction is in progress`）。主进程只在 `agent_settled` 把 `busy` 置 false，`agent_start` / `compaction_start` 置 true；`get_state` 的 `isStreaming` / `isCompacting` 是权威值（`applyState` 会同步覆盖）。
- 之前把 `agent_end` 当空闲，导致队列 flush 抢在 pi 收尾时发送、被拒绝后弹「Agent is already processing…」并把消息退回输入框——这就是「发新消息卡住」的来源。
- `submitPrompt()`（`pi:prompt`）是唯一入口：先原样发；命中 `compaction is in progress` 就 `waitForIdle()` 后重试；命中 `already processing` 且没指定 `streamingBehavior` 就改发 `followUp` 排队并返回 `queued: true`（渲染层提示「已排队」）。**不要再在渲染层直接调 `rpc.prompt` 判断忙碌**。
- 压缩状态进 `PiStatus.compacting`，输入框占位符显示「正在压缩上下文」。
- `busy` 是事件驱动的，事件可能丢（压缩结束时 pi 正在重启、子进程被杀、`agent_settled` 没送到），而它**唯一的作用就是解锁队列**：卡住时界面一直显示运行中、排队消息永远不发。所以 `watchRunState()` 在 `busy` 期间每 3 秒 `get_state` 一次，以 pi 的答案为准。
- `startPi()` 必须返回**正在进行的那个 promise**，不能 `if (starting) return status`：第二个调用者会拿到 `phase: 'starting'`，而没有任何东西会替它把状态推到 `ready`，队列（只在 `ready` 时 flush）就永久停住。
- 渲染层的 `statusRef` 在 **effect 里**赋值，不要写成 `statusRef.current = status`（渲染期赋值）：被 React 丢弃的渲染会把 `busy` 留在 ref 里，`piBusy()` 就会和 flush 看到的状态打架。
- 运行中改 MCP/子代理设置走 `reloadPiConfig()`：忙碌时只记 `configPending`，`agent_settled` 时用 `sessionArgs()` 重启 pi 把新配置装上（否则开关改了永远不生效）。
- pi 非预期退出（扩展抛错、OOM）时 `rpc.on('exit')` 会在 1 秒后用同一会话重启，2 分钟内最多 3 次；`shuttingDown` 为真（`window-all-closed` / `before-quit`）时不再重启。
- 扩展里的定时器**必须能容忍失效的 ctx**：`new_session` / `clone` / `switch_session` / `reload` 之后捕获的 `pi` 会变 stale，`pi.getAllTools()` 抛出的异常会直接杀掉整个 pi 进程（实测 `Timeout.reportTools` 崩溃导致「pi 未运行」）。`reportTools` 已包 try/catch。

## Updates & packaging

- 更新实现：`apps/desktop/src/main/updates.ts` 使用 `electron-updater`。打包版走 electron-updater（GitHub Release 的 `latest.yml` + NSIS 安装包）；开发模式用 GitHub Release API 只做版本检测，`canInstall=false`。启动 5 秒后及每 6 小时自动检查，开关存在 userData 的 `updates.json`。
- 更新源默认 `touwaeriol/prophey`，可用环境变量覆盖：`PI_DESKTOP_UPDATE_REPO=owner/repo`、`PI_DESKTOP_UPDATE_URL=<generic feed>`、`PI_DESKTOP_RELEASES_URL=<发布页>`。`electron-builder.yml` 的 `publish` 也要同步 owner/repo。
- 打包：根目录 `npm run dist`（`electron-builder.yml`，NSIS，输出 `release/`）。`asarUnpack` 包含 `@earendil-works/**`、`quickjs-wasi`、`@silvia-odwyer/**`；`findBundledCli` 在打包版优先从 `process.resourcesPath/app.asar.unpacked` 找 pi CLI。
- 系统代理：`proxy.ts` 用 `session.resolveProxy` 解析系统代理，设置 `HTTP(S)_PROXY`/`NO_PROXY`/`NODE_USE_ENV_PROXY`，并通过 `setGlobalDispatcher(new EnvHttpProxyAgent())` 让主进程 fetch 走代理；pi 子进程继承同一环境。设置页「网络代理」显示检测结果。
- 应用名：`app.setName('agent-desktop')`，userData 为 `%APPDATA%\agent-desktop`；启动时会从旧 `%APPDATA%\@pi-mcps\desktop` 迁移 `config.json`/`device-id`/`updates.json`。
- GitHub Actions 用 `--publish never` 打包，再用 `gh release create` 上传资产，避免 electron-builder 并发上传时创建重复 draft release。
- 在带有 `ELECTRON_RUN_AS_NODE=1` 的终端里测试打包版必须 `env -u ELECTRON_RUN_AS_NODE`，否则 exe 会按 Node 运行并立即退出。

## Sessions & workspace

- **配置来源（profile）**：`config.json.profile` 为 `shared`（默认，读写 pi CLI 的 `~/.pi/agent`）或 `desktop`（`%APPDATA%/agent-desktop/pi`）。`src/main/profile.ts` 是唯一知道路径的模块（`agentDir()/authPath()/modelsPath()/settingsPath()/mcpPath()/profileSessionDir()`），**不要在别处硬编码 `~/.pi/agent`**，否则切换 profile 会有一半代码还在写 CLI 的文件。隔离靠给 pi 子进程设 `PI_CODING_AGENT_DIR`（pi 用它覆盖配置目录），`startPi` 里只在隔离时设置；我们的 `ModelRuntime` 用显式 `authPath/modelsPath`，所以 `applyProfile()` 之后必须 `providers.invalidateCache()`。
- 隔离 profile 下 session 目录也跟着走（`<profile>/sessions`），`sessionDirArgs()` 两种会话模式都显式传 `--session-dir`，避免隔离时把会话写进 CLI 的目录。
- 「从 CLI 导入」(`providers.importFromCli`)：`auth.json` 是**合并**（pi 在新目录首次启动会自己建一个空的 `auth.json`，按「文件存在就跳过」会让用户永远没有凭据），其余文件只在目标不存在时复制。导入后 `resetRuntime()` + 重启 pi。
- 会话默认与 pi 共用 `~/.pi/agent/sessions`；desktop `config.json` 的 `sessionMode` 为 `isolated` 时，启动 pi 会附加 `--session-dir <userData>/sessions`，`listSessions` 也读该目录。两种模式都由 pi 写 JSONL，结构不变，可随时切回共用。
- 工作目录是**会话级**的：点击其他项目的会话必须走 `pi:open-session`（以该会话 cwd + `--session <path>` 重启 pi），不能只用 `switch_session`，否则工具会在错误目录运行。设置页只读显示当前会话目录，不提供全局工作目录编辑。
- `config.json` 保存 `{ cwd, sessionMode, mcp }`；`cwd` 只是下次启动/新建会话的默认目录。目录不存在时 `startPi` 会回退到 home，避免 spawn ENOENT。

## MCP & desktop tools

- 桌面提问工具 `ask_user_question` 是一条自建链路，四段：
  1. `packages/mcp-core/server.mjs` — 零依赖 stdio MCP 服务器（手写 JSON-RPC：`initialize` / `tools/list` / `tools/call`，按 `\n` 分帧，日志只走 stderr），工具在 `tools/index.mjs` 注册、实现在 `tools/ask-user.mjs`（每个工具导出 `name` / `title` / `description` / `inputSchema` / `call(args, context)`，`context` 提供 `post(path, payload, signal)`、`signal`、`log`）。注册名仍是 `desktop`（核心交互 MCP），新桌面工具加在这个包里，不要另起服务器。
  2. `apps/desktop/resources/extension/desktop-mcp.js` — pi 扩展，读 `AGENT_DESKTOP_MCP_URL/TOKEN/CORE_SCRIPT/ENGINES/TOGGLES` 后 `pi.registerMcpServer(...)`。核心服务器**必须 `exposure: 'direct'`**（默认 `codemode` 不会把工具声明给模型）。**`timeout` 必须传 `Number.POSITIVE_INFINITY`**：pi 把 `config.timeout`（秒）乘 1000 传给 MCP client，`armTimeout` 在 `!Number.isFinite(timeoutMs)` 时不 arm 定时器，所以只有非有限值才真正不超时；填大数字会踩 `setTimeout` 的 2^31-1 ms 上限而立刻超时（默认值是 60 秒）。
  3. `apps/desktop/src/main/bridge.ts` — 只监听 `127.0.0.1` 的 HTTP 桥，`POST /ask`（`x-agent-desktop-token` 校验）→ 渲染层弹窗 → 回答后返回 JSON。**不要加等待超时**（`server.requestTimeout`/`server.timeout` 都设 0）；取消只来自 `cancelAllAsks`：pi 重启、关窗、退出、以及 `pi:abort`（同时给渲染层发 `ask:cleared` 关掉面板）。同一个桥还有 `POST /tools`：扩展把各内置服务器实际注册的工具回报给主进程，写进 `%APPDATA%\agent-desktop\mcp-tools.json`，设置页的工具开关就靠这份清单。
  4. 渲染层 `AskQuestionPanel.tsx` — **内联面板，固定在输入框上方**（不要做全屏弹窗），高度控制在 ~130-160px：标题行、问题行（tag 内联）、**选项一行一个（不要并排）**、底栏同一行放输入框和按钮。单选 / 多选 / 手动输入；手动输入框常驻，直接打字即可，不用先选“其他”；单选时选项与手动输入互斥，多选时两者可叠加。顶部步骤条（仅多问题时显示）可点击跳回任意问题重新回答，`上一步` / `下一步` / `跳过` / `提交` 支持前后修改。`App.tsx` 用队列保存请求（`askQueue`），一次只显示一个，回答后从队列移除。
- 工具命名是 pi 生成的 `mcp__desktop__ask_user_question`。验证链路最快的方式：向桥 `POST /ask`（端口和令牌在 `%APPDATA%\agent-desktop\config.json` 的 `mcp.bridgePort/bridgeToken`），不需要真实模型调用。
- 注册方式选扩展 + `--extension`，**不要**写 `~/.pi/agent/mcp.json`：这样桌面端的工具不会污染终端里的 pi，桥接端口/令牌也不用每次启动改写用户配置。`mcpArgs()` 在总开关关闭时传 `--no-mcp`，桌面工具关闭时不传 `--extension`。
- **MCP 不能提供系统提示词**：协议只有 `initialize.instructions`（+ `prompts` 原语），pi 的 MCP 客户端只读 `instructions`，且只用于 codemode 命名空间的 `describeNamespace()` 和 `mcp_servers` 段——而 `mcp_servers` 段由 `renderServersSection()` 里的 `hasIndirectTools` 过滤，**`direct` 暴露的服务器不会出现在里面**（每服务器也只取第一行、≤250 字符、整段 ≤4096）。`prompts/list`、`prompts/get`、`sampling`、`elicitation` pi 都没实现（client 只声明 `roots`）。所以 `server.mjs` 里的 `instructions` 在 direct 下对模型不可见，只对 codemode 有意义。
- 因此模型的使用引导由扩展注入：`desktop-mcp.js` 挂 `before_agent_start`，往 `event.systemPromptOptions.sections.desktop_tools` 写一段文案。**必须用 `pi.getActiveTools().includes('mcp__desktop__ask_user_question')` 门控**：只有 MCP 打开、桌面工具打开、服务器真正连上、工具被声明给模型时才注入；否则 `delete sections.desktop_tools`。段名要匹配 `^[a-z][a-z0-9_-]*$` 且不能叫 `preamble`；段内容由 pi 包成 `<desktop_tools>…</desktop_tools>`，不要再手写标签。每轮都会重算，`diffSystemPromptSections` 会把不存在的段 patch 成 null，所以关掉 MCP 后旧段会自动消失，不需要清理会话文件。
- 扩展还无条件往 `event.systemPromptOptions.promptGuidelines` 里推几条规则（`EXTRA_GUIDELINES`）：
  - 批量：需要多个互不依赖的调用时**在同一条 assistant 消息里一起发**，不要在调用之间重复推理。
  - 搜索：用 `grep` / `find` 工具而不是 `bash grep -rn` / `bash find`，并且不要手动搜 `node_modules`、`.git`、`dist`、`out` 或已安装应用的 resources。**这是最常见的失败来源**：pi 的 bash 工具没有默认超时，模型自己传 `timeout: 60`，而 `grep -rn` 会走 `node_modules`（实测同一查询：`rg` 78ms，`grep -rn` 14.3s，冷缓存/Defender 下直接超 60s）。
  - **用 guidelines 而不是自定义 section**：guidelines 会进系统提示的 `<rules>` 列表，和 pi 自己的规则并排，模型遵守率明显更高（自定义段要模型自己决定去读）。pi 每轮一次模型请求，一次只发一个调用就是多一次往返——实测旧会话 131 轮里平均只有 1.2 个调用/轮，这就是「一工具一思考」的来源。
- 路径解析：打包版从 `process.resourcesPath/extension|mcp` 取（`electron-builder.yml` 的 `extraResources` 负责拷贝 `resources/extension` 与 `packages/mcp-core` 的 `server.mjs` + `tools/**`），开发版用 `searchUp` 从 `app.getAppPath()` 向上找 `resources/extension/desktop-mcp.js` 和 `packages/mcp-core/server.mjs`。改了资源位置要同时改这两处。
- 设置 → MCP（`McpPanel.tsx`）管理 `~/.pi/agent/mcp.json`：总开关（`config.json.mcp.enabled`）、桌面工具开关（`mcp.desktopTool`）、服务器启用/删除/新增（新增接受一段 JSON，需含 `command` 或 `url`）。任何变更都会 `reloadPiConfig()` 重启 pi。
- 项目级 `.pi/mcp.json` 只读展示并合并到列表（同名覆盖用户级），仅在信任项目时由 pi 生效。

### 内置引擎（CodeGraph / WarpGrep）

- 两个引擎定位不同：CodeGraph 是**本地 CLI**（npm 全局包 `@colbymchenry/codegraph`，入口解析到 `npm-shim.js`，用 node 跑，避免 Windows `.cmd` 需要 shell），WarpGrep 是 **Morph 托管 API**（只需要 API Key，没有二进制）。检测在 `apps/desktop/src/main/engines.ts`：CodeGraph 走「显式入口 → 已知安装路径 / PATH → `--version` 校验」，WarpGrep 的可用性就是有没有 key；检测结果缓存 60s，`invalidateDetection()` 在改入口时清掉。**显式入口不可用时不要回退到自动检测**。
- 默认关闭（`config.json.mcp.engines.<id>.enabled`），设置页逐个开启；CodeGraph 未安装时卡片显示安装命令和「选择入口」，WarpGrep 卡片是 API Key 输入框（`config.json.mcp.morphApiKey`，UI 只显示掩码）。
- **架构是网关，不是直连**：`apps/desktop/src/main/gateway.ts` 在主进程里持有引擎（CodeGraph 是 stdio 子进程，WarpGrep / web 直接在主进程里跑），对外由桥（`bridge.ts`）暴露 **一个服务、多个端点**：`POST /mcp/codegraph`、`POST /mcp/warpgrep`、`POST /mcp/web`。pi 用 `registerMcpServer(name, { url, headers: { authorization: 'Bearer <token>' } })` 连这些端点，模型看到的是网关的工具集，不是引擎的全量工具。
- 端点只实现 streamable HTTP 的最小合法形态：POST 返回 `application/json`，GET 返回 405（pi 的客户端把 405 当作"没有 server→client 流"），DELETE 返回 204。**不要**加 SSE，pi 的 `McpStreamableHttpTransport` 接受 JSON 响应。
- 工具数量由 `ALLOWED_TOOLS` 控制（`engines.ts`）：CodeGraph 8 个、WarpGrep 1 个（`codebase_search`）、web 2 个（`web_search` / `web_fetch`，都是 direct，所以不激活 `tool_search`）。新增/裁剪工具改这里。
- **CodeGraph 默认不返回源码**（对齐 codegraph-desktop）：网关把 `codegraph_explore` 的 schema 加上 `includeSource`（默认 false），调用时若没显式要求源码，就改写成 `codegraph_search` + `limit:10` 转发；`codegraph_node` 强制 `includeCode:false`。模型只拿到符号名、签名和 `file:line`，需要源码时自己 read。不要在网关里放开源码默认值——那会让一次 explore 返回上万字符。
- 暴露策略：服务器级 `exposure: 'deferred'`，`toolExposure` 把核心工具标 `direct`（CodeGraph: `explore/search/callers/impact`；WarpGrep: `codebase_search`），其余走 `tool_search`。pi 会因此激活 `tool_search` 工具，并在系统提示词里生成 `mcp_servers` 段。
- 网关只把**真实失败**（spawn 失败、进程退出、initialize 失败、Morph API 错误）当作错误上报；引擎自己往 stderr 打的 INFO 日志不算错误。
- WarpGrep 的搜索循环在 `apps/desktop/src/main/warpgrep.ts`：模型（`morph-warp-grep-v2.1`）规划 `list_directory` / `grep_search` / `glob` / `read` / `finish`，本模块在会话目录内执行（路径越界直接拒绝），最多 6 轮。**读取的文件片段会发给 Morph API**，UI 里要保留这句提示。没有 key 时调用返回 `MORPH_NO_KEY`。
- 用户关掉的工具写成 `toolExposure[tool] = 'hidden'`（`config.json.mcp.toolToggles`），工具仍在 `getAllTools()` 里但 `exposure: 'hidden'`，所以设置页能继续显示并重新打开。
- CodeGraph 索引：只在**没有** `.codegraph` 时自动 `codegraph init`；**不要自动 `sync`**——运行中的 MCP 服务器持有 CodeGraph 写锁，自动 sync 会报 "database is locked"。重新索引是设置页的手动动作（`codegraph unlock` 提示也在这里给出）。
- **不要设置 `CODEGRAPH_NO_DAEMON=1`**：那会让服务器独占写锁，用户同时用 IDE/终端的 CodeGraph 时，后启动的一方要么拒绝启动，要么只暴露 3 个工具（`search/node/explore`）。让它代理到共享 daemon 才能共存。`CODEGRAPH_MCP_TOOLS` 必须设，否则默认只暴露 `codegraph_explore`。
- 引擎会往项目里写 `.codegraph/`（已加进 `.gitignore`）。

### 网络搜索（web engine）

- `web` 是网关里的**第三个引擎**（`/mcp/web`，`kind: 'web'`），提供 `web_search` + `web_fetch`，两个都是 `direct`。实现在 `apps/desktop/src/main/web.ts`，网关侧只是 `WebGateway` 转发（`gateway.ts`）。不需要二进制、不需要额外进程。
- **pi 自己没有 provider 原生 web 工具**：`RequestOptions` 只支持客户端 function tool，`convertTools` 永远生成 `{name, description, input_schema}`，没有任何 server tool 通道。想用原生搜索只能在主进程自己发 HTTP，所以 `web.ts` 直接调各家 API，凭据走 `ModelRuntime.getAuth(providerId)`（OAuth 由 pi 自己刷新，桌面端不读 auth.json）。
- `web_search` 的后端解析顺序（`describeRoute`）：`mode: 'native'` → 只允许服务商原生；`'brave'` → 只用 Brave；`'auto'`（默认）→ 当前模型的服务商在 `mcp.web.native[provider] === true` 且实现存在时用原生，否则 Brave。原生失败**回退 Brave** 并在结果顶部加一行说明；只有「既没 Brave Key 又原生失败」才报错。
- 原生实现：`anthropic`（`/v1/messages` + `web_search_20250305`，OAuth 用 `authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`）、`openai`（`/responses` + `web_search_preview`，取 `annotations[].url`）、`google`（`generateContent` + `google_search` grounding，取 `groundingChunks[].web`）、`deepseek`（**专用 Search API**：`POST {base}/v1/tools/search` + `Authorization: Bearer`，body `{query, count, need_content}`，返回结构化 `results[].{title,url,summary,content}`，实测 355ms）。想加新服务商改 `NATIVE_PROVIDERS` + `nativeSearch()`。
- **DeepSeek 不要走 Anthropic 兼容接口做搜索**：`/anthropic/v1/messages` 确实接受 `web_search_20250305` 并返回 `web_search_tool_result`（实测 10 条/次），但一次搜索等于一整个模型回合，而且「模型觉得不用搜」时根本不出结果块（问日期就直接凭记忆答）。专用 Search API 更便宜、更快、结果结构化。`models.json` 可能把 deepseek 指到 `…/anthropic` 代理，所以拼路径前先 `replace(/\/anthropic$/, '')`。
- `web_fetch` **永远本地抓取**（DeepSeek 也有 Fetch API，但本地抓不花 Key、不把 URL 交给第三方）：`fetch` → charset 嗅探（含 `<meta charset>`/GBK）→ HTML 转 Markdown（去 script/style/nav，保留标题/列表/链接/代码块），`maxChars` 截断。拒绝 localhost / 内网 / 169.254 / ULA 地址（SSRF），需要本地内容时让模型用 `read`/`bash`。
- 配置在 `config.json` 的 `mcp.web`：`mode` / `braveApiKey` / `native`（provider → true）/ `count` / `maxChars`。`mcp.web.native` 就是**服务商列表里那个「联网」开关**（`SettingsModal` 的 provider 行，只对 `McpWebState.nativeSupported` 里的服务商显示）。路由（Brave / 原生）是**按调用实时解析**的，所以改开关本身不重启 pi；只有「有没有任何后端」发生变化时才 `reloadPiConfig()`——那决定了 `/mcp/web` 端点是否注册。改 Brave Key 或 web 引擎开关一律重启。
- 可用性：没有任何后端（无 Brave Key、无原生服务商）时 `buildEngineTargets` 不产出 web target，端点不注册，开关按钮为灰。
- 扩展里的 `web_tools` 段：`before_agent_start` 里用 `pi.getActiveTools()` 门控（同 `desktop_tools`），文案强调「搜索结果不是来源，要 `web_fetch` 打开页面并给 URL」，关掉 MCP 后该段自动消失。
- **不要**把 WarpGrep 当网页搜索：Morph 只有项目内代码检索（`warp_grep`），没有通用 web search API。

### 子代理（subagents）

- **每个子代理是一个独立 `pi --mode rpc` 子进程**，由主进程 `apps/desktop/src/main/subagents.ts` 的 `SubagentManager` 管理；会话目录 `%APPDATA%/agent-desktop/subagents`，不写用户 `~/.pi/agent/sessions`，侧栏也看不到。默认加 `--no-mcp`：子代理不能反问用户（`ask_user_question`），也不能再起子代理。
- 主会话通过 8 个桌面工具驱动：`search_agents` / `list_models` / `start_subagent` / `get_subagent` / `wait_subagent` / `send_subagent_prompt` / `stop_subagent` / `get_subagent_changes`，实现在 `packages/mcp-core/tools/subagent.mjs`，只做参数校验 + 转发。
- **工具返回默认是 Markdown**，JSON 只在显式传 `format: "json"` / `include` / `detail` 时返回；`ask_user_question` 也不再附带 JSON 副本。模型不需要解析结构，重复的键名纯属浪费 token。
- `get_subagent` / `wait_subagent` **默认只返回最终结论 + 改动摘要**，运行中只给状态行；要看过程必须显式传 `include: ["messages"]`（带 `since` 游标）或 `["last"]`。
- 预设：内置 `explorer` / `reviewer` / `tester` / `worker`（`apps/desktop/src/main/agents.ts`），用户可在 `%APPDATA%/agent-desktop/agents.json` 覆盖或新增；优先级 = 内置 ← 用户文件 ← `start_subagent` 显式参数。预设字段全部落到 pi 启动参数（`--tools`、`--provider/--model`、`--append-system-prompt`）。
- 子代理的界面在 **设置 → 代理**（`AgentsPanel.tsx`），不在 MCP 页：预设列表 + 编辑器（id/名称/说明/启动方式/工具白名单/模型/追加系统提示词），保存走 `agents.savePreset` 写 `agents.json` 后重启 pi；删除走 `agents.deletePreset`（内置预设会恢复默认）。`Toggle` 已抽到 `components/Toggle.tsx`，MCP 与代理两页共用。
- **预设没有"加载"概念**：`search_agents` 返回 id 后可直接 `start_subagent({ agent })`，不需要像 `tool_search` 那样把 schema 声明进工具列表。`agents.exposure` 只控制要不要提前把列表写进系统提示词（`prompt` / `lazy` / `hidden`，超过 `promptLimit` 自动只列 `visible` 的）。
- `<agents>` 段由主进程渲染后经 `AGENT_DESKTOP_AGENTS_SECTION` 传给扩展，扩展在 `before_agent_start` 里注入 `sections.subagents`，**门控**：`pi.getActiveTools()` 里有 `mcp__desktop__start_subagent` 才注入，否则删除。
- 这段除了预设清单，还有 `SUBAGENT_USAGE`（`agents.ts`）——**何时该用子代理**：自包含且会污染上下文的工作（大范围探索、长验证循环、diff 审查）、可并行的独立切片；不该用的（几次工具调用、依赖本会话上下文、需要用户决策、不可逆操作）。外加"子代理是瞎的，任务里必须写清目标/路径/约束/完成标准，不要写‘如前所述’"。`prompt` 与 `lazy` 两种暴露都带这段，只有 `hidden` 不带。实测：让模型把系统提示里这段原样贴出来，能完整复现。
- 桥内部 API（JSON，给 mcp-core 用）：`GET /agents`、`GET /models`、`POST /subagents`、`GET /subagents/:id`、`POST /subagents/:id/{prompt,stop,wait}`、`GET /subagents/:id/changes`。令牌沿用桥的 Bearer。
- **子代理结束怎么通知父代理**：工具调用返回后无法再回调，所以走"主进程 → 桥事件 → 父进程内的扩展"这条线。`SubagentManager` 的 `onSettle` 把一条三行通知交给 `bridge.publishEvent()`；扩展（`desktop-mcp.js` 的 `pumpEvents`）长轮询 `GET /events?wait=25000`（Bearer 令牌，最长等 60s，队列上限 20 条、10 分钟过期），收到后 `pi.sendMessage({ customType: 'subagent_notice' }, { triggerTurn })`。
- 子代理的模型：`start_subagent` 的 `provider`/`model` 先经 `providers.resolveModelChoice()` 校验（`getModels()` 全量目录，**不受 `enabledModels` 白名单影响**，包含 models.json 自定义项）。pi 对未知模型 id 不会报错，只会跑出空结论，所以必须在启动前拦：`UNKNOWN_PROVIDER` / `UNKNOWN_MODEL`（附可用 id）/ `PROVIDER_NOT_CONFIGURED` / `AMBIGUOUS_MODEL`（只给 model 且多服务商都有）。只给 `model` 且唯一时可自动定位 provider。`thinking` 走 `--model <id>:<level>`，实测 `deepseek-v4-pro:high` 生效。
- 记录里的 `model` 以子进程 `get_state` 返回的**实际模型**为准（`waitReady` 时抓取），所以"继承主会话"也能显示真实值，不是猜的。
- `start_subagent` 的 `notify`：`wake`（background 默认，`triggerTurn: true`：空闲时立刻开一个回合，正在流式则作为 steer 插到当前回合之后）、`queue`（只追加一条 custom 消息，**不会**让父代理动起来，等下个回合才被读到）、`none`（sync 默认，只有 `get_subagent` / `wait_subagent` 能看到）。实测过：`queue` 只产生 `custom:subagent_notice`、`assistants` 不变；`wake` 会多一个 assistant 回合。
- 用户刚点过「停止」（`pi:abort` 30 秒内）时，`onSettle` 会把 `wake` 降级成 `queue`，否则用户刚停下的会话会被子代理通知重新拉起来。
- 通知正文用 `<system-reminder source="agent-desktop">` 包起来：pi 把 custom 消息和用户消息**都**转成 `role: "user"` 发给模型（`core/messages.js` 的 `convertToLlm`），不标记的话模型会以为这是用户说的话。pi 自己不解析任何标签，这层纯粹是给模型的约定。
- 渲染层只认 `customType === 'subagent_notice'`：`toChatItems` 和 `App.tsx` 的 `message_end` 都把它变成 `role: 'system'` 的条目，`Conversation.tsx` 画成虚线条（`.system-notice`），**不要**让它变成用户气泡。`noticeText()` 负责剥掉 `<system-reminder>` 外壳。
- 父会话重启（换模型）时扩展重新加载、长轮询重连，队列里没投递的事件会补发；所以事件队列在**主进程**里，不要在扩展里缓存。
- 控制语义映射到 pi：`interrupt` = `abort` + `prompt`，`steer` = `prompt(..., streamingBehavior: 'steer')`，`follow-up` = `'followUp'`。
- 限制：并发 4（超出报 `SUBAGENT_LIMIT`，不排队）、单次总运行 15 分钟、空闲 30 分钟回收、sync 最长等 300s 后转后台、应用退出 `stopAll(true)`。**主会话重启（换模型等）不杀子代理**，它们本来就是独立进程。
- **子代理界面**：顶栏 `.subagent-btn`（运行中显示数字并高亮，否则显示已完成数）打开右侧抽屉 `SubagentsDrawer.tsx`：列表 ↔ 详情两态（详情有返回按钮），详情含结论 Markdown、改动文件、过程消息、引导/追加/打断 + 停止。数据来自 IPC `subagents:list|get|stop|prompt|reveal` 与事件 `subagents:update`（`serializeSubagent`）。每行带 `.subagent-avatar` 图标徽标（按状态着色），抽屉支持 `initialId` 直接选中某次运行。
- 抽屉是布局的一部分，不是覆盖层：`App.tsx` 的 `.main-body` 是横向 flex（`.chat-column` + `.subagent-drawer`），打开时会话区与输入框一起变窄（实测 chat 1108→708、composer 860→644），不会盖住正文。新增右侧面板时照这个结构放，别用 absolute 遮罩。
- **运行状态条在输入框上方**（`RunStatusBar.tsx`，通过 `Composer` 的 `statusBar` 插槽放进 `.composer-wrap`）：父会话在跑时显示耗时 / tokens / 工具数，空闲时显示「子代理运行中 N」；每个运行中的子代理是一枚 `.run-task` chip（图标 + 名称 + 耗时），点击打开面板并选中该运行。
- **对话里的子代理卡片**：`start_subagent` 的工具调用不再混进「调用 N 个工具」，而是渲染成 `.subagent-card`（图标、label、预设、状态、id、耗时），展开可看实时输出 / 最终结论，并有「查看详细进程」跳到面板。匹配记录靠工具结果里的 `sa_xxxxxxxx`，结果还没回来时按 `label` 匹配。
- 子代理的**实时进度**：`SubagentsManager.onEvent` 里 `message_end`（assistant 文本）直接追加进 `record.messages` 并 `emit`，所以运行中也能在卡片和面板看到它刚说的话；settle 时 `collect()` 用 `get_messages` 整体重写，不会重复。
- **记录落盘**：`SubagentManager` 把记录写到 `%APPDATA%/agent-desktop/subagents.json`（上限 120 条、800ms 防抖）。启动时 `restore()` 读回，`starting/streaming` 的标记成 `stopped` 并带 `restored: true`。历史记录**没有进程**（`Internal.rpc` 可选），`prompt` 报 `SUBAGENT_GONE`、`stop/wait` 直接返回；`runningCount()` 排除历史记录，否则并发上限会被旧数据占满。记录里保存 `sessionFile`（子代理自己的会话，可用 `pi --session` 复现）和 `parentSession`（发起它的主会话），面板上「定位」用 `shell.showItemInFolder`。
- 模型侧查询：`list_subagents`（`GET /subagents?q=&status=&agent=&limit=`，匹配 id / label / 预设 / cwd / 结论）→ 返回紧凑 Markdown 列表；`get_subagent` 对历史记录同样有效，并在输出里标「历史」。**历史记录只能读，不能继续对话**。
- **退出必须杀进程树**：`apps/desktop/src/main/proc.ts` 的 `killTree(child, sync)` 在 Windows 上走 `taskkill /pid <pid> /T /F`（`child.kill()` 只杀直接子进程，会留下 pi 拉起的 `mcp-core/server.mjs` 和 CodeGraph worker）。`window-all-closed` / `before-quit` 用 `rpc.killNow()` + `gateway.stopAll(true)` + `subagents.stopAll(true)`，因为退出时 `stop()` 里那个 1.5s 的兜底定时器根本来不及跑。MCP 设置变更仍走 `reloadPiConfig()` → `startPi()` → `mcpLaunch()`（重建引擎目标、`gateway.configure()` 差分启停），所以"改设置后 MCP 跟着重启"本来就是这条路，别另起一套。
- 工具调用记录取自 `tool_execution_start` 的参数（`path` / `command` / `pattern`），不要用工具输出首行猜路径——`read` 的输出首行是内容，会把路径解析成 `{`。
- 服务器连接是异步的，扩展在加载后 2.5s / 8s 各补报一次工具清单（`POST /tools`），否则设置页只会看到连接完成前的那部分工具。
