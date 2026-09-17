import { client } from '@agentclientprotocol/sdk';
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
import { WebSocket } from 'ws';
const url = new URL(process.env.ACP_WS_URL);
const token = process.env.ACP_TOKEN ?? process.env.ACP_SECRET;
if (token && !url.searchParams.has('token')) url.searchParams.set('token', token);
let updates = [];
const app = client().onNotification('session/update', ({ params }) => updates.push(params.update));
const conn = app.connect(createWebSocketStream(url.toString(), { WebSocket, headers: token ? { Authorization: `Bearer ${token}` } : undefined }));
const timer = setTimeout(() => conn.close(), 150_000);
let id;
try {
 await conn.agent.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
 const created = await conn.agent.request('session/new', { cwd: process.env.ACP_CWD ?? '/data/work', mcpServers: [], _meta: { client_title: 'Partial replay verification' } });
 id = created.sessionId;
 for (const word of ['ONE', 'TWO', 'THREE']) await conn.agent.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: `Memory replay test. Do not use tools. Reply only with the word ${word}.` }] });
 await conn.agent.request('session/close', { sessionId: id });
 updates = [];
 await conn.agent.request('session/load', { sessionId: id, cwd: process.env.ACP_CWD ?? '/data/work', mcpServers: [] });
 const full = updates.filter(update => update.sessionUpdate === 'user_message_chunk').length;
 await conn.agent.request('session/close', { sessionId: id });
 updates = [];
 await conn.agent.request('session/load', { sessionId: id, cwd: process.env.ACP_CWD ?? '/data/work', mcpServers: [], _meta: { replayTail: 1 } });
 const tail = updates.filter(update => update.sessionUpdate === 'user_message_chunk').length;
 console.log(JSON.stringify({ sessionId: id, fullUserMessages: full, tailUserMessages: tail, tailUpdateTypes: updates.map(update => update.sessionUpdate) }));
 if (!(full > tail && tail > 0)) throw new Error('The agent did not return a shorter replay at a user turn boundary');
} finally {
 if (id) await conn.agent.request('session/close', { sessionId: id }).catch(() => {});
 clearTimeout(timer); conn.close();
}
