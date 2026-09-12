import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionQueue } from "../app/.server/permissions.ts";
import { ExtensionStore, parseExtension, summarizeExtensions } from "../app/.server/extensions.ts";
import { assertSameOrigin } from "../app/.server/request-validation.ts";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const options = [
  { optionId: "yes", name: "Allow", kind: "allow_once" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
];

test("permission waits, validates the option and only accepts one decision", async () => {
  const events = [];
  const queue = new PermissionQueue(value => events.push(value));
  let settled = false;
  const pending = queue.request({ toolCallId: "tool", title: "Delete file" }, options).then(result => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false);
  const [{ id }] = queue.snapshot();
  assert.equal(queue.decide(id, "invented"), "invalid");
  assert.equal(queue.decide("another-session", "yes"), "missing");
  assert.equal(queue.decide(id, "no"), "ok");
  assert.equal(queue.decide(id, "yes"), "missing");
  assert.deepEqual(await pending, { outcome: { outcome: "selected", optionId: "no" } });
  assert.deepEqual(events.at(-1), []);
});

test("cancel settles every outstanding request without approval, including reused tool ids", async () => {
  const queue = new PermissionQueue(() => {});
  const first = queue.request({ toolCallId: "same" }, options);
  const second = queue.request({ toolCallId: "same" }, options);
  const ids = queue.snapshot().map(p => p.id);
  assert.notEqual(ids[0], ids[1]);
  queue.cancel();
  for (const response of await Promise.all([first, second])) assert.deepEqual(response, { outcome: { outcome: "cancelled" } });
  assert.equal(queue.decide(ids[0], "yes"), "missing");
  assert.deepEqual(await queue.request({ toolCallId: "none" }, []), { outcome: { outcome: "cancelled" } });
});

test("permanent permissions are forwarded only when explicitly selected", async () => {
  const queue = new PermissionQueue(() => {});
  const pending = queue.request({ toolCallId: "tool" }, options);
  queue.decide(queue.snapshot()[0].id, "always");
  assert.deepEqual(await pending, { outcome: { outcome: "selected", optionId: "always" } });
});

const form = values => { const result = new FormData(); for (const [key, value] of Object.entries(values)) result.set(key, value); return result; };
const http = { name: "example", description: "", transport: "http", url: "https://example.com/mcp", headers: "Authorization=Bearer test=value" };

test("extension config preserves credentials on submission but never in list summaries", () => {
  for (const name of ["Servidor", "Mi servidor", "Documentación (equipo)", "123", "📚 Documentación", "---", "../config"]) {
    assert.equal(parseExtension(form({ ...http, name })).server.name, name);
  }
  const extension = parseExtension(form(http));
  assert.deepEqual(extension.server.headers, [{ name: "Authorization", value: "Bearer test=value" }]);
  const summaries = summarizeExtensions({ extensions: [{ configKey: "example", enabled: true, extension }] });
  assert.deepEqual(summaries, [{ key: "example", name: "example", type: "http", enabled: true, description: "" }]);
  assert.ok(!JSON.stringify(summaries).includes("Bearer"));
  const stdio = parseExtension(form({ name: "local", description: "", transport: "stdio", command: "/usr/local/bin/npx", args: "-y\nserver\na b", env: "API_KEY=a=b" }));
  assert.deepEqual(stdio.server.args, ["-y", "server", "a b"]);
  assert.deepEqual(stdio.server.env, [{ name: "API_KEY", value: "a=b" }]);
  const spaces = parseExtension(form({ name: "local", description: "", transport: "stdio", command: "/opt/tool", args: "  argument  ", env: "VALUE=  secret  " }));
  assert.deepEqual(spaces.server.args, ["  argument  "]);
  assert.equal(spaces.server.env[0].value, "  secret  ");
});

test("extension input rejects unsupported transports, unsafe URLs and malformed headers", () => {
  for (const override of [
    { transport: "sse" }, { url: "file:///etc/passwd" }, { url: "https://user:pass@example.com" },
    { headers: "Bad Header=value" }, { headers: "No separator" },
    { headers: "Authorization=one\nauthorization=two" }, { name: "" }, { name: "   " },
  ]) assert.throws(() => parseExtension(form({ ...http, ...override })));
  assert.throws(() => parseExtension(form({ name: "local", description: "", transport: "stdio", command: "npx", args: "", env: "" })), /ruta absoluta/);
});

test("new mutation endpoints reject cross-origin requests", () => {
  for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
    assert.throws(() => assertSameOrigin(new Request("https://app.example/extensions", { headers })), error => error.status === 403);
  }
  assert.doesNotThrow(() => assertSameOrigin(new Request("https://app.example/extensions", { headers: { origin: "https://app.example" } })));
});

test("SQLite persists individual extension changes across connections and reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "extension-store-"));
  const path = join(directory, "extensions.sqlite");
  let store;
  let second;
  try {
    store = new ExtensionStore(path);
    const first = store.add(parseExtension(form(http)));
    const other = store.add(parseExtension(form({ ...http, name: "other" })));
    assert.throws(() => store.add(parseExtension(form(http))), error => error.status === 409);
    second = new ExtensionStore(path);
    assert.equal(second.servers().length, 2);
    assert.equal(store.setEnabled(first, false), true);
    assert.deepEqual(second.servers().map(server => server.name), ["other"]);
    assert.equal(store.remove("missing"), false);
    assert.equal(store.setEnabled("missing", true), false);
    assert.equal(store.remove("' OR 1=1 --"), false);
    assert.equal(store.remove(other), true);
    store.close();
    store = new ExtensionStore(path);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].enabled, false);
    assert.equal(store.get(first).server.headers[0].value, "Bearer test=value");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    store.setEnabled(first, true);
    assert.equal(second.servers().length, 1);
    assert.equal(store.remove(first), true);
    assert.deepEqual(second.list(), []);
  } finally { store?.close(); second?.close(); rmSync(directory, { recursive: true, force: true }); }
});
