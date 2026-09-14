# Spec 4 — Herramientas nuevas, y pidiéndote permiso por WhatsApp

> **Plan, no bitácora.**

## El problema

La interfaz web asume que estás sentado frente a ella. Un agente que trabaja solo necesita
alcanzarte donde estés, y necesita **preguntarte** antes de hacer algo caro o irreversible.

El permiso sólo importa cuando hay algo que permitir: por eso las **extensiones** viven en esta
sesión y no en la última. Darle herramientas nuevas al agente y decidir qué puede hacer sin
preguntar son la misma conversación.

## Lo que ya existe

- **La conexión no depende del navegador.** El agente vive en la caja y la app es un cliente ACP
  más: nada impide que el cliente sea un webhook de WhatsApp.
- **Los puntos 1 y 2 del plan ya están hechos** (12–13 sep 2026, en `main`). El detalle operativo
  vive en [`permissions-extensions.md`](permissions-extensions.md); aquí sólo lo que cambia el plan:
  - `/extensions` da de alta servidores MCP (http o stdio) en SQLite (`.data/extensions.db`,
    misma tabla que usó la rama `sesion-4-mcp`) y las activas viajan en `mcpServers` en cada
    `session/new` / `session/load`. También se conectan y retiran de la conversación abierta
    (`_goose/unstable/session/extensions/add` y `/remove`; ojo: `remove` pide `name`, no
    `extensionKey`, y `list` devuelve cada extensión plana, sin clave).
  - `session/request_permission` **ya no se auto-aprueba**: el turno espera a que alguien decida
    en el chat (`PermissionCard`), con las opciones que mande el agente, incluida la de recordar.
    La decisión tiene API propia (`/api/conversations/:id/permissions`), que es justo lo que
    necesita el punto 3.
  - Un `session/new` que no vuelve (una extensión que no arranca) ya no cuelga la app: tope de
    `ACP_SESSION_TIMEOUT_MS` (60 s) y el error nombra las extensiones activas.

## Lo que hay que hacer

1. ~~Conectarle una extensión MCP desde `/extensions`.~~ Hecho.
2. ~~Quitar la auto-aprobación: que el turno **espere** la respuesta del humano.~~ Hecho.
3. Un canal de decisión que no sea la web (el mismo `optionId`, contra la misma API).
4. El webhook de WhatsApp como segundo cliente del mismo motor.
5. Que la web y WhatsApp vean la misma conversación.

## Lo que se aprendió conectando el MCP de EasyBits

Es el servidor con el que se probó todo, y costó dos sesiones (la rama `sesion-4-mcp` y la del
12 sep). Lo que quedó claro, porque condiciona el resto del plan:

- **Con goose/ghosty sobre cualquier provider "normal" (DeepSeek incluido) el servidor conecta y
  no entrega ni una tool.** No es el modelo: es rmcp 3.1.4, el cliente MCP de ghosty, que rechaza
  el `tools/list` de EasyBits porque trae `"cacheScope":"connection"` y el esquema MCP sólo admite
  `public` | `private`. El log lo dice sin rodeos
  (`/data/ghosty/state/logs/cli/<fecha>/*.log`: `Failed to list tools … Unexpected response
  type`). Le pasa igual a la extensión `easybits` de serie y al paquete stdio `@easybits.cloud/mcp`.
  Arreglo de fondo: una palabra en el servidor de EasyBits.
- **Con el provider `claude-acp` sí funciona**, no porque Claude sea mejor sino porque el turno lo
  ejecuta el adaptador de Claude Code, que trae su propio cliente MCP y tolera el valor. Verificado
  el 12 sep: `mcp__EasybitsTools__research_search` devolvió un resultado real. La rama anotó "era
  el provider"; era esto.
- **La otra salida, desde goose:** la caja trae `/data/tools/easybits-mcp-proxy.mjs`, un puente
  stdio que reescribe `cacheScope`. Declarada como extensión stdio
  (`/usr/local/bin/node /data/tools/easybits-mcp-proxy.mjs`, env `EASYBITS_API_KEY` y
  `EASYBITS_MCP_URL=…/api/mcp?tools=web`) entrega las 11 tools de `web` al modelo, con DeepSeek.
- **La credencial va en la URL** (`?token=`), no en `headers[]`: EasyBits responde al 401 con
  `WWW-Authenticate: Bearer resource_metadata=…` y goose lo toma por OAuth, abre un login que nadie
  ve y `session/new` se queda colgado. Con `?token=` conecta en un segundo.
- **Con `claude-acp` el system prompt de goose se tira** (`AcpProvider::stream` ignora `_system`):
  Claude Code sólo lee `CLAUDE.md` en el cwd, que `ghosty-lite-start` copia desde
  `/data/ghosty/config/.goosehints`. Ahí vive la regla "para buscar usa `/opt/gs-sdk/web.mjs`", y
  el agente la obedece aunque se le pida lo contrario. Cambiada el 13 sep en los dos archivos, con
  orden de preferencia (MCP de EasyBits si está en la sesión → `web.mjs` → nativa), porque no todas
  las sesiones llevan la extensión. La regla ahora dice:

  ```
  Para BUSCAR en la web o LEER una página, en este orden:
  1. Si en esta sesión tienes herramientas MCP de un servidor de EasyBits (p. ej. `EasybitsTools`:
     `research_search`, `research_scrape`, `web_search`, `web_fetch`, `web_extract`, `web_crawl`),
     úsalas: son las de la casa y ya están pagadas.
  2. Si no las tienes, usa `/opt/gs-sdk/web.mjs` (search/scrape).
  3. Sólo si ninguna de las dos está disponible o ambas fallan, usa tu búsqueda nativa y dilo.
  ```
- **`GOOSE_MODE=approve` es obligatorio con `claude-acp`**: por omisión goose pide
  `bypassPermissions`, que el adaptador no ofrece, y cada turno muere con un `Internal error` mudo.
  Es también lo que hace que el agente pida permiso de verdad — el punto 2 del plan sólo tiene
  sentido con esto.
- **Comando stdio con ruta absoluta.** El agente lanza el proceso en su caja sin `PATH`: `node` a
  secas falla sin decir nada. El formulario ya lo exige.

## Lo que falta decidir

- **Timeout de un permiso sin respuesta.** Hoy no hay: el permiso espera mientras viva el servidor
  y se cancela al detener el turno, cerrar el hilo o perder la conexión. ¿Basta, o el turno se cae
  solo pasado un rato?
- **Quién puede aprobar.** Hoy no hay usuarios: cualquiera con el link opera el agente.
- **Qué se pregunta y qué no.** Preguntar todo es inusable; no preguntar nada es peligroso. La
  respuesta depende de qué extensiones tenga conectadas.
- **Si un permiso se recuerda.** ACP ofrece `allow_once` y opciones permanentes: ¿quién decide que
  algo deja de preguntarse?

## La vista `/whatsapp`

Ya existe en cascarón (`app/routes/whatsapp.tsx`, entrada en el panel debajo de Extensiones). Es
la sección que la landing promete: "la integración va dada, ustedes la conectan". El canal son
**grupos**, no chats 1:1: el agente vive en un grupo con las personas que lo operan.

Requisito: la app hosteada (sesión 3). El canal necesita una URL pública estable.

### Qué se ve

1. **Sin vincular.** El QR ya pintado al abrir; se renueva solo (60 s el primero, 20 s los
   siguientes). Sin botón de "generar". Debajo, "Vincular con código": pides el número y sale el
   código de 8 caracteres (`XXXX-XXXX`) para WhatsApp → Dispositivos vinculados → Vincular con
   número. QR y código son excluyentes: pedir uno cancela el otro. En la práctica el código suele
   vincular mejor que el QR; se ofrecen los dos. El estado llega por SSE, igual que el chat.
2. **Conectado.** Número, nombre del teléfono, "conectado desde", botón Desvincular.
3. **Grupos.** Lista de los grupos donde está el número, con checkbox. Sin marcar, el agente
   calla en todos. Aquí vive el "un agente con permiso manda mil".
4. **Un mensaje en un grupo marcado es un turno** del mismo motor (`app/.server/acp.ts`). Se ve
   en `/c/:id`: dos clientes, una conversación.
5. **El permiso llega al grupo.** `session/request_permission` deja de auto-aprobarse: la
   pregunta sale al grupo con sus opciones (`optionId`), se contesta ahí y el turno sigue. La web
   sólo lo muestra como pendiente; no lo decide.

### Qué se copia y de dónde

La máquina de estados y la persistencia vienen de easybits
(`app/.server/integrations/whatsapp/baileys.server.ts`): Baileys, estados
`disconnected → connecting → qr_pending | pairing → connected | failed`, credenciales en base de datos con
flush de llaves con debounce de 600 ms (sin él el pairing se rompe), y `groupFetchAllParticipating`
con caché de 60 s para la lista de grupos. La sesión de WhatsApp va al almacén que decida la
sesión 3, para que sobreviva al deploy. El QR nunca se guarda.

### Fuera de alcance, a propósito

- Decidir el permiso desde la web: doble sincronía que no enseña más.
- Bandeja de chats: lo que entra ya se ve en `/c/:id`.
- Usuarios: quien tenga el link opera el canal. Se anota como límite.

### Por decidir

- Timeout de un permiso sin respuesta en el grupo.
- Si una decisión se recuerda (`allow_once` vs permanente) y quién la toma.
