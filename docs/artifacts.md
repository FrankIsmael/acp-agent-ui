# Artifacts

Pide una creación en cualquier chat, por ejemplo:

- «Crea una landing page para mi portafolio con HTML, CSS y JavaScript».
- «Diseña una ilustración SVG de una ciudad».
- «Escribe una propuesta de proyecto en Markdown».
- «Escribe un script de Python que convierta CSV a JSON».

El panel se abre en cuanto empieza a llegar el artifact. En escritorio comparte
el espacio con el chat; en pantallas pequeñas aparece como un cajón con manejo
de foco y cierre con Escape. Puedes cerrarlo durante la generación y reabrirlo
desde su tarjeta o el botón Artifacts. El selector permite cambiar entre archivos
y revisiones. Ampliar abre una vista grande.

Vista previa muestra páginas/apps HTML, gráficos SVG y documentos Markdown o
texto. Código/Editar permite modificar el contenido después de la generación;
los cambios aparecen en la vista previa. Restaurar original recupera la versión
del agente. Los demás lenguajes se pueden editar, copiar y descargar, pero no se
ejecutan. El editor es un textarea nativo con fuente monoespaciada, sin servicios
externos ni descarga de Monaco.

Compartir abre el menú de archivos del sistema cuando el navegador lo soporta;
en otros navegadores descarga el archivo para enviarlo. Descargar exporta el
contenido actual con su extensión. Esta versión no publica URLs públicas.

## Guardado local

La biblioteca `/artifacts`, accesible desde la navegación, guarda los archivos
y sus ediciones en `localStorage`, bajo `acp-artifacts-v1`. El formato es
`{ "version": 1, "artifacts": [...] }`. No requiere una base de datos. Los datos
pertenecen al navegador y origen actuales; no se sincronizan entre dispositivos
o pestañas. Borrar los datos del sitio elimina la biblioteca.

Cada archivo se identifica por conversación, turno y posición. Un nuevo turno
crea una revisión independiente, incluso si el agente reutiliza el identifier.
Las ediciones locales no se pisan con nuevos fragmentos de la respuesta.
Las ediciones manuales se guardan en la biblioteca; no se envían automáticamente
al agente como contexto de un nuevo prompt.
La biblioteca sigue funcionando después de reiniciar el servidor, aunque su
historial de conversaciones en memoria ya no exista. Los errores de cuota o
acceso a localStorage se muestran en el panel, y puedes descargar una copia.

## Protocolo del agente

`app/.server/artifact-instructions.ts` añade instrucciones a cada prompt ACP sin
alterar el mensaje visible del usuario. El agente debe incluir el archivo en su
respuesta, no solamente escribirlo con una herramienta:

```xml
<artifact identifier="portfolio" type="text/html" title="Mi portafolio" language="html">
<!doctype html>
<html><head><style>body { font-family: sans-serif; }</style></head>
<body><h1>Hola</h1><button onclick="this.textContent='¡Listo!'">Probar</button></body></html>
</artifact>
```

Tipos: `text/html`, `image/svg+xml`, `text/markdown`, `text/plain` y
`application/vnd.ant.code` con `language`. También se aceptan los alias HTML y
document de Anthropic. Las etiquetas deben ir sin cercas Markdown y sus atributos
entre comillas. El contenido permanece crudo: no se decodifican entidades XML.
El delimitador literal `</artifact>` se reserva al protocolo; si hace falta dentro
de un archivo, debe escaparse o construirse como una cadena concatenada.

El parser acepta aperturas/cierres divididos entre fragmentos, varias creaciones
en un turno y respuestas incompletas. No convierte bloques Markdown ordinarios
en artifacts. El cumplimiento del formato depende del modelo del agente.

## Vista previa aislada

Las páginas usan un iframe `srcDoc` con `sandbox="allow-scripts"`, sin
`allow-same-origin`. SVG usa un sandbox sin permisos de scripts. Se sigue el
[modelo de aislamiento de iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox).
La política CSP se inserta antes del contenido: permite scripts y estilos inline
para ejecutar la creación y bloquea recursos externos, fetch, formularios,
subframes, workers, objetos y cambios de URL base. El iframe no recibe acceso
al DOM, cookies o almacenamiento del chat, ni permisos de cámara o micrófono.
Como en cualquier iframe, esto no es un límite de CPU/memoria para scripts.

Las apps deben ser HTML autónomo con CSS/JavaScript incluidos e imágenes SVG
inline o data URLs. No hay bundler, paquetes npm, servidor backend, CDN ni APIs
externas. Un proyecto React/TypeScript se conserva como fuente editable; para
una app ejecutable, las instrucciones solicitan su equivalente en HTML autónomo.
La vista previa se actualiza como máximo cuatro veces por segundo y al recargarse
reinicia su estado interno. El botón Reiniciar permite hacerlo manualmente.

## Verificación

```sh
npm run test:artifacts
npm run typecheck
npm run build
```

Los tests cubren cada frontera de fragmento del protocolo, contenido mixto,
revisiones, ediciones, almacenamiento inválido, extensiones y CSP.

También hay una prueba de navegador contra un agente ACP simulado local. Después
de `npm run build`, configura `ARTIFACT_TEST_BROWSER` con la ruta del ejecutable
de Chrome, Chromium o Brave y ejecuta `npm run test:artifacts:browser`. Usa los
puertos locales 5197–5199, un perfil temporal y no llama al agente remoto. Verifica
streaming, aislamiento real del iframe, edición, recarga, biblioteca, Markdown,
SVG, código, descargas, errores de cuota y el cajón móvil. Los APIs de clipboard
y compartir del sistema se simulan para no modificar el clipboard ni abrir menús
nativos. Deja capturas de escritorio y móvil en el directorio temporal del sistema.

Para probar
manualmente, genera una app con un botón, edítala, recarga la página, ábrela desde
la biblioteca y repite con una pantalla móvil. Comprueba también copiar,
descargar, compartir y cerrar el panel antes de que termine la respuesta.
