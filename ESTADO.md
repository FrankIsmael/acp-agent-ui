# Dónde estamos

> Actualizado el 12 de septiembre de 2026. Este archivo es la foto operativa: qué corre, dónde, y qué
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
| Agente | caja `goose-demo` (`sb_af93745a-…`), goose 1.48.0 | ✅ `goose-acp.service` |
| Repo | [blissito/acp-agent-ui](https://github.com/blissito/acp-agent-ui) | público |

## Para arrancar

```sh
npm install
npm run dev        # necesita .env
```

El `.env` (fuera del repo) lleva `ACP_WS_URL`, `ACP_SECRET`, `ACP_CWD`, `AGENT_BOX_ID` y
`EASYBITS_API_KEY`. **Sin la llave la app funciona pero no gestiona la caja** (el log dice
"sin SDK"); `@easybits.cloud/sdk` ya es dependencia.

Si la caja muere, [`scripts/new-goose-box.mjs`](scripts/new-goose-box.mjs) levanta otra de cero
en ~25 s (crear, instalar goose, LLM = EasyBits, `/data/work`, unidad, expose) y reescribe el
`.env`. Sólo necesita `EASYBITS_API_KEY` en el entorno. Pasó el 2 sep: la primera `goose-demo`
desapareció del host sin aviso (404 "sandbox not found") mientras figuraba `running`.

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
- **Nada se persiste.** Las conversaciones viven en un `Map` del proceso: reiniciar el server las
  borra. Es justo el tema de la [sesión 3](docs/spec3-revivir.md).
- **El permiso se auto-aprueba.** `session/request_permission` se acepta solo, en
  `app/.server/acp.ts`. Tema de la [sesión 4](docs/spec4-permisos-extensiones.md).
- **El botón de parar no interrumpe.** Está dibujado; falta `session/cancel`.
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

## Lo siguiente

Las sesiones 3 a 6 están planteadas en `docs/`, cada una con lo que ya se sabe del protocolo y lo
que falta decidir. El orden natural es el del temario: primero revivir (sesión 3), porque todo lo
demás se apoya en que el estado sobreviva.

Dos cosas sueltas antes de empezar:

- `.agents/skills/react-router/` viene del scaffold. **No borrar**: en la sesión 1 sirve de
  ejemplo en vivo de que las skills salen del `cwd` que viaja en `session/new` — goose la lee
  del proyecto y la anuncia al editor en `available_commands_update`.
- El `Dockerfile` es el del scaffold y hace `npm start`, que ahora exige `.env`: si se despliega en
  Fly, las variables van como secrets.
