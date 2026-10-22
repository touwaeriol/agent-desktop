# pi-mcps

## Layout

- `apps/desktop` — Electron + React 桌面端。主进程 (`src/main`) 以 RPC 子进程方式启动 pi，渲染层 (`src/renderer`) 只通过 preload 暴露的 `window.pi` 通信。
- `packages/` — 预留给后续给 pi 使用的 MCP 服务器（TypeScript）。
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

## Updates & packaging

- 更新实现：`apps/desktop/src/main/updates.ts` 使用 `electron-updater`。打包版走 electron-updater（GitHub Release 的 `latest.yml` + NSIS 安装包）；开发模式用 GitHub Release API 只做版本检测，`canInstall=false`。启动 5 秒后及每 6 小时自动检查，开关存在 userData 的 `updates.json`。
- 更新源默认 `touwaeriol/pi-mcps`，可用环境变量覆盖：`PI_DESKTOP_UPDATE_REPO=owner/repo`、`PI_DESKTOP_UPDATE_URL=<generic feed>`、`PI_DESKTOP_RELEASES_URL=<发布页>`。`electron-builder.yml` 的 `publish` 也要同步 owner/repo。
- 打包：根目录 `npm run dist`（`electron-builder.yml`，NSIS，输出 `release/`）。`asarUnpack` 包含 `@earendil-works/**`、`quickjs-wasi`、`@silvia-odwyer/**`；`findBundledCli` 在打包版优先从 `process.resourcesPath/app.asar.unpacked` 找 pi CLI。
- 在带有 `ELECTRON_RUN_AS_NODE=1` 的终端里测试打包版必须 `env -u ELECTRON_RUN_AS_NODE`，否则 exe 会按 Node 运行并立即退出。

## Sessions & workspace

- 会话默认与 pi 共用 `~/.pi/agent/sessions`；desktop `config.json` 的 `sessionMode` 为 `isolated` 时，启动 pi 会附加 `--session-dir <userData>/sessions`，`listSessions` 也读该目录。两种模式都由 pi 写 JSONL，结构不变，可随时切回共用。
- 工作目录是**会话级**的：点击其他项目的会话必须走 `pi:open-session`（以该会话 cwd + `--session <path>` 重启 pi），不能只用 `switch_session`，否则工具会在错误目录运行。设置页只读显示当前会话目录，不提供全局工作目录编辑。
- `config.json` 保存 `{ cwd, sessionMode }`；`cwd` 只是下次启动/新建会话的默认目录。目录不存在时 `startPi` 会回退到 home，避免 spawn ENOENT。

