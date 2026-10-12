import assert from "node:assert/strict";
import { test } from "node:test";
import { fileLabel, formatSize, parseFileBlock, splitFiles } from "../app/lib/files.ts";

const pdf = { url: "https://ns.compat.objectstorage.mx-queretaro-1.oraclecloud.com/acp-agent-files/t3/deck-abc.pdf?X-Amz-Signature=1", name: "deck.pdf", mime: "application/pdf", size: 5847, thumb: "https://example.com/t.png" };
const block = (meta) => "```eb-file\n" + JSON.stringify(meta) + "\n```";

test("eb-file blocks become file parts between the text", () => {
  const pptx = { url: "https://example.com/deck.pptx", name: "deck.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 30000 };
  const parts = splitFiles(`Here it is:\n\n${block(pdf)}\n${block(pptx)}\n\nAnything else?`);
  assert.deepEqual(parts.map((p) => p.kind), ["text", "file", "file", "text"]);
  assert.deepEqual(parts[1].file, pdf);
  assert.equal(parts[2].file.name, "deck.pptx");
  assert.equal(parts[3].text.trim(), "Anything else?");
});

test("text without blocks, other code fences and broken blocks stay as text", () => {
  assert.deepEqual(splitFiles("hello"), [{ kind: "text", text: "hello" }]);
  assert.deepEqual(splitFiles(""), []);
  for (const text of [
    "```json\n" + JSON.stringify(pdf) + "\n```",
    "```eb-file\n{not json}\n```",
    block({ ...pdf, url: "javascript:alert(1)" }),
    block({ ...pdf, url: "http://example.com/a.pdf" }),
    block({ ...pdf, url: "/relative.pdf" }),
    block(["https://example.com/a.pdf"]),
  ]) {
    assert.deepEqual(splitFiles(text), [{ kind: "text", text }], text);
  }
});

test("missing or bad fields fall back instead of breaking the card", () => {
  const file = parseFileBlock(JSON.stringify({ url: "https://example.com/dir/my%20file.pdf", size: -1, thumb: "data:image/png;base64,x" }));
  assert.deepEqual(file, { url: "https://example.com/dir/my%20file.pdf", name: "my file.pdf", mime: "application/octet-stream", size: undefined, thumb: undefined });
  assert.equal(parseFileBlock(JSON.stringify({ url: "https://example.com/%E0%A4" })).name, "%E0%A4");
  assert.equal(parseFileBlock(JSON.stringify({ url: "https://example.com/" })).name, "file");
});

test("while streaming, an unclosed block is held back and a closed one shows", () => {
  const text = `Listo:\n\n${block(pdf)}`;
  for (let i = text.indexOf("```eb-file"); i < text.length; i++) {
    const parts = splitFiles(text.slice(0, i), true);
    assert.ok(parts.every((p) => p.kind === "text" && !p.text.includes("eb-file")), String(i));
  }
  assert.equal(splitFiles(text, true).at(-1).kind, "file");
  // A finished answer never hides text.
  assert.equal(splitFiles("Listo:\n```eb-file\n{", false).at(-1).text, "Listo:\n```eb-file\n{");
});

test("labels and sizes", () => {
  assert.equal(fileLabel({ name: "deck.pptx", mime: "" }), "PPTX");
  assert.equal(fileLabel({ name: "report", mime: "application/pdf" }), "PDF");
  assert.equal(fileLabel({ name: "data", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "FILE");
  assert.equal(formatSize(512, "en"), "512 B");
  assert.equal(formatSize(5847, "en"), "5.7 KB");
  assert.equal(formatSize(30 * 1024 * 1024, "en"), "30 MB");
});
