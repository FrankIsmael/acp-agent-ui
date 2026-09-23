export const ARTIFACT_INSTRUCTIONS = `The chat UI supports an Artifacts side panel. When the user asks you to create or revise code, a document, a graphic, a web page, or an app, emit the complete creation directly in your assistant response using this exact format:
<artifact identifier="stable-short-id" type="text/html" title="Human readable title" language="html">
...complete raw file content...
</artifact>
Use text/html for runnable web pages and apps, image/svg+xml for vector graphics, text/markdown for documents, and application/vnd.ant.code with a language attribute for other source code. Use self-contained HTML with inline CSS and JavaScript for runnable apps, even if you would normally use React. The preview has no build step, package imports, external scripts, external images/fonts, network requests, storage, popups or form submissions. Use inline SVG or data URLs for images and in-memory app state. Other programming languages are editable/downloadable source, not executed.
Keep brief explanations outside the artifact. Do not wrap artifact tags or their contents in Markdown fences. Use quoted attributes. Reuse the identifier when revising a creation, and always output the whole updated file. Multiple creations may use separate artifact blocks. Never put a literal closing artifact tag inside file content; construct/escape that string if needed. Do not merely write a file with a tool: include its full contents in the artifact response so the user can see it. Answer ordinary questions normally without forcing an artifact.`;

/**
 * Lo que se le dice al agente cuando el turno entra por un canal de mensajería. Ahí no hay
 * panel de artifacts ni markdown: un bloque `<artifact>` llega al grupo como texto crudo.
 */
export const CHANNEL_INSTRUCTIONS = `You are replying inside a WhatsApp group; your text is delivered verbatim as a chat message. Write plain conversational text: short, no Markdown headers, tables, code fences or links in brackets (WhatsApp only renders *bold*, _italic_ and \`monospace\`). Never emit <artifact> blocks: if asked for a web page, document or code, put the content inline briefly or say it is available in the web chat. If asked for an image, picture, photo or drawing, call the generar_imagen tool when available; it delivers the image to the group by itself, so afterwards answer with one short line. If that tool is not available, say you cannot generate images here. Several lines prefixed with names may arrive together: they are consecutive messages from the group members.`;

/**
 * Marca de un turno que entra por un canal de mensajería. Va sola al principio del prompt
 * (≈10 tokens) en lugar de CHANNEL_INSTRUCTIONS entera: las reglas viven en el CLAUDE.md
 * de la caja (HINTS_BLOCK) y esta línea sólo dice cuáles aplican. El canal no se puede
 * saber desde el archivo porque web y WhatsApp comparten el mismo hilo.
 */
export const CHANNEL_MARKER = "[channel: whatsapp-group]";

/**
 * Marca con la que HINTS_BLOCK se reconoce dentro de CLAUDE.md / .goosehints. Subir la
 * versión hace que `ensureHints` vuelva a añadir el bloque (el viejo hay que quitarlo a mano).
 */
export const HINTS_MARKER = "<!-- acp-agent-ui:output-format v1 -->";

/**
 * Lo que antes viajaba en cada `session/prompt` (ARTIFACT_INSTRUCTIONS o CHANNEL_INSTRUCTIONS,
 * ≈350 tokens por turno, repetidos en el historial) ahora se escribe UNA vez en el CLAUDE.md de
 * la caja. `ensureHints` lo añade si falta la marca; si no puede escribir en la caja, el prompt
 * vuelve a llevar las instrucciones en línea (ver `inlineInstructions` en acp.ts).
 */
export const HINTS_BLOCK = `
${HINTS_MARKER}
## Output format by channel

Default (web chat): ${ARTIFACT_INSTRUCTIONS}

When a user message starts with the line \`${CHANNEL_MARKER}\`, that turn comes from a messaging channel and the rules above do not apply. Instead: ${CHANNEL_INSTRUCTIONS}
`;
