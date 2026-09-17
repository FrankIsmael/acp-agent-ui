import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

export async function checkBrowser(base, id, browserPath) {
  const profile = await mkdtemp(join(tmpdir(), "permissions-browser-"));
  const browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--remote-debugging-port=5399", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  let socket;
  const wait = async fn => {
    for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error("Browser expectation timed out");
  };
  try {
    await wait(async () => (await fetch("http://127.0.0.1:5399/json/version")).ok);
    const page = await (await fetch("http://127.0.0.1:5399/json/new?about:blank", { method: "PUT" })).json();
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
    let sequence = 0;
    const pending = new Map();
    const errors = [];
    const requests = [];
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id) { const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry.reject(message.error) : entry.resolve(message.result); }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
      if (message.method === "Network.requestWillBeSent") requests.push(message.params.request);
    });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await cdp("Runtime.enable"); await cdp("Page.enable"); await cdp("Network.enable");
    await cdp("Page.navigate", { url: `${base}/extensions` });
    await wait(() => evaluate("Object.keys(document.querySelector('select[name=transport]') ?? {}).some(key=>key.startsWith('__reactProps'))"));
    requests.length = 0;
    await evaluate("document.querySelector('select[name=transport]').value='stdio';document.querySelector('select[name=transport]').dispatchEvent(new Event('change',{bubbles:true}))");
    await wait(() => evaluate("!!document.querySelector('input[name=command]')"));
    await evaluate(`(() => {
      const fill=(selector,value)=>{const el=document.querySelector(selector);const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
      fill('input[name=name]','browser-mcp');fill('input[name=command]','npx');fill('textarea[name=args]','-y\\nfixture-mcp');fill('textarea[name=env]','API_KEY=browser-secret');
      document.querySelector('button[type=submit]').click();
    })()`);
    await wait(() => evaluate("document.body.innerText.includes('Extensión guardada.')"));
    assert.equal(await evaluate("document.querySelector('textarea[name=env]').value"), "");
    await evaluate("[...document.querySelectorAll('li')].find(el=>el.innerText.includes('browser-mcp')).querySelector('button[value=session-add]').click()");
    await wait(() => evaluate("[...document.querySelectorAll('li')].some(el=>el.innerText.includes('browser-mcp')&&el.innerText.includes('Retirar de la conversación'))"));
    assert.equal(requests.filter(request => new URL(request.url).pathname === "/api/extensions" && request.method === "POST").length, 2);
    assert.equal(requests.filter(request => request.method === "GET" && (new URL(request.url).pathname === "/api/extensions" || new URL(request.url).pathname.endsWith(".data"))).length, 0, "mutation responses render without loader revalidation or a second fetch");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
    await cdp("Page.navigate", { url: `${base}/c/${id}` });
    await wait(() => evaluate("document.querySelector('textarea')?.placeholder === 'Sigue la conversación…'"));
    await fetch(`${base}/api/conversations/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Browser permission" }) });
    await wait(() => evaluate("!!document.querySelector('section[aria-label=\"Permiso pendiente\"]')"));
    await cdp("Page.reload");
    await wait(() => evaluate("[...document.querySelectorAll('button')].some(el=>el.textContent==='Rechazar una vez'&&!el.disabled)"));
    await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent==='Rechazar una vez').click()");
    await wait(() => evaluate("!document.querySelector('section[aria-label=\"Permiso pendiente\"]')"));
    assert.deepEqual(errors, []);
    console.log("Browser passed: stdio form, secret clearing, live connection, mobile layout, permission reload and rejection.");
  } finally {
    socket?.close();
    const exited = once(browser, "exit"); browser.kill(); await exited;
    await rm(profile, { recursive: true, force: true });
  }
}
