import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentsBlock, base64Size, invalidFiles, MAX_FILE_BYTES, MAX_FILES, MAX_MESSAGE_BYTES, takeAttachments } from "../app/lib/attachments.ts";

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

test("a file sent in pieces tells the agent how to join them, and replays as one chip", () => {
  const big = { name: "Book's.pdf", mimeType: "application/pdf", size: 25_000_000, path: "adjuntos/Book's.pdf", parts: ["adjuntos/Book's.pdf.part2", "adjuntos/Book's.pdf.part3"] };
  const block = attachmentsBlock([big, { name: "x.zip", mimeType: "application/zip", size: 10, path: "adjuntos/x.zip" }]);
  assert.match(block, /^- adjuntos\/Book's\.pdf \(application\/pdf, 25000000 bytes\) GRANDE$/m);
  assert.match(block, /^- adjuntos\/x\.zip \(application\/zip, 10 bytes\) COMPRIMIDO$/m);
  assert.ok(block.includes(`cat 'adjuntos/Book'\\''s.pdf.part2' 'adjuntos/Book'\\''s.pdf.part3' >> 'adjuntos/Book'\\''s.pdf' && rm 'adjuntos/Book'\\''s.pdf.part2' 'adjuntos/Book'\\''s.pdf.part3'`));
  const { text, files: parsed } = takeAttachments(block);
  assert.equal(text, "");
  assert.deepEqual(parsed.map((f) => [f.path, f.size]), [["adjuntos/Book's.pdf", 25_000_000], ["adjuntos/x.zip", 10]]);
});

test("the server refuses bad or oversized files", () => {
  const ok = { name: "a.pdf", mimeType: "application/pdf", data: Buffer.from("hi").toString("base64") };
  const big = (bytes) => ({ ...ok, data: "A".repeat(Math.ceil(bytes / 3) * 4) });
  assert.equal(invalidFiles([]), undefined);
  assert.equal(invalidFiles([ok]), undefined);
  assert.equal(invalidFiles([big(MAX_FILE_BYTES)]), undefined);
  assert.match(invalidFiles("x").error, /invalid files/);
  assert.equal(invalidFiles(Array(MAX_FILES + 1).fill(ok)).tooLarge, true);
  assert.match(invalidFiles([{ ...ok, name: " " }]).error, /name/);
  assert.match(invalidFiles([{ ...ok, mimeType: 3 }]).error, /type/);
  assert.match(invalidFiles([{ ...ok, data: "not base64!" }]).error, /content/);
  assert.deepEqual(invalidFiles([big(MAX_FILE_BYTES + 3)]), { error: '"a.pdf" is larger than 50 MB', tooLarge: true });
  const third = Math.floor(MAX_MESSAGE_BYTES / 3) + 3;
  assert.equal(invalidFiles([big(third), big(third), big(third)]).tooLarge, true);
});

test("base64 sizes", () => {
  for (const n of [0, 1, 2, 3, 4, 1000]) assert.equal(base64Size(Buffer.alloc(n).toString("base64")), n);
});
