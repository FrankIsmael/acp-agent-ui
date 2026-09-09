# Memoria de conversaciones

Historial y Chats consultan `session/list`, incluida su paginación. El servidor
conserva un caché corto; la pantalla mantiene la última lista durante refrescos
y fallos. Después de reiniciar la app, la lista se reconstruye desde el agente.
No se guarda un índice de conversaciones en el navegador ni en una base propia.

`/c/nuevo` usa el último catálogo de modelos conocido. Cambiar el modelo guarda
una cookie de preferencia sin abrir una sesión ni despertar la caja. El agente
confirma esa elección al crear el hilo. Si todavía no hay catálogo, se conserva
la elección anterior hasta abrir una conversación.

Las URLs usan el `sessionId` del agente. `session/load` reconstruye mensajes,
imágenes, pensamiento, herramientas y uso. El snapshot SSE cubre recargas y
reconexiones. Los títulos vienen del agente. Hay una conexión y una sesión
activa: cambiar de hilo cancela, espera, cierra y carga el siguiente.

Sin `session/list` se muestran sesiones vivas; sin `loadSession` se deshabilita
la reapertura; sin `session/close` se recicla la conexión.

## Habilidades y bootstrap

`/skills` consulta `_goose/unstable/sources/list` con el directorio de trabajo.
Muestra descripción, ruta y contenido; separa skills del proyecto de las
incluidas con el agente. Un agente sin esa extensión muestra un estado vacío.
La lista de skills no reserva una sesión.

Para preparar el bootstrap sin aplicarlo:

```sh
node --env-file=.env scripts/bootstrap-memory.mjs \
  --repository https://github.com/FrankIsmael/acp-agent-ui.git \
  --branch main --output /tmp/memory-bootstrap.sh
```

Con `--apply`, ejecuta el script y registra `POST /sandboxes/:id/bootstrap`,
conservando cualquier bootstrap anterior. Clona en `/data/repo`, actualiza con
`fetch` + `checkout -B` y enlaza las skills a `/data/work`. Conserva `.agents`,
`.goose` y `.claude`; `.agents/skills` permite que las nuevas skills se escriban
dentro del repo. Si encuentra cambios sin commit, un directorio ajeno o un
origen distinto, se detiene para conservar ese trabajo.

El boot es asíncrono: verificar `metadata.eb_boot_last`, `eb_boot_exit` y
`eb_boot_err`; una respuesta de resume no demuestra que el script terminó.
Las skills que escriba el agente deben commitearse para sobrevivir a eliminar
la caja. El bootstrap no hace commits ni pushes automáticos.

Ghosty ya guarda sus sesiones en `/data/ghosty/data/sessions/sessions.db`.
Para Goose manual, añadir `--goose-service goose-acp.service`: instala un drop-in
con `XDG_DATA_HOME=/data/state` y migra la base del home mediante SQLite backup
con el agente detenido. Si encuentra ambas bases, exige reconciliarlas antes.
La ruta final es `/data/state/goose/sessions/sessions.db`. Cambiar `ACP_CWD` no
mueve la memoria.

## Respaldar y restaurar

```sh
node --env-file=.env scripts/backup-sessions.mjs \
  --database /data/ghosty/data/sessions/sessions.db
```

El script ejecuta `sqlite3.Connection.backup` dentro de la caja, incluyendo WAL,
y produce un archivo SQLite completo. Solicita un archivo **privado** a EasyBits
y entrega solamente el `putUrl` firmado a la caja. La llave de EasyBits permanece
fuera. Verifica integridad y conserva tamaño, SHA-256, conteos y `fileId` en un
manifiesto local privado dentro de `.memory-backups/` (ignorado por Git).
El `fileId` se guarda antes del upload y `uploaded` pasa a true al completarse.
No se guardan URLs firmadas en el manifiesto.

Para restaurar en una caja nueva:

```sh
node --env-file=.env scripts/restore-sessions.mjs \
  --box ID_CAJA_NUEVA \
  --database /data/ghosty/data/sessions/sessions.db \
  --service ghosty-lite-runtime.service \
  --manifest .memory-backups/ARCHIVO.json
```

También acepta `--file-id`. Con manifiesto se verifica además el SHA-256.
Descarga desde `readUrl`, valida SQLite y cuenta las filas antes de instalarlo.
Detiene el servicio, reemplaza la base y lo reinicia si estaba activo. Por
defecto rechaza una base existente; `--force` archiva la base anterior y sus
sidecars para poder recuperarla. Un error de instalación restaura esos archivos.
La pantalla nunca usa S3 para pintar el historial.

## Replay parcial

En hilos largos, Historial ofrece “Abrir solo los últimos turnos”. La URL usa
`?tail=40`; el adaptador Goose/Ghosty envía `_meta.replayTail` a `session/load`.
El chat indica que el historial es parcial y permite cargarlo completo cuando
no hay un turno en curso. El resto de los agentes sigue usando replay completo.

## Verificación

```sh
npm run typecheck
npm run build
npm run test:memory
npm run test:memory:backup
CHAT_TEST_BROWSER='/ruta/al/navegador' npm run test:chat:browser
```

Los fixtures verifican historial, replay, títulos, conexión compartida,
cancelación, reinicio, capacidades ausentes, skills, modelo sin sesión y replay
parcial. Las pruebas SQLite mantienen una conexión WAL abierta y comprueban
respaldo completo, upload privado, manifiesto, checksum, rechazo de sobrescritura,
restauración forzada y ciclo de vida del servicio. El navegador verifica Skills,
Historial, Chats, recarga y selección del modelo sin crear conversaciones.

Pruebas reales, ejecutadas el 9 de septiembre de 2026 (UTC) contra Ghosty Lite 1.48.0:

- Al matar **solo el servidor temporal de la app** después del primer carácter
  del asistente, el replay recuperó el mensaje del usuario, sin respuesta del
  asistente. Hilo de prueba: `20260909_3`.
- Al suspender y reanudar la caja en el mismo punto, ocurrió lo mismo. Hilo de
  prueba: `20260909_4`. La caja volvió a running y el bootstrap terminó con
  `eb_boot_exit=0`.
- Un hilo con tres turnos (`20260909_5`) repitió tres mensajes de usuario con
  load completo y solo uno con `replayTail=1`, junto con respuesta y uso.
- La raíz persistente de Ghosty se verificó en disco. El bootstrap enlazó el repo
  y sources/list devolvió la skill `react-router` y sus archivos de apoyo.

Estos resultados describen esas pruebas, no garantizan cuánto guardará cualquier
agente en cualquier punto de interrupción. El cliente no reenvía el prompt ni
promete reanudar la tarea automáticamente.

Los scripts `test-memory-live.mjs` y `test-replay-live.mjs` permiten repetir las
pruebas. `test-memory-live.mjs --suspend` suspende brevemente la caja configurada;
sin ese flag solo mata su propio proceso local. Generan conversaciones de prueba.

Pendiente de autorización explícita: subir la base real completa a un archivo
privado de EasyBits y verificar su restauración remota. El respaldo/restauración
ya está implementado y probado con bases locales de prueba; no se ha subido el
contenido de las conversaciones reales.
