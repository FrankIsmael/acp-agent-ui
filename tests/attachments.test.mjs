import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentsBlock, invalidFileName, invalidFiles, MAX_FILES, takeAttachments } from "../app/lib/attachments.ts";

const files = [
  { name: "report.pdf", mimeType: "application/pdf", size: 120345, path: "adjuntos/report.pdf" },
  { name: "Budget (final), v2.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 9, path: "adjuntos/Budget (final), v2-1.xlsx" },
];

test("the block names each path and survives a replay round trip", () => {
  const block = attachmentsBlock(files);
  assert.ok(block.startsWith("[attachments]\n") && block.endsWith("\n[/attachments]"));
  assert.match(block, /^- adjuntos\/report\.pdf \(application\/pdf, 120345 bytes\)$/m);
  const { text, files: parsed } = takeAttachments(block);
  assert.equal(text, "");
  assert.deepEqual(parsed, [
    { name: "report.pdf", mimeType: "application/pdf", size: 120345, path: "adjuntos/report.pdf" },
    { name: "Budget (final), v2-1.xlsx", mimeType: files[1].mimeType, size: 9, path: "adjuntos/Budget (final), v2-1.xlsx" },
  ]);
});

test("replayed text keeps what the user wrote around the block", () => {
  const { text, files: parsed } = takeAttachments(`Summarize this\n${attachmentsBlock(files.slice(0, 1))}`);
  assert.equal(text, "Summarize this");
  assert.equal(parsed.length, 1);
  for (const plain of ["hello", "[attachments] without an end", ""]) {
    assert.deepEqual(takeAttachments(plain), { text: plain, files: [] });
  }
});

test("an old block with a join line (box uploads in pieces) still replays as one chip", () => {
  const block = [
    "[attachments]",
    "The user attached these files. They are saved in your working directory; open them from there:",
    "- adjuntos/Book.pdf (application/pdf, 25000000 bytes) GRANDE",
    "  It arrived in 3 pieces. Before anything else, join them with exactly: cat 'adjuntos/Book.pdf.part2' 'adjuntos/Book.pdf.part3' >> 'adjuntos/Book.pdf' && rm 'adjuntos/Book.pdf.part2' 'adjuntos/Book.pdf.part3'",
    "[/attachments]",
  ].join("\n");
  assert.deepEqual(takeAttachments(block), {
    text: "",
    files: [{ name: "Book.pdf", mimeType: "application/pdf", size: 25_000_000, path: "adjuntos/Book.pdf" }],
  });
});

test("a file in the bucket tells the agent how to download it, and the link is not replayed", () => {
  const url = "https://ns.compat.objectstorage.mx-queretaro-1.oraclecloud.com/acp-agent-uploads/uploads/s1/id/It's.pdf?X-Amz-Signature=abc&X-Amz-Expires=3600";
  const block = attachmentsBlock([{ name: "It's.pdf", mimeType: "application/pdf", size: 6_000_000, path: "adjuntos/It's.pdf", url }]);
  assert.match(block, /^- adjuntos\/It's\.pdf \(application\/pdf, 6000000 bytes\) GRANDE$/m);
  assert.ok(block.includes(`curl -fsS --create-dirs -o 'adjuntos/It'\\''s.pdf' '${url.replace("'", "'\\''")}'`));
  assert.match(attachmentsBlock([{ name: "x.zip", mimeType: "application/zip", size: 10, path: "adjuntos/x.zip", url }]), /^- adjuntos\/x\.zip \(application\/zip, 10 bytes\) COMPRIMIDO$/m);
  const { text, files: parsed } = takeAttachments(`Read it\n${block}`);
  assert.equal(text, "Read it");
  assert.deepEqual(parsed, [{ name: "It's.pdf", mimeType: "application/pdf", size: 6_000_000, path: "adjuntos/It's.pdf" }]);
});

test("the server refuses bad upload ids and file names", () => {
  assert.equal(invalidFiles([]), undefined);
  assert.equal(invalidFiles([{ id: "abc_DEF-123" }, { id: "x" }]), undefined);
  assert.match(invalidFiles("x").error, /invalid files/);
  assert.equal(invalidFiles(Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ id: `f${i}` }))).tooLarge, true);
  for (const bad of [null, {}, { id: 3 }, { id: "" }, { id: "../x" }, { id: "a".repeat(65) }]) {
    assert.match(invalidFiles([bad]).error, /invalid file/, JSON.stringify(bad));
  }
  assert.match(invalidFiles([{ id: "a" }, { id: "a" }]).error, /repeated/);
  for (const ok of ["report.pdf", "Budget (final), v2.xlsx", "It's.zip"]) assert.equal(invalidFileName(ok), undefined, ok);
  for (const bad of [null, "", " ", ".", "..", "a/b.pdf", "a\0b", "x".repeat(201)]) assert.ok(invalidFileName(bad), String(bad));
});
