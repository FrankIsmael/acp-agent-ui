import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactContent, artifactFile, artifactKey, artifactPreviewDocument, mergeArtifacts, parseArtifacts, previewKind, readArtifactStorage } from "../app/lib/artifacts.ts";

const source = '<artifact identifier="counter" type="text/html" title="Counter &amp; tools" language="html"><button onclick="this.textContent++">0</button></artifact>';
const parsed = parseArtifacts(source)[0].artifact;
const artifact = { ...parsed, key: artifactKey("chat", 1, 0), conversationId: "chat", turnIndex: 1, updatedAt: 1 };

test("every streaming boundary hides the protocol and preserves raw content", () => {
  const start = source.indexOf("><button") + 1;
  const end = source.indexOf("</artifact>");
  for (let i = 0; i <= source.length; i++) {
    const parts = parseArtifacts(source.slice(0, i), true);
    assert.equal(parts.filter(p => p.kind === "text").map(p => p.text).join(""), "", `text leaked at ${i}`);
    const part = parts.find(p => p.kind === "artifact");
    if (i >= start) {
      assert.ok(part, `missing artifact at ${i}`);
      assert.equal(part.artifact.title, "Counter & tools");
      // A trailing '<' is withheld until it can be distinguished from a closer.
      const expected = source.slice(start, Math.min(i, end));
      assert.ok(expected.startsWith(part.artifact.content), `content corrupted at ${i}`);
      assert.equal(part.artifact.complete, i === source.length);
    }
  }
  assert.equal(parsed.content, '<button onclick="this.textContent++">0</button>');
});

test("mixed prose and multiple artifacts retain order and quoted > attributes", () => {
  const parts = parseArtifacts(`Before ${source} between <artifact title='A > B' type='text/markdown'># Document\n\n&amp;</artifact> after`);
  assert.deepEqual(parts.map(p => p.kind), ["text", "artifact", "text", "artifact", "text"]);
  assert.equal(parts[3].artifact.title, "A > B");
  assert.equal(parts[3].artifact.content, "# Document\n\n&amp;");
  assert.equal(parts[3].index, 1);
});

test("ordinary messages and malformed finished tags remain readable", () => {
  for (const text of ["Hello!", "Use <article> here", "Two < three", '<artifact title="unfinished']) {
    assert.equal(parseArtifacts(text).map(p => p.text).join(""), text);
  }
  assert.deepEqual(parseArtifacts(""), []);
  assert.equal(parseArtifacts('<artifact type="text/plain">partial')[0].artifact.complete, false);
  assert.equal(parseArtifacts('<artifact type="text/plain">partial')[0].artifact.content, "partial");
});

test("local edits survive stream updates, reload and later revisions", () => {
  const edited = { ...artifact, editedContent: "my local source" };
  const updated = mergeArtifacts([edited], [{ ...artifact, content: "agent updated source" }]);
  assert.equal(artifactContent(updated[0]), "my local source");
  assert.equal(updated[0].content, "agent updated source");
  assert.equal(mergeArtifacts(updated, [{ ...artifact, content: "agent updated source" }]), updated);
  const later = { ...artifact, key: artifactKey("chat", 3, 0), turnIndex: 3 };
  const other = { ...artifact, key: artifactKey("other-chat", 1, 0), conversationId: "other-chat" };
  const library = mergeArtifacts(updated, [later, other]);
  assert.equal(library.length, 3);
  assert.deepEqual(readArtifactStorage(JSON.stringify({ version: 1, artifacts: library })), library);
  assert.equal(artifactContent({ ...edited, editedContent: "" }), "");
});

test("corrupt or incompatible storage is rejected, malformed records ignored", () => {
  assert.deepEqual(readArtifactStorage(null), []);
  assert.throws(() => readArtifactStorage("bad JSON"));
  assert.throws(() => readArtifactStorage('{"version":2,"artifacts":[]}'));
  assert.deepEqual(readArtifactStorage(JSON.stringify({ version: 1, artifacts: [null, {}, { ...artifact, content: 123 }, artifact] })), [artifact]);
});

test("HTML, SVG and Markdown preview; other code downloads with a safe extension", () => {
  assert.equal(previewKind(artifact), "html");
  assert.equal(previewKind({ type: "image/svg+xml", language: "" }), "svg");
  assert.equal(previewKind({ type: "application/vnd.ant.document", language: "" }), "markdown");
  assert.equal(previewKind({ type: "application/vnd.ant.code", language: "html" }), "html");
  assert.equal(previewKind({ type: "application/vnd.ant.code", language: "python" }), "code");
  assert.deepEqual(artifactFile({ ...artifact, title: "../../hello.py", type: "application/vnd.ant.code", language: "python" }), { name: "hello.py", mime: "text/plain" });
});

test("preview restrictions precede untrusted markup and prohibit external resources", () => {
  const html = artifactPreviewDocument('<meta http-equiv="Content-Security-Policy" content="default-src *"><script>parent.compromised=true</script>');
  assert.ok(html.indexOf("default-src 'none'") < html.indexOf("default-src *"));
  for (const directive of ["connect-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'"]) assert.ok(html.includes(directive));
  assert.ok(!html.includes("unsafe-eval"));
});
