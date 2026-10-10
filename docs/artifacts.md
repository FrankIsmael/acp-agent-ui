# Artifacts

Request an artifact in any chat, for example:

- "Create a landing page for my portfolio with HTML, CSS, and JavaScript."
- "Design an SVG illustration of a city."
- "Write a project proposal in Markdown."
- "Write a Python script to convert CSV to JSON."

The panel opens as soon as the artifact starts arriving. On desktop, it shares space with the chat; on smaller screens, it appears as a drawer with focus management and can be closed with Escape. You can close it during generation and reopen it from its card or the Artifacts button. The selector lets you switch between files and revisions. Expand opens a large view.

Preview displays HTML pages/apps, SVG graphics, and Markdown or text documents. Code/Edit allows you to modify the content after generation; changes are reflected in the preview. Restore original retrieves the agent's version. Other languages can be edited, copied, and downloaded, but are not executed. The editor is a native textarea with monospaced font, with no external services or Monaco download.

Share opens the system file menu when supported by the browser; in other browsers, it downloads the file for you to send. Download exports the current content with its extension. This version does not publish public URLs.

## Local Storage

The `/artifacts` library, accessible from navigation, saves files and their edits in `localStorage` under `acp-artifacts-v1`. The format is `{ "version": 1, "artifacts": [...] }`. No database is required. The data belongs to the current browser and origin; it is not synchronized between devices or tabs. Deleting the site's data removes the library.

Each file is identified by conversation, turn, and position. A new turn creates an independent revision, even if the agent reuses the identifier. Local edits are not overwritten by new fragments of the response. Manual edits are saved in the library; they are not automatically sent to the agent as context for a new prompt.
The library continues to work after restarting the server, even if the in-memory conversation history no longer exists. Quota or access errors for localStorage are shown in the panel, and you can download a copy.

## Agent Protocol

The instructions live in the agent system prompt (`scripts/system-prompt.md`, section "Output format by channel"); the server does not send them every turn. The agent must include the file in its response, not just write it with a tool:

```xml
<artifact identifier="portfolio" type="text/html" title="My portfolio" language="html">
<!doctype html>
<html><head><style>body { font-family: sans-serif; }</style></head>
<body><h1>Hello</h1><button onclick="this.textContent='Done!'">Test</button></body></html>
</artifact>
```

Types: `text/html`, `image/svg+xml`, `text/markdown`, `text/plain`, and
`application/vnd.ant.code` with `language`. HTML and document aliases from Anthropic are also accepted. Tags should not have Markdown fences and their attributes should be in quotes. The content remains raw: XML entities are not decoded.
The literal `</artifact>` delimiter is reserved for the protocol; if needed inside a file, it should be escaped or constructed as a concatenated string.

The parser accepts openings/closings split across fragments, multiple creations in one turn, and incomplete responses. It does not convert regular Markdown blocks into artifacts. Format compliance depends on the agent model.

## Isolated Preview

Pages use an iframe with `srcDoc` and `sandbox="allow-scripts"`, without `allow-same-origin`. SVG uses a sandbox without script permissions. The [iframe isolation model](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox) is followed.
A CSP policy is inserted before the content: it allows inline scripts and styles to run the artifact and blocks external resources, fetch, forms, subframes, workers, objects, and base URL changes. The iframe does not receive access to the DOM, cookies, or chat storage, nor camera or microphone permissions. As with any iframe, this does not limit CPU/memory for scripts.

Apps must be standalone HTML with included CSS/JavaScript and SVG images inline or as data URLs. No bundler, npm packages, backend server, CDN, or external APIs. In particular, even if Tailwind is requested, `cdn.tailwindcss.com` cannot be used: the required styles should be written directly in a `<style>` block. A React/TypeScript project is preserved as editable source; for an executable app, instructions request its standalone HTML equivalent.
The preview updates at most four times per second and resets its internal state when reloaded. The Restart button allows you to do this manually.

## Verification

```sh
npm run test:artifacts
npm run typecheck
npm run build
```

Tests cover each fragment boundary of the protocol, mixed content, revisions, edits, invalid storage, extensions, and CSP.

There is also a browser test against a simulated local ACP agent. After `npm run build`, set `ARTIFACT_TEST_BROWSER` to the path of the Chrome, Chromium, or Brave executable and run `npm run test:artifacts:browser`. It uses local ports 5197–5199, a temporary profile, and does not call the remote agent. It verifies streaming, true iframe isolation, editing, reload, library, Markdown, SVG, code, downloads, quota errors, and the mobile drawer. Clipboard and system share APIs are simulated to not modify the clipboard or open native menus. Desktop and mobile screenshots are saved in the system's temporary directory.

To test manually, generate an app with a button, edit it, reload the page, open it from the library, and repeat on a mobile screen. Also check copy, download, share, and closing the panel before the response finishes.
