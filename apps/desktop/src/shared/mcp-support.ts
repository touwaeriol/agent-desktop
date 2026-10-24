/**
 * Which MCP groups each engine can actually use.
 *
 * This is a *description* only: nothing here changes behaviour, it exists so the MCP settings page
 * can mark "not applicable to this engine" instead of offering a switch that silently does nothing.
 * Behaviour stays where it is — `mcpEndpointsFor()` decides what is injected, `subagents.ts` decides
 * what a subagent may use. If one of those changes, this table has to change with it.
 */
import { engineLabel, type EngineId } from "./engine";

/** Built-in MCP groups plus the hand-added servers from `mcp.json`. */
export type McpGroupId =
  "desktop" | "codegraph" | "warpgrep" | "web" | "subagents" | "external";

export type McpSupportState =
  /** The engine connects to it exactly as configured here. */
  | "supported"
  /** The engine can do the job, but through its own native tool — this MCP is not injected. */
  | "native"
  /** Not used by this engine at all. */
  | "unsupported";

export interface McpSupport {
  engine: EngineId;
  state: McpSupportState;
  /** One short line for the tooltip / the expanded row. */
  note: string;
}

const PROPHEY: McpSupport = {
  engine: "prophey",
  state: "supported",
  note: "引擎自己连桥接端点，工具名不带 mcp__ 前缀。",
};
const PI: McpSupport = {
  engine: "pi",
  state: "supported",
  note: "经扩展注册到 pi，工具名带 mcp__ 前缀。",
};
const CLI_OFF = (extra: string): McpSupport => ({
  engine: "claude",
  state: "unsupported",
  note: `Cli 引擎不注入桌面 MCP：${extra}`,
});

function support(group: McpGroupId): McpSupport[] {
  /** Both managed engines (Prophey, pi) get the same gateway endpoints. */
  const managed = (prophey: Partial<McpSupport> = {}): McpSupport[] => [
    { ...PROPHEY, ...prophey },
    { ...PI, ...prophey },
  ];
  switch (group) {
    case "desktop":
      return [
        {
          ...PROPHEY,
          note: "由内建引擎直接加载 ask-user 工具模块，不经过 MCP 服务器。",
        },
        {
          ...PI,
          note: "由 pi 扩展以 direct 暴露注册，工具名 mcp__desktop__*。",
        },
        {
          engine: "claude",
          state: "native",
          note: "Claude Code 用自己的 AskUserQuestion，桌面 MCP 不注入。",
        },
        {
          engine: "codex",
          state: "native",
          note: "Codex 用自己的审批/提问回调，桌面 MCP 不注入。",
        },
      ];
    case "codegraph":
      return managed().concat([
        {
          engine: "claude",
          state: "unsupported",
          note: "CLI 引擎不注入桌面 MCP；需要时在它们自己的配置里装 CodeGraph。",
        },
        {
          engine: "codex",
          state: "unsupported",
          note: "CLI 引擎不注入桌面 MCP；需要时在它们自己的配置里装 CodeGraph。",
        },
      ]);
    case "warpgrep":
      return managed().concat([
        { ...CLI_OFF("它们有自己的搜索工具"), engine: "claude" },
        { ...CLI_OFF("它们有自己的搜索工具"), engine: "codex" },
      ]);
    case "web":
      return managed().concat([
        {
          engine: "claude",
          state: "native",
          note: "Claude Code 用自己内置的联网搜索，桌面 web 引擎不注入。",
        },
        {
          engine: "codex",
          state: "native",
          note: "Codex 用自己内置的联网搜索，桌面 web 引擎不注入。",
        },
      ]);
    case "subagents":
      return managed().concat([
        { ...CLI_OFF("使用它们原生的子代理"), engine: "claude" },
        { ...CLI_OFF("使用它们原生的子代理"), engine: "codex" },
      ]);
    // Hand-added servers come from `~/.pi/agent/mcp.json` + `<repo>/.pi/mcp.json`, which only pi
    // reads. The managed engines reach MCP through the app's gateway, so these never reach them.
    case "external":
      return [
        {
          ...PROPHEY,
          state: "unsupported",
          note: "内建引擎只连桌面网关的 /mcp/<key>，不读取 mcp.json。",
        },
        { ...PI, note: "用户级与项目级 mcp.json 由 pi 自己读取并连接。" },
        {
          engine: "claude",
          state: "native",
          note: "Claude Code 读取它自己的用户/项目 MCP 配置，不经过这里。",
        },
        {
          engine: "codex",
          state: "native",
          note: "Codex 读取它自己的 MCP 配置，不经过这里。",
        },
      ];
  }
}

/** Descriptions for one MCP group, in engine order (Prophey, pi, Claude Code, Codex). */
export function mcpAvailability(group: McpGroupId): McpSupport[] {
  return support(group);
}

/** Engines an MCP group is actually used by, as a short label list. */
export function mcpUsageLabel(group: McpGroupId): string {
  const names: Record<EngineId, string> = {
    prophey: engineLabel('prophey'),
    pi: "pi",
    claude: "Claude",
    codex: "Codex",
  };
  const on = support(group)
    .filter((entry) => entry.state !== "unsupported")
    .map((entry) =>
      entry.state === "native"
        ? `${names[entry.engine]}（原生）`
        : names[entry.engine],
    );
  return on.length > 0 ? `适用：${on.join(" · ")}` : "不适用于任何引擎";
}
