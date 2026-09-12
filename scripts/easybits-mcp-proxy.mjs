#!/usr/bin/env node
/**
 * Puente MCP: stdio (abajo) ⇄ EasyBits por HTTP+SSE (arriba).
 *
 * Por qué existe
 * --------------
 * El cliente MCP de ghosty/goose (rmcp 3.1.4) valida `cacheScope` contra el enum del esquema
 * MCP ("public" | "private") y el servidor de EasyBits lo contesta con `"connection"`. rmcp no
 * logra parsear `ListToolsResult`, el `ServerResult` untagged cae al comodín y la lista entera
 * se descarta — el agente se queda sin tools ("Failed to list tools / Unexpected response type"
 * en el log del extension_manager), aunque `resources/list` sí pase porque no lleva ese campo.
 *
 * Mientras EasyBits cambia la palabra del lado del servidor, este proxy es la salida desde el
 * cliente: reescribe `cacheScope` a un valor legal y de paso traduce el transporte, porque el
 * agente lanza procesos por stdio y el servidor habla streamable HTTP.
 *
 * Uso
 * ---
 *   EASYBITS_API_KEY=... node scripts/easybits-mcp-proxy.mjs
 *
 * A mano, sin agente de por medio:
 *
 *   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
 *     | EASYBITS_API_KEY=... node scripts/easybits-mcp-proxy.mjs
 *
 * Variables de entorno
 * --------------------
 *   EASYBITS_API_KEY           La llave; viaja como `Authorization: Bearer`. Sin ella, sin auth.
 *   EASYBITS_BASE_URL          default https://www.easybits.cloud
 *   EASYBITS_MCP_URL           endpoint completo; default ${EASYBITS_BASE_URL}/api/mcp?tools=ghosty
 *   EASYBITS_PROXY_TIMEOUT_MS  default 280000
 */
import { createInterface } from "node:readline";

const BASE = (process.env.EASYBITS_BASE_URL ?? "https://www.easybits.cloud").replace(/\/+$/, "");
const ENDPOINT = process.env.EASYBITS_MCP_URL ?? `${BASE}/api/mcp?tools=ghosty`;
const API_KEY = process.env.EASYBITS_API_KEY ?? "";
const TIMEOUT_MS = Number(process.env.EASYBITS_PROXY_TIMEOUT_MS ?? 280_000);

let sesion = null; // `Mcp-Session-Id` que asigne el servidor, si asigna alguno
let protocolo = null; // versión negociada, para el header `MCP-Protocol-Version`
let pendientes = 0;
let stdinCerrado = false;

const log = (mensaje) => process.stderr.write(`[easybits-proxy] ${mensaje}\n`);
const responder = (mensaje) => process.stdout.write(JSON.stringify(mensaje) + "\n");

/**
 * El esquema MCP sólo admite `"public"` o `"private"`; EasyBits manda `"connection"`.
 * Se recorre el mensaje completo porque el campo puede venir en cualquier resultado cacheable
 * (tools/list hoy; resources/list, prompts/list o completion el día que lo agreguen).
 */
function corregirCacheScope(valor) {
  if (Array.isArray(valor)) {
    valor.forEach(corregirCacheScope);
    return valor;
  }
  if (valor && typeof valor === "object") {
    if ("cacheScope" in valor && valor.cacheScope !== "public" && valor.cacheScope !== "private") {
      log(`cacheScope "${valor.cacheScope}" → "private"`);
      valor.cacheScope = "private";
    }
    Object.values(valor).forEach(corregirCacheScope);
  }
  return valor;
}

/** La respuesta puede venir como SSE (`data: {...}`) o como JSON pelado. */
function mensajesDe(texto, tipo) {
  if ((tipo ?? "").includes("text/event-stream")) {
    const mensajes = [];
    for (const bloque of texto.split(/\r?\n\r?\n/)) {
      const datos = bloque
        .split(/\r?\n/)
        .filter((linea) => linea.startsWith("data:"))
        .map((linea) => linea.slice(5).trimStart())
        .join("\n");
      if (!datos) continue;
      try {
        mensajes.push(JSON.parse(datos));
      } catch {
        /* evento a medias: no hay nada que hacer con él */
      }
    }
    return mensajes;
  }
  const limpio = texto.trim();
  return limpio ? [JSON.parse(limpio)] : [];
}

async function hablarConElServidor(peticion) {
  const cabeceras = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (API_KEY) cabeceras.authorization = `Bearer ${API_KEY}`;
  if (sesion) cabeceras["mcp-session-id"] = sesion;
  if (protocolo) cabeceras["mcp-protocol-version"] = protocolo;

  const respuesta = await fetch(ENDPOINT, {
    method: "POST",
    headers: cabeceras,
    body: JSON.stringify(peticion),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  sesion = respuesta.headers.get("mcp-session-id") ?? sesion;

  const texto = await respuesta.text();
  if (!respuesta.ok) {
    const cola = texto.slice(0, 300);
    throw new Error(
      respuesta.status === 401
        ? `el servidor contestó 401 — revisa EASYBITS_API_KEY. ${cola}`
        : `HTTP ${respuesta.status}. ${cola}`,
    );
  }
  // 202 / cuerpo vacío = notificación aceptada; no hay nada que devolver.
  return texto.trim() ? mensajesDe(texto, respuesta.headers.get("content-type")) : [];
}

async function atender(linea) {
  let peticion;
  try {
    peticion = JSON.parse(linea);
  } catch (error) {
    log(`línea ilegible (${error.message}): ${linea.slice(0, 120)}`);
    return;
  }

  const esNotificacion = peticion.id === undefined || peticion.id === null;
  const metodo = peticion.method ?? "(respuesta)";
  const empezado = Date.now();
  pendientes++;
  try {
    const mensajes = await hablarConElServidor(peticion);
    for (const mensaje of mensajes) {
      protocolo = mensaje?.result?.protocolVersion ?? protocolo;
      responder(corregirCacheScope(mensaje));
    }
    if (!esNotificacion) {
      const trajo = mensajes
        .map((mensaje) =>
          Number.isFinite(mensaje?.result?.tools?.length)
            ? `${mensaje.result.tools.length} tools`
            : mensaje?.error
              ? `error ${mensaje.error.code}`
              : "ok",
        )
        .join(", ");
      log(`${metodo} → ${trajo || "sin respuesta"} (${Date.now() - empezado}ms)`);
    }
  } catch (error) {
    log(`${metodo} → falló: ${error.message}`);
    if (!esNotificacion) {
      responder({
        jsonrpc: "2.0",
        id: peticion.id,
        error: { code: -32603, message: `easybits-proxy: ${error.message}` },
      });
    }
  } finally {
    pendientes--;
    if (stdinCerrado && pendientes === 0) process.exit(0);
  }
}

const entrada = createInterface({ input: process.stdin, crlfDelay: Infinity });
entrada.on("line", (linea) => {
  if (linea.trim()) void atender(linea);
});
entrada.on("close", () => {
  stdinCerrado = true;
  if (pendientes === 0) process.exit(0);
});

log(
  `escuchando; upstream ${ENDPOINT.replace(/(token=)[^&]*/, "$1…")}` +
    (API_KEY ? "" : " (sin EASYBITS_API_KEY: irá sin Authorization)"),
);
