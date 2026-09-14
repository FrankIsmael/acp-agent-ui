# Extensiones y permisos

`/extensions` permite guardar servidores MCP HTTP o stdio, activarlos, desactivarlos
y eliminarlos. Las declaraciones de este cliente se guardan en SQLite, en
`.data/extensions.db` o la ruta indicada por `ACP_EXTENSIONS_DB`. Se usa `node:sqlite`,
incluido en Node 24, sin dependencias adicionales. Cada alta, cambio de estado y borrado
modifica una fila mediante consultas parametrizadas.

`GET /api/extensions` devuelve la lista completa. Todas las mutaciones usan
`POST /api/extensions` con campos de formulario e `intent`: `add`, `remove`,
`set-enabled`, `session-add` o `session-remove`. La respuesta siempre incluye
`extensions`, `session`, `ok` y `error`, también para errores de validación.
Las listas omiten las credenciales y llevan `Cache-Control: no-store`.
`extensions.tsx` consume esa respuesta directamente para pintar el resultado,
sin revalidar loaders ni consultar la lista otra vez.

Las extensiones activadas se envían como `mcpServers` en `session/new` y `session/load`;
el servidor registra `[acp] mcpServers: …` en cada arranque de sesión. Si el agente no
abre la sesión en `ACP_SESSION_TIMEOUT_MS` (60 s por omisión) —una extensión que no
arranca lo bloquea— la petición falla y el mensaje nombra las extensiones activas.
El comando stdio se ejecuta en la máquina del agente, sin `PATH`: va con ruta absoluta
(`/usr/local/bin/node`, no `node`); el formulario lo exige. Para servidores HTTP que
piden credencial conviene ponerla en la URL (`?token=…`) y no en cabeceras: al menos
goose, ante un 401 con `WWW-Authenticate: Bearer resource_metadata=…`, arranca un flujo
OAuth en vez de mandar `Authorization`, y la sesión se queda colgada hasta el timeout.
La base de datos es la misma tabla que usó la rama `sesion-4-mcp` (`id` UUID, `name`
único, una columna por campo): un archivo escrito en cualquiera de las dos ramas se lee
en la otra. La base guarda también las variables
y cabeceras necesarias para conectarse; el archivo se crea con permisos `0600` y no se
incluye en Git ni en la imagen Docker. En despliegues, configura `ACP_EXTENSIONS_DB`
dentro de un volumen persistente. Para respaldarla en caliente usa una copia consistente
de SQLite, no copies únicamente el archivo principal mientras haya escrituras WAL.

La sección de conversación activa permite conectar una extensión guardada o retirarla
sólo de ese hilo. Los cambios de herramientas esperan a que termine el turno; también
se puede detener desde el chat. Desactivar o borrar una declaración local no retira una
herramienta ya conectada: se retira desde la sección de conversación activa. No se crea
una conversación al consultar extensiones, y se pueden guardar sin conexión al agente.

Las operaciones de sesión usan `_goose/unstable/session/extensions/list`, `/add` y
`/remove`. Contra goose real: `list` devuelve cada extensión plana (sin `extensionKey`),
así que se identifica por `server.name`/`name`, y `remove` recibe `{ name }`; la API
acepta como `configKey` tanto el id del cliente como ese nombre. El cliente no modifica la configuración global de Goose ni importa sus
extensiones automáticamente. Las credenciales sólo se envían al agente al conectar;
no se devuelven en las listas de la web. El almacenamiento del resto de la aplicación
permanece igual.

Cuando el agente envía `session/request_permission`, el turno espera una decisión en
el chat. Se muestran las opciones del agente, incluida la posibilidad de recordar una
decisión si éste la ofrece. La app nunca elige una opción automáticamente. Qué
operaciones requieren permiso depende del modo y las políticas del agente; el selector
de configuración del chat permite cambiar los modos que éste publique.

Los permisos no tienen timeout automático. Sobreviven a una recarga o desconexión del
navegador mientras siga vivo el servidor. Detener el turno, cerrar la conversación o
perder la conexión ACP cancela sus permisos. Reiniciar el servidor no conserva una
solicitud pendiente ni la aprueba. La primera decisión válida gana entre varias pestañas.

La API independiente del cliente web es:

- `GET /api/conversations/:id/permissions`: permisos pendientes de la conversación activa.
- `POST /api/conversations/:id/permissions` con `{ "permissionId": "…", "optionId": "…" }`:
  decide una solicitud concreta. Devuelve 400 para opciones inválidas, 404 si el hilo
  no está activo y 409 si la solicitud ya se resolvió o canceló.
- El SSE del chat incluye `permissions` en el snapshot y emite `permissions` cuando cambia.

Se mantiene el límite de la especificación: no hay usuarios; quien tenga acceso a la app
puede configurar herramientas y decidir permisos. Las nuevas mutaciones rechazan
solicitudes de otro origen. WhatsApp queda fuera de esta implementación.

Verificación local, sin llamadas a un modelo ni cambios en un agente real:

```sh
npm run typecheck
npm run build
npm run test:permissions
npm run test:memory
```

Para incluir la prueba de navegador, define `PERMISSION_TEST_BROWSER` con la ruta de
Chrome, Chromium o Brave antes de ejecutar `npm run test:permissions`.
