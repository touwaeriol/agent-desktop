/**
 * Registers the Agent Desktop `ask_user_question` MCP server for the current pi session.
 *
 * Loaded with `--extension <this file>` by the desktop app only. The bridge URL, token and
 * MCP server script come from the environment the desktop passes to the pi child process,
 * so nothing is written to `~/.pi/agent/mcp.json` and terminal pi sessions stay untouched.
 */
export default function desktopMcp(pi) {
  const url = process.env.AGENT_DESKTOP_MCP_URL
  const script = process.env.AGENT_DESKTOP_MCP_SCRIPT
  if (!url || !script) return

  pi.registerMcpServer('desktop', {
    command: process.execPath,
    args: [script],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_DESKTOP_MCP_URL: url,
      AGENT_DESKTOP_MCP_TOKEN: process.env.AGENT_DESKTOP_MCP_TOKEN ?? ''
    },
    exposure: 'direct',
    // No timeout: pi skips arming its request timer when timeoutMs is not finite
    // (see McpClient.armTimeout), so waiting for the user never expires.
    timeout: Number.POSITIVE_INFINITY,
    description:
      'Ask the user a question in the Agent Desktop window and wait for the answer ' +
      '(single choice, multi-select, or free-form input).'
  })
}
