import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionStore } from "../app/.server/extensions.ts";

const mock = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(mock, "listening");
const base = "http://127.0.0.1:5398";
const directory = await mkdtemp(join(tmpdir(), "permissions-integration-"));
const databasePath = join(directory, "extensions.sqlite");
const store = new ExtensionStore(databasePath);
const extensions = {
  // Los ids son UUID (misma tabla que la rama sesion-4-mcp); se busca por nombre.
  get: name => store.list().find(entry => entry.extension.server.name === name),
  key: name => extensions.get(name)?.configKey,
  get size() { return store.list().length; },
  delete: key => store.remove(key),
};
const sessions = new Map();
const decisions = [];
let sequence = 0;
let unsupported = false;
let failMutation = false;
const globalCalls = [];
let loadedServers;
let agentSocket;
const options = [
  { optionId: "allow", kind: "allow_once", name: "Allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
  { optionId: "always", kind: "allow_always", name: "Always" },
];

mock.on("connection", ws => {
  agentSocket = ws;
  const prompts = new Map();
  ws.on("message", raw => {
    for (const line of raw.toString().trim().split("\n")) {
      const message = JSON.parse(line);
      const { method, params = {} } = message;
      const send = payload => ws.send(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");
      const respond = result => send({ id: message.id, result });
      const fail = code => send({ id: message.id, error: { code, message: "fixture failure" } });
      if (!method) {
        decisions.push(message);
        const promptId = prompts.get(message.id);
        if (promptId !== undefined) {
          prompts.delete(message.id);
          send({ id: promptId, result: { stopReason: "end_turn" } });
        }
      } else if (method === "initialize") respond({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } }, agentInfo: { name: "goose", version: "fixture" } });
      else if (method === "session/list") respond({ sessions: [...sessions.keys()].map(sessionId => ({ sessionId, cwd: "/data/work" })) });
      else if (method === "session/new") {
        const sessionId = `session-${++sequence}`;
        sessions.set(sessionId, params.mcpServers.map(server => ({ configKey: server.name, extension: { type: "mcp", server }, enabled: true })));
        respond({ sessionId, configOptions: [] });
      } else if (method === "session/load") { loadedServers = params.mcpServers; respond({ configOptions: [] }); }
      else if (method === "session/prompt") {
        const id = `permission-${++sequence}`;
        prompts.set(id, message.id);
        send({ id, method: "session/request_permission", params: {
          sessionId: params.sessionId, options,
          toolCall: { toolCallId: "reused-tool", title: "Eliminar archivo de prueba", status: "pending", rawInput: { path: "/tmp/example" } },
        } });
      } else if (method === "session/cancel") {
        for (const promptId of prompts.values()) send({ id: promptId, result: { stopReason: "cancelled" } });
        prompts.clear();
      } else if (method === "_goose/unstable/session/extensions/list") {
        if (unsupported) { fail(-32601); continue; }
        respond({ extensions: (sessions.get(params.sessionId) ?? []).map(entry => entry.extension) });
      } else if (method === "_goose/unstable/session/extensions/add") {
        sessions.get(params.sessionId).push({ configKey: params.extension.server.name, extension: params.extension, enabled: true });
        respond({});
      } else if (method === "_goose/unstable/session/extensions/remove") {
        if (failMutation) { fail(-32603); continue; }
        // goose real: `remove` recibe `name`, y `list` devuelve cada extensión plana, sin clave.
        sessions.set(params.sessionId, sessions.get(params.sessionId).filter(entry => entry.extension.server.name !== params.name));
        respond({});
      } else if (method.startsWith("_goose/unstable/config/extensions/")) {
        globalCalls.push(method);
        fail(-32601);
      } else if (message.id !== undefined) respond({});
    }
  });
});

let log = "";
function startApp() {
const app = spawn(process.execPath, ["server.js"], { env: {
  ...process.env, PORT: "5398", ACP_WS_URL: `ws://127.0.0.1:${mock.address().port}`,
  ACP_TOKEN: "", ACP_SECRET: "", AGENT_BOX_ID: "", EASYBITS_API_KEY: "", NODE_ENV: "production",
  ACP_EXTENSIONS_DB: databasePath,
}, stdio: ["ignore", "pipe", "pipe"] });
app.stdout.on("data", chunk => log += chunk);
app.stderr.on("data", chunk => log += chunk);
return app;
}
let app = startApp();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn) {
  for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await delay(50); }
  throw new Error("Timed out waiting for fixture");
}
const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const changeExtension = async (values, headers = {}) => {
  const response = await fetch(`${base}/api/extensions`, { method: "POST", headers, body: new URLSearchParams(values) });
  const result = await response.clone().json();
  assert.deepEqual(result.extensions.map(entry => ({ key: entry.key, enabled: entry.enabled })), store.list().map(entry => ({ key: entry.configKey, enabled: entry.enabled })), "every mutation response includes the complete current list");
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  return response;
};
const pending = async id => (await (await fetch(`${base}/api/conversations/${id}/permissions`)).json()).permissions;
async function stream(id) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/conversations/${id}/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const events = [];
  const reading = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const type = block.match(/^event: (.+)$/m)?.[1];
        if (type) events.push({ type, ...JSON.parse(block.match(/^data: (.+)$/m)[1]) });
      }
    }
  })().catch(error => { if (!controller.signal.aborted) throw error; });
  await wait(() => events.some(event => event.type === "snapshot"));
  return { events, close: async () => { controller.abort(); await reading; } };
}

let firstStream;
let secondStream;
try {
  await wait(async () => { try { return (await fetch(base)).ok; } catch { return false; } });
  const config = { intent: "add", name: "example", transport: "http", description: "Fixture extension", url: "https://example.com/mcp", headers: "Authorization=Bearer fixture-secret" };
  const initialList = await fetch(`${base}/api/extensions`);
  assert.equal(initialList.headers.get("cache-control"), "no-store");
  assert.deepEqual((await initialList.json()).extensions, []);
  const unsupportedMethod = await fetch(`${base}/api/extensions`, { method: "DELETE" });
  assert.equal(unsupportedMethod.status, 405);
  assert.deepEqual((await unsupportedMethod.json()).extensions, []);
  assert.ok([400, 403].includes((await changeExtension(config, { origin: "https://evil.example" })).status));
  assert.equal(extensions.size, 0);
  assert.equal((await changeExtension({ ...config, url: "file:///etc/passwd" })).status, 400);
  assert.equal((await changeExtension(config)).status, 200);
  assert.equal(extensions.get("example").extension.server.headers[0].value, "Bearer fixture-secret");
  const key = extensions.key("example");
  assert.equal((await changeExtension(config)).status, 409);
  const page = await (await fetch(`${base}/extensions`)).text();
  assert.ok(page.includes("Fixture extension"));
  assert.ok(!page.includes("fixture-secret"));
  const { conversationId: id } = await (await post("/api/conversations", {})).json();
  assert.equal(sessions.get(id).length, 1);
  assert.equal((await changeExtension({ intent: "session-remove", sessionId: id, configKey: key })).status, 200);
  assert.equal(sessions.get(id).length, 0);
  assert.equal(extensions.size, 1, "removing from session preserves global configuration");
  assert.equal((await changeExtension({ intent: "session-add", sessionId: "wrong", configKey: key })).status, 409);
  assert.equal((await changeExtension({ intent: "session-add", sessionId: id, configKey: key })).status, 200);
  assert.equal(sessions.get(id).length, 1);
  assert.ok((await (await fetch(`${base}/extensions`)).text()).includes("Retirar de la conversación"));
  firstStream = await stream(id);
  assert.equal((await post(`/api/conversations/${id}/messages`, { text: "Use the extension" })).status, 200);
  const permission = await wait(async () => (await pending(id))[0]);
  assert.equal((await changeExtension({ intent: "session-remove", sessionId: id, configKey: key })).status, 409);
  await delay(120);
  assert.equal(decisions.length, 0, "no auto approval");
  assert.equal((await post(`/api/conversations/wrong/permissions`, { permissionId: permission.id, optionId: "allow" })).status, 404);
  assert.equal((await post(`/api/conversations/${id}/permissions`, { permissionId: permission.id, optionId: "invalid" })).status, 400);
  assert.equal((await post(`/api/conversations/${id}/permissions`, { permissionId: permission.id, optionId: "allow" }, { origin: "https://evil.example" })).status, 403);
  secondStream = await stream(id);
  assert.equal(secondStream.events[0].permissions[0].id, permission.id, "reconnect includes pending permissions");
  assert.equal(secondStream.events[0].busy, true);
  const results = await Promise.all(["reject", "allow"].map(optionId => post(`/api/conversations/${id}/permissions`, { permissionId: permission.id, optionId })));
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  await wait(() => decisions.length === 1);
  assert.equal(decisions[0].result.outcome.outcome, "selected");
  await wait(() => firstStream.events.some(event => event.type === "permissions" && !event.permissions.length));
  await wait(() => secondStream.events.some(event => event.type === "permissions" && !event.permissions.length));
  await wait(() => firstStream.events.some(event => event.type === "busy" && !event.busy));

  await post(`/api/conversations/${id}/messages`, { text: "Another operation" });
  const cancelled = await wait(async () => (await pending(id))[0]);
  assert.notEqual(cancelled.id, permission.id);
  await post(`/api/conversations/${id}/cancel`, {});
  await wait(() => decisions.length === 2);
  assert.deepEqual(decisions[1].result, { outcome: { outcome: "cancelled" } });
  assert.equal((await post(`/api/conversations/${id}/permissions`, { permissionId: cancelled.id, optionId: "allow" })).status, 409);
  await delay(100);
  if (process.env.PERMISSION_TEST_BROWSER) {
    const { checkBrowser } = await import("./permissions.browser.mjs");
    await checkBrowser(base, id, process.env.PERMISSION_TEST_BROWSER);
    assert.equal(decisions.at(-1).result.outcome.optionId, "reject");
    extensions.delete("browsermcp");
  }
  await post(`/api/conversations/${id}/messages`, { text: "Disconnect" });
  await wait(async () => (await pending(id)).length);
  agentSocket.close();
  await wait(() => firstStream.events.some(event => event.type === "closed"));
  assert.equal((await post(`/api/conversations/${id}/permissions`, { permissionId: cancelled.id, optionId: "allow" })).status, 404);

  assert.equal((await changeExtension({ intent: "set-enabled", configKey: key, enabled: "false" })).status, 200);
  assert.equal(extensions.get("example").enabled, false);
  assert.equal((await fetch(`${base}/c/${id}`)).status, 200);
  assert.deepEqual(loadedServers, [], "disabled declarations are not sent when loading a conversation");
  assert.equal((await changeExtension({ intent: "set-enabled", configKey: key, enabled: "true" })).status, 200);
  assert.equal(extensions.get("example").enabled, true);
  assert.equal((await changeExtension({ intent: "set-enabled", configKey: key, enabled: "nonsense" })).status, 400);
  failMutation = true;
  assert.equal((await changeExtension({ intent: "session-remove", sessionId: id, configKey: key })).status, 502);
  assert.equal(extensions.size, 1);
  failMutation = false;
  const exited = once(app, "exit"); app.kill(); await exited;
  app = startApp();
  await wait(async () => { try { return (await fetch(base)).ok; } catch { return false; } });
  assert.ok((await (await fetch(`${base}/extensions`)).text()).includes("Fixture extension"), "SQLite survives app restart");
  assert.equal((await fetch(`${base}/c/${id}`)).status, 200);
  assert.equal(loadedServers[0].name, "example");
  assert.equal(loadedServers[0].headers[0].value, "Bearer fixture-secret");
  assert.equal((await changeExtension({ intent: "remove", configKey: key })).status, 200);
  assert.equal(extensions.size, 0);
  unsupported = true;
  const unsupportedPage = await (await fetch(`${base}/extensions`)).text();
  assert.ok(unsupportedPage.includes("El agente no permite gestionar extensiones de esta conversación"));
  assert.ok(unsupportedPage.includes("Conectar servidor MCP"), "local configuration remains available without agent extensions support");
  assert.deepEqual(globalCalls, [], "client extensions never mutate or depend on global agent configuration");
  console.log("Permissions and extensions integration passed: decisions, races, SSE reconnect, cancellation, disconnect, CRUD and validation.");
} catch (error) {
  console.error(log);
  throw error;
} finally {
  await firstStream?.close(); await secondStream?.close();
  const exited = once(app, "exit"); app.kill(); await exited;
  for (const client of mock.clients) client.terminate();
  await new Promise(resolve => mock.close(resolve));
  store.close();
  await rm(directory, { recursive: true, force: true });
}
