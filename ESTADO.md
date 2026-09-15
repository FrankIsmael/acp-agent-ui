# Dónde estamos

> Actualizado el 14 de septiembre de 2026. Este archivo es la foto operativa: qué corre, dónde, y qué
> hay que saber para retomar sin releer todo. Lo conceptual va en [`docs/`](docs/).

## Lo que funciona hoy

Un turno completo desde el navegador: llega al agente, el agente escribe en el disco de su caja,
responde en markdown y reporta tokens y costo. Verificado el 31 de agosto con
`/root/web3-ok.txt` → `WEB3_OK`.

| Pieza | Dónde | Estado |
|---|---|---|
| Interfaz | la raíz de este repo | ✅ SSR, 9 rutas |
| Motor ACP | `app/.server/acp.ts` | ✅ una conexión por conversación |
| SSE | `app/routes/api.conversations.$id.events.ts` | ✅ con latido cada 25 s |
| Agente | `mi-agente-claude` (`sb_76f0708e-…`), ghosty-lite 1.48.0, `claude-acp`/sonnet, `GOOSE_MODE=approve` | ✅ `ghosty-lite-runtime` |
| Extensiones | `/extensions`, SQLite en `.data/extensions.db` | ✅ http y stdio, en `session/new` y en caliente |
| Permisos | `PermissionCard`, `/api/conversations/:id/permissions` | ✅ el turno espera la decisión |
| Repo | [blissito/acp-agent-ui](https://github.com/blissito/acp-agent-ui) | público |

## Para arrancar

```sh
npm install
npm run dev        # necesita .env
```

El `.env` (fuera del repo) lleva `ACP_WS_URL`, `ACP_SECRET`, `ACP_CWD`, `AGENT_BOX_ID` y
`EASYBITS_API_KEY`. **Sin la llave la app funciona pero no gestiona la caja** (el log dice
"sin SDK"); `@easybits.cloud/sdk` ya es dependencia.

Si la caja muere, [`scripts/new-ghosty-agent.mjs`](scripts/new-ghosty-agent.mjs) crea otro agente
`ghosty-lite` con Claude (`CLAUDE_CODE_OAUTH_TOKEN` de `claude setup-token`, o `ANTHROPIC_API_KEY`)
y reescribe el `.env`; guarda `ACP_SECRET` y `AGENT_BOX_ID` nada más crear, porque `createAgent`
devuelve la URL como `sandbox://…` y la `wss://` real sólo aparece después en `getAgent`. Ha pasado
dos veces que la caja desaparece del host con 404 "sandbox not found" mientras figura `running`
(2 sep y 12 sep); sin `AGENT_SNAPSHOT_ID` no hay recuperación automática. Para goose sobre DeepSeek
queda [`scripts/new-goose-box.mjs`](scripts/new-goose-box.mjs).


```sh
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oa... node --env-file=.env scripts/new-ghosty-agent.mjs mi-agente-claude
```

## Lo que hay que saber

- **Las herramientas y el pensamiento se ven.** `tool_call` / `tool_call_update` llegan al
  navegador como evento `tool` (upsert por id) y `agent_thought_chunk` como `thought`; el chat
  pinta el pensamiento colapsado y una fila por herramienta con su estado. Hecho el 2 sep para la
  sesión 2.
- **`terminal: false` en `initialize`.** Con `true` goose pide `terminal/create` al cliente y,
  como no lo implementamos, cada `shell` termina en `failed`. El shell corre en la caja.
- **`POST /extend` da 500 en una caja con TTL vencido** (viva por la siesta): el host suma sobre
  el `expiresAt` viejo y rechaza con 400, y EasyBits lo convierte en 500. Arreglos en rama en
  `sandbox-host` y `easybits`, pendientes de desplegar.

- **La caja se suspende sola** al quedar inactiva. La despierta el propio `Upgrade` del WebSocket
  (verificado el 1 sep 2026); `ensureAgentBox` sólo extiende el TTL, suspende al ocio y avisa si la
  caja ya no existe. La unidad de systemd relanza `goose serve` al arrancar. Antes de eso, cada
  suspensión dejaba la app muerta con un 401 que parecía de credenciales.
- **Node 22.16 contra 22.22.** React Router pide ≥ 22.22 y avisa en cada arranque; funciona igual.
  Vale la pena subir la versión para dejar de leer el aviso.
- **Las conversaciones sí sobreviven (verificado en prod el 14 sep).** Viven en la caja del
  agente (`/data/ghosty/data/sessions/sessions.db`, raíz persistente) y la lista sale de
  `session/list`; reiniciar la app no borra nada. Lo que *parece* pérdida son tres cosas:
  1. todas se llaman `New Chat` — el agente no está generando títulos en esta caja (pendiente);
  2. al suspenderse la caja por ocio (15 min) el WebSocket cae, el server manda `closed` y el
     navegador **no reconecta** (`useAcpStream.ts`, handler `closed`): el chat abierto queda muerto
     hasta recargar. Pendiente: reabrir el `EventSource` con backoff;
  3. la primera petición tras el sueño tarda ~19 s y `/sessions` enseña "Cargando…" vacío.
  Lo único que sí se pierde es la caja entera (ha pasado dos veces): `backup-sessions.mjs`
  existe pero nadie lo programa.
- **El permiso ya no se auto-aprueba.** El turno espera la decisión en el chat; sin timeout, se
  cancela al detener, cerrar o desconectar. Ver [`docs/permissions-extensions.md`](docs/permissions-extensions.md).
- **Un `session/new` colgado ya no cuelga la app.** Tope `ACP_SESSION_TIMEOUT_MS` (60 s); el
  error llega al navegador nombrando las extensiones activas, y la causa real al log del servidor
  (`[conversations] …`). Antes cualquier fallo era "Revisa la conexión con el agente".
- **La base de extensiones es la de la rama `sesion-4-mcp`** (columna por campo, `id` UUID,
  `name` único, `ACP_EXTENSIONS_DB` / `.data/extensions.db`): un archivo escrito en una rama se
  lee en la otra. Un `.db` del formato intermedio (`configuration` JSON) se convierte solo al abrir.
- **`scripts/permissions.integration.mjs` corre contra `build/`**: si falla después de tocar
  código, primero `npm run build`.
- **El botón de parar sí interrumpe** (`session/cancel`).
- **Los métodos son `_unstable`.** Todo lo que llene las vistas vacías lleva ese sufijo en goose:
  pueden cambiar sin aviso.
- **El MCP http de EasyBits no entrega tools con goose/ghosty — y no es el provider.** Investigado
  el 12 sep 2026. El servidor funciona (por curl `tools/list` devuelve 87 tools, entre ellas
  `research_search` y `research_scrape`), goose lo acepta en `session/new`, pero el modelo no ve
  ninguna; sólo llegan los recursos `ui://easybits/*`. La causa está en el log de la caja
  (`/data/ghosty/state/logs/cli/<fecha>/*.log`, no en journald):
  `extension_manager "Failed to list tools" error="Unexpected response type"`. Es rmcp 3.1.4
  (el cliente MCP de ghosty 1.48.0) rechazando la respuesta de `tools/list`: EasyBits manda
  `"cacheScope":"connection"` y el enum de rmcp —y el esquema MCP— sólo admite `"public"` o
  `"private"`. Falla `ListToolsResult`, el `ServerResult` untagged cae en el comodín, y goose
  descarta la lista entera. `resources/list` no lleva `cacheScope`, por eso los recursos sí
  aparecen. Le pasa igual a la extensión `easybits` que la caja trae de serie y al paquete stdio
  `@easybits.cloud/mcp` (es un proxy al mismo endpoint). Arreglo: EasyBits (una palabra en su
  servidor); mientras, un proxy stdio que reescriba `cacheScope` es la única salida desde goose.
  - **Por qué "funcionó" en la rama `sesion-4-mcp` con `claude-acp` + Sonnet:** no es goose con
    otro modelo, es otro agente con otro cliente MCP (el SDK de TypeScript, tolerante con el enum).
    Mismo servidor, mismo bug; sólo un cliente es estricto. Lo que la rama anotó como "era el
    provider" es este mismo fallo visto desde el otro lado.
  - **Lo que sí vale de aquella sesión:** la credencial va en la URL (`?token=`), no en
    `headers[]`. EasyBits contesta al 401 con `WWW-Authenticate: Bearer resource_metadata=…` y
    goose lo toma por OAuth: arranca un login en navegador (`If the browser did not open,
    authorize … at:` en journald) y `session/new` se queda colgado. Con `?token=` conecta en 2 s.
    Y con `claude-acp` hace falta `GOOSE_MODE=approve` o el turno muere con `Internal error`.
  - **Verificado el 12 sep con el agente nuevo (`claude-acp`/sonnet):** la extensión http con
    `?token=` carga en 1 s y el modelo invocó `mcp__EasybitsTools__research_search` con resultado
    real. Y desde goose/DeepSeek también hay salida: la caja trae
    `/data/tools/easybits-mcp-proxy.mjs`, que reescribe `cacheScope`; como extensión stdio
    (`/usr/local/bin/node /data/tools/easybits-mcp-proxy.mjs`, env `EASYBITS_API_KEY` +
    `EASYBITS_MCP_URL=https://www.easybits.cloud/api/mcp?tools=web`) entrega las 11 tools de `web`.
  - **Pero el agente no las usa solo:** con `claude-acp` el cerebro sólo lee `/data/work/CLAUDE.md`
    (copia de `/data/ghosty/config/.goosehints` en cada arranque), y ahí manda usar
    `/opt/gs-sdk/web.mjs` y no las tools nativas — lo obedece aunque se le pida lo contrario, y
    `web.mjs` está roto en esta caja (falta `.gs-turn.json`). Para que "busca X" vaya al MCP hay
    que cambiar esa regla en los dos archivos, con orden de preferencia (MCP de EasyBits si está en
    la sesión → `web.mjs` → nativa). Aplicado el 13 sep en los dos archivos; el texto está en la
    [spec 4](docs/spec4-permisos-extensiones.md). Vale para conversaciones nuevas, y sobrevive al
    reinicio porque `.goosehints` es la fuente.

## Producción

Dos cajas de EasyBits, y conviene no confundirlas:

| | App | Agente |
|---|---|---|
| id | `sb_97a7e9bf-e516-453e-8acf-ddd54e6d1fdc` (template `node`) | `sb_dc72993b-5fd9-4f25-b9f0-b6078632f7cd` (ghosty-lite) |
| URL | https://acp-agent.ismaelfrancisco.tech (Caddy → :3000) | `wss://acp-6aa757c3…/acp` |
| disco persistente | `/app` (ext4, `/dev/vdb`); **no hay `/data`** | `/data` |
| qué guarda | repo + `build/` + `.data/extensions.db` | `sessions.db` |
| logs | `/var/log/easybits-app.log`, `journalctl -u easybits-app` | `/data/ghosty/state/logs/cli/…` |

La app corre como `easybits-app.service` (`Restart=always`), arrancada por
`/app/.easybits-start.sh`, que carga `/app/.easybits.env` (los secrets de `easybits.json`) y hace
`exec node server.js`. **Una sola instancia**: el motor ACP es estado del proceso (`connection`,
`active`, `history`); con dos réplicas el SSE cae en una y el POST en otra.

Desplegar = subir el commit y reconstruir en la caja; un restart solo no trae código nuevo:

```sh
git push origin main
# en la caja de la app (POST /api/v2/sandboxes/<app>/exec):
cd /app && git fetch -q origin main && git checkout -q -B main origin/main && npm run build
# reiniciar el servicio: tool `restart_machine` del MCP de EasyBits (?tools=sandbox,hosting,fleet)
```

Para mirar dentro, `exec` con un comando: `ls /app/.data`, `tail /var/log/easybits-app.log`, o la
base de extensiones con `node -e` y `node:sqlite` en modo `readOnly` (nunca `cp` con WAL abierto).

- **Detrás de Caddy, Express creía hablar http** (`req.protocol`) y `request.url` salía con el
  esquema equivocado: `assertSameOrigin` rechazaba con 403 el POST del propio navegador en
  `/api/extensions`. Arreglado el 14 sep (`99470dc`): `app.set("trust proxy", true)` en
  `server.js` y la comprobación se fía de `Sec-Fetch-Site` (lo pone el navegador) y sólo compara
  `Origin` por host, no por esquema. En dev no se veía porque no hay proxy.

## Lo siguiente

Las sesiones 3 a 6 están planteadas en `docs/`, cada una con lo que ya se sabe del protocolo y lo
que falta decidir. El orden natural es el del temario: primero revivir (sesión 3), porque todo lo
demás se apoya en que el estado sobreviva.

Dos cosas sueltas antes de empezar:

- `.agents/skills/react-router/` viene del scaffold. **No borrar**: en la sesión 1 sirve de
  ejemplo en vivo de que las skills salen del `cwd` que viaja en `session/new` — goose la lee
  del proyecto y la anuncia al editor en `available_commands_update`.
- El `Dockerfile` **no se usa en prod** (ver "Producción"). Si algún día se usa: `npm start` hace
  `node --env-file=.env`, que revienta sin archivo; cambiar a `--env-file-if-exists=.env`.
