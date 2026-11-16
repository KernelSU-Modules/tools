/** Suggested client-side name of the MCP server. */
export const MCP_SERVER_NAME = 'kernelsu-portal';

/** `claude mcp add` for the Streamable HTTP endpoint; Claude Code runs the OAuth flow (browser → Portal) itself. */
export function claudeCommand(url: string): string {
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${url}`;
}

/** Generic `mcpServers` JSON (Claude Code .mcp.json, Cursor, …): no credentials, the client authorizes via OAuth. */
export function jsonConfig(url: string): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url } } }, null, 2);
}
