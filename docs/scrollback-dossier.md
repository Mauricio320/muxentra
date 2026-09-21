# Dossier: historial duplicado y scroll corto con agentes TUI

## Corrección del diagnóstico y de la implementación (2026-09-20)

Las conclusiones originales que atribuyen toda la duplicación a los agentes
deben leerse como hipótesis superadas por la comparación de los dos backends.
La sonda original no contaba `ESC[H`, heredaba `TERM` del entorno y no respondía
consultas de terminal. Medía bytes, no el resultado de interpretarlos.

La sonda corregida usa xterm 6, responde DSR/DA, fija `TERM=xterm-256color` y mide
el buffer renderizado. Se compararon `useConptyDll=false` y `true`, con la DLL
1.23.2510.08001 que ya incluye node-pty 1.1.0. No se enviaron prompts.

- Programa estático: el ConPTY del sistema retransmite 29 líneas después de
  estrechar, pero `ESC[H` permite conservar exactamente 1000 líneas únicas.
  La DLL no retransmite contenido al estrechar. Bytes repetidos no implican
  por sí solos historial duplicado.
- Claude, pantalla inicial de confianza: el backend del sistema pasa de una a
  dos apariciones de la cabecera al reducir la altura. Con la DLL conserva una,
  y llegan pantalla alternativa, posicionamiento y secuencias del ratón.
  No se aceptó la confianza ni se verificó una conversación de Claude.
- Codex, `resume --last` de la sesión disponible: el sistema deja `baseY=0` al
  arrancar y `baseY=10` tras reducir altura. Con la DLL hay 59 líneas de historial
  al arrancar, 69 tras reducir altura y 78 al estrechar. El resize transmite
  `ED2`, `ED3` y regiones de scroll; con el backend del sistema no llegaban.
  Esta sesión no es la transcripción larga citada más abajo.

Cambios actuales:

- ConPTY incluido habilitado por defecto en terminales nuevas de Windows.
  `rebuildAwareScrollback=false` vuelve al backend del sistema. Se informa a
  xterm de la capacidad del backend real, no solo del build de Windows.
- Eliminado el borrado heurístico por número de líneas.
- `TerminalState` conserva estado VT y hasta las líneas configuradas de
  historial, en lugar de recortar un registro ANSI a 1 MB. El snapshot incluye
  buffers, cursor, modos, región de scroll y prefijos ANSI aún incompletos.
- Salida, snapshots y resize se ordenan; la salida se agrupa mientras espera al
  parser para evitar latencia por cada fragmento. El webview retiene la salida
  nueva hasta terminar de restaurar y no devuelve respuestas del replay al PTY.
- Attach no redimensiona el proceso. Se restaura con sus dimensiones originales
  y solo después se ajustan paneles visibles; los ocultos conservan su tamaño.
- Se mantiene compatibilidad con el servidor anterior sin matar sesiones para
  actualizarlo. La extensión avisa cuando sigue conectada a ese servidor.

Validación reproducible: `npm run typecheck`, `npm run build` y
`npm run test:terminal`. La regresión usa un servidor y un PTY independientes:
15.000 líneas y más de 1 MB, salida normal tras resize, pantalla alternativa,
ANSI partido entre chunks, barrera del snapshot y tres reconexiones conservando
1000 líneas únicas y el tamaño. Falta revisión visual dentro de VS Code.

## Investigación anterior (conservar como referencia histórica)

Estado al 2026-09-20. Escrito para quien retome este problema (persona o modelo) sin contexto previo. Todo lo que dice "medido" se obtuvo con `tools/pty-probe.cjs` en esta máquina (Windows 10, Codex 0.155.0, Claude Code 2.1.278).

## Síntoma

Con Codex o Claude Code corriendo dentro de Muxentra, al subir por el historial aparecen bloques repetidos (la cabecera "Claude Code v2.1.278" once veces seguidas; párrafos enteros de la transcripción de Codex varias veces) y el historial útil es corto: solo se puede subir un poco.

## Arquitectura relevante

- Webview: `src/webview/main.ts` con `@xterm/xterm` 6.0.0, `@xterm/addon-webgl` 0.19.0, `@xterm/addon-fit` 0.11.0. Un `Terminal` por panel (`Pane`).
- Extension host: `src/panel.ts`. Recibe la salida del servidor y la reenvía al webview agrupada por tick (`enqueue`/`flush`).
- Servidor de terminales aparte: `src/server/server.ts` (node-pty 1.1.0, named pipe). Guarda hasta 1 MB de salida por terminal (`MAX_BUFFER_CHARS`) y la reproduce entera en cada `attach` (`term.chunks.join('')`). Ese buffer acumula todo lo que el programa escribió alguna vez, copias incluidas.
- Camino de la salida: pty -> servidor (buffer) -> host (`onData` -> `enqueue`) -> webview (`case 'data'` -> `holdForRebuild` -> `writeKeepingView` -> `term.write`).
- Camino del resize: `ResizeObserver` -> `scheduleFit` (debounce 120 ms) -> `fit.fit()` -> `term.onResize` -> `armRebuildWatch` + `post resize` -> host -> `server.resize()` (no-op si cols/rows no cambian) -> SIGWINCH al programa.
- Reconexión: `startPane(termId, attach=true)` -> `attach` con cols/rows medidos si el panel está abierto (si no, 80x24) -> el servidor responde `attached` con todo el buffer en un solo mensaje `data` y aplica `resize`.

## Hechos medidos

### Codex 0.155

- Tras cada cambio de tamaño, de alto o de ancho, vuelve a escribir la transcripción completa en la terminal: 829 KB, 14.737 líneas, 1.211 apariciones de frases del texto real, en 3 s; cero bytes en reposo. Llega en unos 520 trozos de 29 líneas, el primero 1 ms después del resize, hueco máximo entre trozos 69 ms, todo en unos 340 ms.
- No borra antes: cero `ESC[3J`, cero `ESC[2J` (solo uno al arrancar), cero regiones de scroll (DECSTBM), cero `ESC[L`/`ESC[S`. Es decir, anexa una copia nueva cada vez.
- Nada de su configuración lo cambia. Probado por `-c` (los overrides llegan; verificado con `model`): `tui.animations=false`, `features.terminal_resize_reflow=false`, `tui.terminal_resize_reflow.max_rows=200` y `NO_ALT_SCREEN=1`: bytes idénticos.
- `tui.alternate_screen="always"` no tiene efecto en el chat: nunca emite `ESC[?1049h` ahí, solo en overlays (transcripción con Ctrl+T). Issue abierto: openai/codex#24552. No captura el ratón (sin `?1000h/?1002h/?1006h`); activa `?2026` (salida sincronizada) en cada frame y `?1007` en el overlay.
- Codex ofrece `/raw` (`tui.raw_output_mode`), pero según su PR #20819 la reconstrucción en resize se mantiene igual; solo cambia el formato del texto.

### Claude Code 2.1.278

- Tras cada cambio de tamaño reescribe su interfaz completa: unas 58 líneas, cada una precedida de `ESC[K` (borrar línea), sin `ESC[nA` (cursor arriba), sin posicionamiento absoluto `ESC[r;cH`, sin regiones de scroll, sin `ESC[2J`. Es decir, la copia anterior no se sobrescribe: cada resize deja una copia más en el historial. En la captura del usuario había 11 cabeceras, una por cada resize o reconexión del día.
- La sonda se quedó en la pantalla "Accessing workspace" (diálogo de confianza de carpeta) porque el pty no es interactivo; el comportamiento de reescritura se midió sobre esa pantalla, no sobre el chat. Conviene repetir la medición con una sesión ya confiada para confirmar que el chat hace lo mismo (la captura del usuario sugiere que sí).

### xterm.js 6.0.0

- `ESC[2J` dentro de un bloque `?2026` devuelve la vista al final aunque el usuario esté leyendo historial (xtermjs/xterm.js#5801, abierto). Cualquier resize hace lo mismo.
- La barra de scroll ya no es la nativa: es `.xterm-scrollable-element > .scrollbar` (copiada de VS Code) y se desvanece al no usarse.
- addon-webgl 0.19.0 tiene un defecto de atlas: glifos mal pintados tras hacer scroll; corregido solo en 0.20.0-beta (requiere xterm 6.1.0-beta).
- Con salida sincronizada activa, `RenderService` retiene los refrescos en `SynchronizedOutputHandler` hasta `?2026l` o un timeout de 1 s.

## Lo que ya está hecho (no repetir)

1. `server.ts` `resize()`: no manda SIGWINCH si cols/rows no cambian (antes cada attach lo mandaba y el programa repintaba encima del replay).
2. `scheduleFit`: un solo ajuste 120 ms después del último cambio de tamaño (antes, uno por fotograma al arrastrar).
3. `writeKeepingView` / `readingPosition` / `restoreReadingPosition`: si el usuario lee historial y una escritura o un fit devuelve la vista al final, se vuelve a su línea, salvo que haya movido la rueda o la barra entre medias (`pane.userScroll`).
4. `holdForRebuild` (ajuste `muxentra.rebuildAwareScrollback`, por defecto activo): tras un resize propio (ventana 2 s) o una reconexión (4 s) la salida se retiene hasta 120 ms; si en ese lapso suman 250 líneas se considera reescritura, se hace `term.clear()` cuando xterm ha vaciado su cola (`term.write('', cb)`) y luego se escribe lo retenido. Queda una sola copia. Umbral calibrado para Codex. **No cubre a Claude**: sus 58 líneas por resize quedan por debajo de 250.
5. Historial por defecto 20.000 líneas (`muxentra.scrollback`), para que quepa una transcripción de Codex entera.
6. Barra de scroll visible a media opacidad cuando hay historial, entera al pasar el ratón; colores de `scrollbarSlider` del tema.
7. README: sección de problemas con Ctrl+T para leer la respuesta que Codex está escribiendo.

## Pistas para seguir

- Claude Code: cada resize anexa ~58 líneas iguales a las últimas ~58 del búfer. Bajar el umbral de 250 a menos de 58 daría falsos positivos con salida normal justo tras un resize (un `ls` largo). Alternativas: comparar el texto de la ráfaga con las últimas N líneas del búfer previas al resize y, si coinciden, tratarla como repintado (xterm no permite borrar líneas sueltas del historial; habría que decidir qué hacer con la copia vieja); o reducir los resizes que le llegan.
- Resizes evitables: al reconectar, un panel que no está visible manda `attach` con 80x24 y luego, al mostrarse, un `resize` real: eso es un SIGWINCH y una copia extra por cada terminal en pestañas de fondo, en cada recarga. Persistir el último cols/rows por terminal (por ejemplo en `workspaceState`, junto al layout) y usarlo en el `attach` cuando el panel no se puede medir eliminaría esas copias. Probablemente es la mejora de mejor relación coste/beneficio que queda.
- El buffer de replay del servidor conserva todas las copias antiguas y las reproduce en cada reconexión; `holdForRebuild` limpia al recibirlo, pero lo que reproduce ya trae los duplicados internos. Compactarlo es complejo (es texto crudo con secuencias); mejor evitar que se generen.
- Upstream: el arreglo de fondo es de las aplicaciones. Codex debería borrar (`ESC[3J`) o no reescribir; Claude Code debería sobrescribir su interfaz en vez de anexarla. Issues relacionados: openai/codex#14277, #35335, #24552; xtermjs/xterm.js#5801.

## Cómo reproducir y verificar

1. `npm run build`; F5 con la configuración "Ejecutar extensión (sin depurador)" (con depurador el extension host se cae en VS Code 1.136-1.138). Si se tocó `src/server/server.ts`, matar el servidor viejo, que sobrevive a las recargas:
   `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*dist\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
2. Abrir un proyecto, `Ctrl+Alt+T`, lanzar `claude` (o `codex`) en un panel, pedir un texto largo, arrastrar un divisor varias veces, cerrar y reabrir el panel, recargar la ventana. Subir con la rueda: la cabecera de Claude debe aparecer una sola vez y la transcripción de Codex una sola vez.
3. Medir sin VS Code: `node tools/pty-probe.cjs codex resume --last` con `PROBE_TEXT='Mart[ií]n|Tom[áa]s'` para distinguir reescritura de animación; `node tools/pty-probe.cjs cmd.exe /c claude`. La sonda no manda entrada, así que no gasta cuota.

## Restricciones

- Windows 10, VS Code 1.138, Node 24. xterm 6.0.0 y addon-webgl 0.19.0 fijados (subir a las betas es una decisión aparte). TypeScript strict, sin tests automatizados; `npm run typecheck` y `npm run build` deben pasar.
- Mantener `muxentra.rebuildAwareScrollback` desactivable y no introducir heurísticas que puedan borrar historial de programas normales.
- Los commits van sin línea `Co-Authored-By`.
