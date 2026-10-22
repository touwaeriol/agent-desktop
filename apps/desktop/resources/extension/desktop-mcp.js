/**
 * Registers the Agent Desktop built-in MCP servers for the current pi session.
 *
 * Loaded with `--extension <this file>` by the desktop app only. Everything comes from the
 * environment the desktop passes to the pi child process, so nothing is written to
 * `~/.pi/agent/mcp.json` and terminal pi sessions stay untouched:
 *
 * - `AGENT_DESKTOP_MCP_URL` / `AGENT_DESKTOP_MCP_TOKEN` — loopback bridge of the window
 * - `AGENT_DESKTOP_MCP_CORE_SCRIPT` — core interaction server (`packages/mcp-core/server.mjs`)
 * - `AGENT_DESKTOP_MCP_ENGINES` — JSON array of CodeGraph / LSP server specs
 * - `AGENT_DESKTOP_MCP_TOGGLES` — `{ server: { tool: false } }`, tools the user turned off
 */

const CORE_SERVER = 'desktop'
const ASK_TOOL = 'mcp__desktop__ask_user_question'
const START_SUBAGENT_TOOL = 'mcp__desktop__start_subagent'
const WEB_SEARCH_TOOL = 'mcp__web__web_search'
const WEB_FETCH_TOOL = 'mcp__web__web_fetch'
const PROMPT_SECTION = 'desktop_tools'
const AGENTS_SECTION = 'subagents'
const WEB_SECTION = 'web_tools'
const BATCH_SECTION = 'batching'

/**
 * Every run gets this one. pi asks the model once per assistant turn, so "one tool call, one thought"
 * turns a simple job into a dozen round trips; the section pushes back toward a plan followed by a
 * batch of independent calls, and toward carrying that plan forward instead of re-deriving it.
 */
const BATCH_GUIDANCE = [
  'Work in batches. Once a step is clear, issue every independent tool call it needs in the same turn:',
  'parallel reads, searches, status checks and edits that do not depend on each other belong together.',
  'One round trip for several calls beats one round trip per call.',
  '',
  'Do not re-plan between mechanical steps. When a result is what you expected, continue the plan you',
  'already have instead of restating it: repeated reasoning between calls is the most expensive way to',
  'make no progress. Keep one running plan for the task and amend it in place.',
  '',
  'Think again only when a result contradicts the plan, a real decision appears, or the next step is',
  'irreversible — and then say what changed, so the next batch starts from it.'
].join('\n')

/**
 * Guidance for the model. An MCP server cannot supply a system prompt: pi only uses a server's
 * `instructions` for codemode namespaces and the `mcp_servers` section, and neither applies to a
 * server exposed as `direct`. So the extension injects the section instead, and only while the
 * tool is actually declared to the model (see below).
 */
const GUIDANCE = [
  '`mcp__desktop__ask_user_question` shows questions in the Agent Desktop window and waits for the user.',
  'It never times out, so the user can answer whenever they like.',
  '',
  'Use it when the answer changes what you build: ambiguous requirements, a real tradeoff between',
  'approaches, information you cannot derive from the repository, or a preference only the user knows.',
  'Ask before doing expensive or hard-to-reverse work that depends on that answer.',
  '',
  'Do not use it for decisions you can settle by reading the code or following existing conventions,',
  'to confirm an obvious next step, or to ask permission for individual tool calls.',
  '',
  'Offer 2-4 concrete options with a short description each, and set `multiSelect` when several choices',
  'can apply. The user can always type their own answer, so keep options representative rather than',
  'exhaustive. Questions are shown one at a time: ask everything you need in one call instead of several.',
  'If the result says the user cancelled, do not invent an answer; ask how to proceed.'
].join('\n')

/**
 * Guidance for the web gateway. Same reason as above: a `direct` MCP server cannot bring a system
 * prompt, so the extension injects one — only while the tools are actually declared.
 */
const WEB_GUIDANCE = [
  '`mcp__web__web_search` returns titles, URLs and snippets; `mcp__web__web_fetch` downloads one',
  'page and converts it to Markdown. Both run on the user\'s configured backend; you never pick one.',
  '',
  'Search when the answer depends on something newer than your weights or outside this repository:',
  'library releases and changelogs, API docs, error messages, version-specific behavior, comparisons.',
  'Do not search for things the repository already answers.',
  '',
  'A snippet is not a source: after searching, fetch the one or two most promising URLs and answer',
  'from their content. Give the URL for every claim you took from the web, and say plainly when the',
  'pages do not support an answer instead of filling the gap from memory.',
  '',
  'Local and private addresses are refused by design; use the repository tools or bash for those.'
].join('\n')

function parseJson(value, fallback) {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/** Tools the user disabled in Settings, hidden from the model. */
function hiddenTools(toggles, server) {
  const tools = toggles[server]
  if (!tools || typeof tools !== 'object') return {}
  return Object.fromEntries(
    Object.entries(tools)
      .filter(([, enabled]) => enabled === false)
      .map(([tool]) => [tool, 'hidden'])
  )
}

export default function desktopMcp(pi) {  const url = process.env.AGENT_DESKTOP_MCP_URL
  const token = process.env.AGENT_DESKTOP_MCP_TOKEN ?? ''
  const coreScript = process.env.AGENT_DESKTOP_MCP_CORE_SCRIPT
  const engines = parseJson(process.env.AGENT_DESKTOP_MCP_ENGINES, [])
  const toggles = parseJson(process.env.AGENT_DESKTOP_MCP_TOGGLES, {})
  const subagentsEnabled = process.env.AGENT_DESKTOP_SUBAGENTS === '1'
  const agentsSection = process.env.AGENT_DESKTOP_AGENTS_SECTION ?? ''
  if (!url) return

  if (coreScript) {
    pi.registerMcpServer(CORE_SERVER, {
      command: process.execPath,
      args: [coreScript],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        AGENT_DESKTOP_MCP_URL: url,
        AGENT_DESKTOP_MCP_TOKEN: token,
        AGENT_DESKTOP_SUBAGENTS: subagentsEnabled ? '1' : '0'
      },
      exposure: 'direct',
      // No timeout: pi skips arming its request timer when timeoutMs is not finite
      // (see McpClient.armTimeout), so waiting for the user never expires.
      timeout: Number.POSITIVE_INFINITY,
      toolExposure: hiddenTools(toggles, CORE_SERVER),
      description:
        'Desktop interaction tools for the Agent Desktop window (ask_user_question: ' +
        'single choice, multi-select, or free-form input).'
    })
  }

  for (const spec of Array.isArray(engines) ? engines : []) {
    if (!spec || typeof spec.name !== 'string') continue
    const shared = {
      exposure: spec.exposure === 'direct' ? 'direct' : 'deferred',
      timeout: typeof spec.timeout === 'number' && spec.timeout > 0 ? spec.timeout : 120,
      toolExposure: { ...(spec.toolExposure ?? {}), ...hiddenTools(toggles, spec.name) },
      description: typeof spec.description === 'string' ? spec.description : undefined
    }
    if (typeof spec.url === 'string' && spec.url) {
      // Gateway endpoint on the loopback bridge: the app forwards to the real engine and controls
      // which tools exist at all.
      pi.registerMcpServer(spec.name, {
        ...shared,
        url: spec.url,
        headers: spec.headers && typeof spec.headers === 'object' ? spec.headers : {}
      })
    } else if (typeof spec.command === 'string' && spec.command) {
      // Direct stdio server, used when no gateway is configured.
      pi.registerMcpServer(spec.name, {
        ...shared,
        command: spec.command,
        args: Array.isArray(spec.args) ? spec.args : [],
        env: spec.env && typeof spec.env === 'object' ? spec.env : {}
      })
    }
  }

  let reported = ''

  /** Tell the window which tools each built-in server offers, for the per-tool switches. */
  const reportTools = () => {
    let tools
    try {
      tools = pi.getAllTools()
    } catch {
      // `new_session`, `clone`, `switch_session` and `reload` invalidate this captured ctx. A timer
      // callback that throws here kills the whole pi process, so bail out instead: the next run
      // reports again from `before_agent_start`.
      return
    }
    const servers = {}
    for (const tool of tools) {
      const match = /^mcp__(.+?)__(.+)$/.exec(tool.name)
      if (!match) continue
      const [, server, name] = match
      if (!servers[server]) servers[server] = []
      servers[server].push({ name, exposure: tool.exposure })
    }
    const payload = JSON.stringify({ servers })
    if (payload === reported) return
    reported = payload
    void fetch(`${url}/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-desktop-token': token },
      body: payload
    }).catch(() => {
      reported = ''
    })
  }

  // Servers connect asynchronously, so the first report may see only part of the tool list. Report
  // again shortly after load; `reportTools` skips identical payloads.
  setTimeout(reportTools, 2500)
  setTimeout(reportTools, 8000)

  if (subagentsEnabled) void pumpEvents(pi, url, token)

  pi.on('before_agent_start', (event) => {
    // Only while the desktop MCP server is connected and its tool is declared to the model, so a
    // disabled MCP, a disabled desktop tool, a hidden tool, or a failed server leaves the prompt
    // untouched. The section is recomputed every run, and pi's section diff drops it when unset.
    const { sections } = event.systemPromptOptions
    const active = pi.getActiveTools()
    if (active.includes(ASK_TOOL)) sections[PROMPT_SECTION] = GUIDANCE
    else delete sections[PROMPT_SECTION]

    // The preset list comes from the app (agents.exposure: prompt) and is only injected while the
    // subagent tool is really declared, so a disabled feature leaves no dangling section.
    if (agentsSection && active.includes(START_SUBAGENT_TOOL)) sections[AGENTS_SECTION] = agentsSection
    else delete sections[AGENTS_SECTION]

    // Same rule for the web gateway: no search tool declared, no guidance.
    if (active.includes(WEB_SEARCH_TOOL) || active.includes(WEB_FETCH_TOOL)) {
      sections[WEB_SECTION] = WEB_GUIDANCE
    } else delete sections[WEB_SECTION]

    // Unconditional: batching is about how the run uses whatever tools it has.
    sections[BATCH_SECTION] = BATCH_GUIDANCE

    reportTools()
  })
}

/**
 * Collect subagent notices from the app and hand them to the model.
 *
 * A tool call cannot be resumed after it returned, so a finished background subagent has no way
 * back into the conversation. The app therefore queues a notice and this loop delivers it as a
 * custom message: it stays a `custom` entry in the session (not something the user said), and
 * `triggerTurn` decides whether the parent starts a turn now or reads it on its next one.
 */
async function pumpEvents(pi, url, token) {
  let backoff = 2000
  while (true) {
    try {
      const response = await fetch(`${url}/events?wait=25000`, {
        headers: { 'x-agent-desktop-token': token }
      })
      if (!response.ok) throw new Error(`events ${response.status}`)
      const payload = await response.json()
      backoff = 2000
      for (const event of payload.events ?? []) deliverNotice(pi, event)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, backoff))
      backoff = Math.min(backoff * 2, 30000)
    }
  }
}

function deliverNotice(pi, event) {
  if (!event || event.type !== 'subagent_settled' || typeof event.text !== 'string') return
  const text = [
    '<system-reminder source="agent-desktop">',
    'A subagent you started has finished a turn. This is not a message from the user.',
    event.text,
    '</system-reminder>'
  ].join('\n')
  try {
    pi.sendMessage(
      {
        customType: 'subagent_notice',
        display: true,
        content: [{ type: 'text', text }]
      },
      event.wake ? { triggerTurn: true } : {}
    )
  } catch {
    // pi is shutting down or the session is between runs; the notice stays in the app's queue.
  }
}
