import assert from "node:assert/strict";
import { test } from "node:test";
import { TitleStore, isGenericTitle, titleFromPrompt } from "../app/.server/titles.ts";

test("generic titles are detected regardless of case or language", () => {
  for (const t of ["New Chat", "new chat ", "Nueva conversación", "", undefined, null]) assert.ok(isGenericTitle(t), String(t));
  assert.ok(!isGenericTitle("Arregla el login"));
});

test("title comes from the first meaningful line, without markdown, capped at a word boundary", () => {
  assert.equal(titleFromPrompt("Arregla el login"), "Arregla el login");
  assert.equal(titleFromPrompt("\n\n# **Plan** de _migración_\nmás texto"), "Plan de migración");
  assert.equal(titleFromPrompt("```js\nconsole.log(1)\n```\nExplica este código"), "Explica este código");
  assert.equal(titleFromPrompt("- primer punto\n- segundo"), "primer punto");
  const long = titleFromPrompt("Necesito que revises la configuración de producción del servidor, porque falla al desplegar");
  assert.ok(long.length <= 61 && long.endsWith("…") && !long.includes(",…"), long);
  assert.equal(titleFromPrompt("   "), "");
});

test("store keeps one title per session and overwrites", () => {
  const store = new TitleStore(":memory:");
  assert.equal(store.get("a"), undefined);
  store.set("a", "uno"); store.set("a", "dos"); store.set("b", "tres");
  assert.equal(store.get("a"), "dos");
  assert.equal(store.get("b"), "tres");
  store.close();
});
