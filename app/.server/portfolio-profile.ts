// Cached public profile for the agent, from the portfolio's MCP API.
const MCP_URL =
  process.env.PORTFOLIO_MCP_URL ?? 'https://ismaelfrancisco.tech/mcp';
const TTL = 10 * 60_000;

let cache: { at: number; text: string } | null = null;

export async function portfolioProfile(): Promise<string | null> {
  if (cache && Date.now() - cache.at < TTL) return cache.text;
  try {
    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_website_info', arguments: {} },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json();
    const text = body?.result?.content?.find(
      (c: { type: string }) => c.type === 'text',
    )?.text;
    if (!response.ok || body.result.isError || typeof text !== 'string')
      throw new Error(`HTTP ${response.status}`);
    // The tool returns indented JSON: compact it, it goes into the agent's context.
    cache = { at: Date.now(), text: JSON.stringify(JSON.parse(text)) };
    return cache.text;
  } catch (error) {
    console.warn(
      `[portfolio] could not read ${MCP_URL}: ${(error as Error).message}`,
    );
    return cache?.text ?? null;
  }
}
