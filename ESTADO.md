# Dónde estamos

> Actualizado el 19 de septiembre de 2026. Este archivo es la foto operativa: qué corre, dónde, y qué
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
| WhatsApp | `/whatsapp`, `app/.server/whatsapp.ts` (Baileys), tablas `whatsapp_*` en la misma SQLite | ✅ QR o código, grupos con switch, ráfagas, fotos y reacciones |
| Repo | [blissito/acp-agent-ui](https://github.com/blissito/acp-agent-ui) | público |

## Para arrancar

```sh
npm install
npm run dev        # necesita .env
```

El `.env` (fuera del repo) lleva `ACP_WS_URL`, `ACP_SECRET`, `ACP_CWD`, `AGENT_BOX_ID` y
`EASYBITS_API_KEY`. Para WhatsApp en prod, además `WHATSAPP_ADMIN_KEY` (una cadena larga al
azar): sin ella `/whatsapp` no abre en producción; se entra una vez con `/whatsapp?key=<llave>`
y el navegador queda autorizado 30 días por cookie. **Sin la llave la app funciona pero no gestiona la caja** (el log dice
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

- **WhatsApp entra al mismo hilo que el chat web** ([`docs/spec5-operacion.md`](docs/spec5-operacion.md)).
  `askFromChannel` en `acp.ts` mete el turno en el hilo abierto (o abre uno) y espera la
  respuesta entera; el navegador lo ve como burbuja etiquetada "vía WhatsApp" (evento `user`)
  y las imágenes de herramientas `mcp:` como evento `image`. Las credenciales de Baileys viven
  en `whatsapp_auth` dentro de `ACP_EXTENSIONS_DB`: al hostear, esa ruta debe estar en disco
  persistente o habrá que escanear otra vez tras cada despliegue. Al abrir el hilo se fuerza
  `session/set_mode auto` (`ACP_MODE`; vacío para no tocarlo), porque ghosty no entrega la
  respuesta del permiso con claude-acp y la herramienta se queda colgada.

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
- **`tests/permissions.integration.mjs` corre contra `build/`**: si falla después de tocar
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
    [spec 4](docs/spec4-permisos-extensiones.md). Vale para conversaciones nuevas.
  - **Ojo: ninguno de los dos archivos es la fuente.** `/usr/local/bin/ghosty-lite-start` (viene
    en la imagen del template, no de este repo) hace en cada arranque de la unidad
    `cp /opt/goose/goosehints.md → /data/ghosty/config/.goosehints`, le añade la sección `hilos`
    desde un heredoc del propio script y copia el resultado a `/data/work/CLAUDE.md`. Lo que se
    edite en `/data` dura hasta el siguiente arranque: `restart_machine`, `systemctl restart`, o
    un crash de `ghosty serve` (`Restart=on-failure`). Suspender/despertar NO cuenta: es un
    snapshot de memoria, el script no corre (comprobado el 19 sep: un solo boot desde el 12 sep,
    `NRestarts=0`, 31 h de uptime en 6 días). Los cambios del 13 sep siguen vivos por eso, no
    porque sobrevivan. Para que duren hay que tocar también `/opt/goose/goosehints.md` (raíz del
    disco de imagen: aguanta reboots, no una caja nueva ni un rebake).
  - **19 sep:** los dos archivos de `/data` traducidos al inglés (copias `.es.bak` al lado) y con
    el bloque `## Output format by channel` (`HINTS_BLOCK` en `artifact-instructions.ts`). La app
    ya no manda `ARTIFACT_INSTRUCTIONS` en cada `session/prompt`: `ensureHints` comprueba la marca
    `<!-- acp-agent-ui:output-format v1 -->` en cada conexión y la añade si falta (por eso un boot
    que pise los archivos se repara solo); los turnos de WhatsApp llevan sólo la línea
    `[channel: whatsapp-group]`. Sin SDK, o con `ACP_INLINE_INSTRUCTIONS=1`, vuelve a ir todo en
    línea como antes.

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
cd /app && git fetch -q origin main && git checkout -q -B main origin/main && (npm ci || npm install) && npm run build
# reiniciar el servicio: tool `restart_machine` del MCP de EasyBits (?tools=sandbox,hosting,fleet)
# Sin el `npm ci` un commit que añade paquetes arranca con ERR_MODULE_NOT_FOUND y todo da 500 (15 sep).
```

Cambiar una variable de entorno = dos pasos, sin build ni git: (1) `set_machine_secrets` (tool
del MCP de EasyBits, o el dashboard) con **sólo el valor** — el 15 sep `WHATSAPP_ADMIN_KEY` se guardó
como `' WHATSAPP_ADMIN_KEY=…'` por pegar la línea entera y la llave nunca coincidía; (2) reiniciar
(`restart_machine`): el `.easybits.env` se lee una vez al arrancar y el proceso no lo relee. Una
variable nueva tiene que estar además en `secretNames` de `easybits.json`. Se comprueba con
`systemctl show easybits-app -p ActiveEnterTimestamp` (más nuevo que el cambio) y `grep` en el archivo.

Para mirar dentro, `exec` con un comando: `ls /app/.data`, `tail /var/log/easybits-app.log`, o la
base de extensiones con `node -e` y `node:sqlite` en modo `readOnly` (nunca `cp` con WAL abierto).

- **Detrás de Caddy, Express creía hablar http** (`req.protocol`) y `request.url` salía con el
  esquema equivocado: `assertSameOrigin` rechazaba con 403 el POST del propio navegador en
  `/api/extensions`. Arreglado el 14 sep (`99470dc`): `app.set("trust proxy", true)` en
  `server.js` y la comprobación se fía de `Sec-Fetch-Site` (lo pone el navegador) y sólo compara
  `Origin` por host, no por esquema. En dev no se veía porque no hay proxy.

## Pendientes recomendados (15 sep 2026, tras cerrar WhatsApp)

Ordenados por lo que más duele si falta. Los tres primeros van antes de dejar el canal
funcionando en prod sin mirarlo.

1. **Auth de verdad.** Hoy la puerta es `WHATSAPP_ADMIN_KEY` + cookie HMAC
   (`app/.server/admin-gate.ts`) y sólo cubre `/whatsapp` y sus dos APIs: el chat, las
   extensiones y las sesiones siguen abiertos a quien tenga el link. Lo natural: una sesión de
   usuario (passkey/OAuth o login simple) y la misma `requireAdmin` en todas las rutas de
   escritura. El `admin-gate` está hecho para que sustituirlo sea cambiar una función.
2. **Reconexión del navegador al chat.** Cuando la caja duerme el server manda `closed` y
   `useAcpStream` no reabre el `EventSource`: el chat queda muerto hasta recargar. Backoff y
   `snapshot` al volver. Con WhatsApp entrando al mismo hilo esto se nota más (el hilo cambia
   sin que el navegador se entere).
3. **Un turno por vez, hasta para grupos.** `askFromChannel` encola; con dos grupos activos y un
   agente lento la cola crece y el segundo grupo espera minutos sin aviso. Medir, y si molesta,
   un mensaje de "en cola" al grupo o un hilo por grupo (rompe "una sola sesión viva").
4. **Alcance del canal.** Sólo grupos; falta el DM del dueño (útil para operar sin grupo),
   audios/notas de voz (transcribir antes de mandar), documentos, citar mensajes, editados y
   borrados. Cada uno es un tipo de mensaje distinto de ida y de vuelta.
5. **Mención opcional.** En grupos con gente, contestar a todo es ruido: un interruptor por
   grupo "sólo si me mencionan o responden al agente".
6. **Seguridad del canal.** Tope de tamaño de foto entrante (hoy se descarga lo que llegue),
   tope de frecuencia por grupo, y borrar de la base las credenciales al desvincular desde el
   teléfono (ya se hace) y al fallar 5 reconexiones (hoy quedan). Revisar que el log en
   `WHATSAPP_LOG=debug` nunca quede activo en prod: imprime llaves.
7. **Operación** ([`docs/operacion.md`](docs/operacion.md) sigue como plan): aviso cuando el
   canal pasa a `failed` o `disconnected` sin pedirlo (un mensaje al DM del dueño basta),
   `/healthz` con estado del canal y de la conexión ACP, y `backup-sessions.mjs` programado.
8. **Permiso desde el grupo** (spec 4): bloqueado por ghosty (`No task waiting for
   confirmation`). Mientras, el hilo va en `ACP_MODE=auto`: el agente ejecuta sin preguntar,
   también lo que llegue por WhatsApp. Es una decisión consciente; conviene tenerla presente
   al prender un grupo con desconocidos.
9. **Pruebas.** El canal no tiene ninguna: al menos `paraWhatsApp`, el buffer de ráfagas, el
   `authState` sobre sqlite (round-trip con `BufferJSON`) y el `admin-gate` con `node --test`,
   como `titles.test.mjs`.
10. **Higiene.** Subir Node a ≥ 22.22 en la caja de la app para dejar de ver el aviso de React
    Router; `--env-file-if-exists` en `npm start` si algún día se usa el Dockerfile; títulos de
    hilo ("New Chat") pendientes del agente; y un `README` corto de "cómo vincular WhatsApp".

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
