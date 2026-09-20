# Muxentra

Extensión para VS Code que reúne pestañas, terminales en splits anidados y consumo de asistentes de IA en un solo espacio de trabajo.

## Instalación

En Windows, desde PowerShell:

```powershell
irm https://raw.githubusercontent.com/TU-USUARIO/muxentra/main/install.ps1 | iex
```

Baja el último release y lo instala en VS Code (también reconoce Cursor y Windsurf). El mismo comando actualiza: una extensión instalada desde un `.vsix` no se actualiza sola.

A mano, bajando el `.vsix` de la pestaña Releases:

```
code --install-extension muxentra-0.1.0.vsix
```

Después recarga la ventana (`Ctrl+Shift+P` > "Developer: Reload Window") y abre el panel con `Ctrl+Alt+T`.

## Qué hace

- Un panel "Muxentra" en el área de editores con su propia barra de pestañas.
- Cada pestaña contiene un árbol de splits: cualquier terminal se puede dividir a la derecha o hacia abajo, sin límite de anidamiento.
- Divisores arrastrables entre terminales y comando para igualar tamaños.
- Arrastra una terminal desde su cabecera: soltarla en el centro de otra las intercambia; soltarla cerca de un borde (izquierda, derecha, arriba, abajo) la mueve a ese lado. Escape cancela el arrastre.
- Cada terminal se puede renombrar (doble clic en su nombre o `Shift+F2`). El nombre puesto a mano gana sobre el título que reporta el shell y viaja con la terminal si la mueves. Dejarlo vacío vuelve al título automático.
- Cada pestaña se puede marcar con un color (clic derecho sobre la pestaña) para ubicarla de un vistazo.
- Cada terminal indica en qué anda: un punto azul latiendo mientras trabaja, una etiqueta verde "listo" cuando termina y una naranja "atención" cuando el programa pide algo. El punto se repite en la pestaña, el número de terminales que esperan sale en el título del panel y en la barra de estado de VS Code, y un aviso te ofrece ir a la terminal. Pensado para tener cuatro agentes corriendo y saber cuál te necesita.
- Barra inferior con el uso de Claude Code y de OpenAI Codex: porcentaje de cada ventana de límite y cuánto falta para que se reinicie. Clic para actualizar.
- Cada terminal muestra en su cabecera la rama de git del directorio en que está. Entiende worktrees, así que dos terminales en worktrees distintos muestran ramas distintas. En HEAD desacoplado muestra el sha corto resaltado.
- `Ctrl+Alt+V` pega imágenes: la imagen del portapapeles se guarda en `.muxentra-img/` dentro del proyecto y en la terminal se escribe su ruta, lista para dársela a un agente. Solo Windows.
- Al abrir el panel se crea un grupo dedicado a la derecha y se bloquea, para que los archivos sigan abriéndose en el editor principal. La posición se conserva al restaurar la ventana. Se desbloquea con el candado de VS Code o con la opción `muxentra.lockEditorGroup`.
- Las pestañas y su disposición se guardan por workspace.
- Los shells corren en un servidor de terminales aparte (proceso independiente de VS Code). Cerrar el panel, recargar la ventana o cerrar VS Code no los mata: al volver, cada terminal se reconecta a su proceso y muestra lo que tenía (Claude, Codex, un servidor de desarrollo, lo que estuviera corriendo). Si el servidor no está (primer uso, reinicio del equipo), se abren shells nuevos.
- "Muxentra: Cerrar todas las terminales" mata todos los procesos del servidor, incluidos los de otras ventanas.
- Usa el mismo shell que tu perfil por defecto de VS Code (`terminal.integrated.defaultProfile`), incluido Git Bash.
- Colores y fuente tomados del tema y de la configuración de la terminal integrada.

## Atajos (con el panel activo)

| Acción | Windows / Linux | macOS |
| --- | --- | --- |
| Abrir el panel (global) | `Ctrl+Alt+T` | `Cmd+Alt+T` |
| Nueva pestaña | `Ctrl+Shift+T` | `Cmd+T` |
| Pestaña siguiente / anterior | `Ctrl+Shift+]` / `Ctrl+Shift+[` | `Cmd+Shift+]` / `Cmd+Shift+[` |
| Renombrar pestaña | `F2` o doble clic | `F2` o doble clic |
| Renombrar terminal | `Shift+F2` o doble clic en su nombre | `Shift+F2` o doble clic |
| Color de la pestaña | clic derecho sobre la pestaña | clic derecho sobre la pestaña |
| Dividir a la derecha | `Ctrl+\` | `Cmd+\` |
| Dividir abajo | `Ctrl+Shift+\` | `Cmd+Shift+\` |
| Cerrar terminal | `Ctrl+Shift+W` (y `Ctrl+W` fuera del texto de la terminal) | `Cmd+W` |
| Terminal siguiente / anterior | `Ctrl+Alt+→` / `Ctrl+Alt+←` | `Cmd+Alt+→` / `Cmd+Alt+←` |
| Copiar / pegar | `Ctrl+Shift+C` / `Ctrl+Shift+V` (también `Ctrl+V`) | `Cmd+C` / `Cmd+V` |
| Pegar imagen del portapapeles | `Ctrl+Alt+V` | — |

"Muxentra: Igualar tamaño de terminales" y "Muxentra: Ir a la terminal que espera" están en la paleta de comandos sin atajo por defecto. Todos los atajos se pueden cambiar en Keyboard Shortcuts (VS Code los adapta a la distribución del teclado).

Cerrar la última terminal de una pestaña cierra la pestaña. Clic con la rueda sobre una pestaña la cierra.

## Configuración

- `muxentra.shellPath` y `muxentra.shellArgs`: shell explícito. Vacío usa el perfil por defecto de VS Code.
- `muxentra.fontFamily` y `muxentra.fontSize`: si están vacíos se toman de `terminal.integrated.*` o `editor.*`.
- `muxentra.scrollback`: líneas de historial por terminal.
- `muxentra.showUsage`: muestra u oculta la barra inferior de uso.
- `muxentra.agentStatus`: activa el seguimiento de estado de cada terminal.
- `muxentra.notifyOn`: cuándo avisa VS Code. `all` (por defecto) al terminar y al pedir atención, `attention` solo cuando el programa pide algo, `none` nunca.
- `muxentra.attentionSound`: pitido corto al pedir atención. Por defecto apagado.
- `muxentra.quietSeconds`: segundos de silencio tras los que una terminal ocupada se da por terminada. Por defecto 3.
- `muxentra.showBranch`: muestra u oculta la rama de git en cada terminal.
- `muxentra.lockEditorGroup`: bloquea el grupo de editores al abrir el panel.
- `muxentra.usageRefreshSeconds`: cada cuánto se relee el uso mientras el panel está visible.
- `muxentra.imagePasteDir`: carpeta donde se guardan las imágenes pegadas. Por defecto `.muxentra-img`. Tiene que quedar dentro del workspace.
- `muxentra.imagePasteMax`: cuántas imágenes pegadas se conservan. Por defecto 6.
- `muxentra.multiLinePasteWarning`: pide confirmación antes de pegar un texto de varias líneas. Por defecto activado.

`muxentra.shellPath` y `muxentra.shellArgs` tienen alcance `machine`: se fijan por máquina o por usuario y un repositorio no puede cambiarlos desde su `.vscode/settings.json`.

## De dónde sale el uso de Claude y Codex

Todo se lee del disco, en modo solo lectura, sin hacer llamadas de red ni usar credenciales.

- **Codex**: el último evento `rate_limits` del archivo de sesión más reciente en `~/.codex/sessions`, que trae el porcentaje usado de cada ventana y cuándo se reinicia.
- **Claude**: `~/.claude/vscode-claude-status-cache.json`, el cache que escribe la extensión de estado de Claude Code a partir de las cabeceras de límite de la API. Es la única fuente local con el porcentaje real del plan. Si no existe o está vieja, se muestran los tokens de las últimas 5 horas sumados de las transcripciones en `~/.claude/projects`.

Si una fuente no está disponible, ese elemento simplemente no aparece.

## Cómo sabe si una terminal trabaja, terminó o pide atención

No hace falta configurar nada ni instalar hooks: se deduce de lo que la terminal escribe en pantalla, así que funciona igual con Claude Code, Codex, Gemini CLI, aider, un build o un servidor de desarrollo.

- **Trabajando**: la terminal produce salida de forma sostenida, al menos tres ráfagas en dos segundos. Un agente pensando repinta su indicador varias veces por segundo. El eco de lo que escribes no cuenta.
- **Listo**: estaba trabajando y lleva `muxentra.quietSeconds` en silencio. Solo se marca si el trabajo duró más de cuatro segundos, para que un `ls` no avise.
- **Atención**: el programa lo pidió explícitamente, por la campana del terminal o por una secuencia de notificación de escritorio (`OSC 9` o `OSC 777`). La campana que cierra las secuencias de título no cuenta: se usa el parser de xterm, no una búsqueda de texto.

La etiqueta sale siempre, pero el aviso y la cuenta de terminales que esperan no: si tenías esa terminal delante cuando cambió de estado, se marca en silencio. Mirar una terminal la deja limpia, y escribir en ella también.

Para que Claude Code toque la campana en cuanto necesita permiso, pon `"preferredNotifChannel": "terminal_bell"` en `~/.claude/settings.json`. Codex hace lo propio con `tui.notifications` en `~/.codex/config.toml`. Sin eso, el estado se sigue detectando por la actividad, solo que el aviso llega cuando el agente calla en vez de en el instante en que pregunta.

El seguimiento vive en el panel: si lo cierras, no hay nada observando las terminales (los procesos siguen vivos igual).

## Cómo sabe la rama de cada terminal

El directorio de cada terminal se sigue por tres vías, en este orden: la secuencia `OSC 7` si el shell la emite, la variante `OSC 9;9` de ConEmu, y el título de la ventana (Git Bash pone ahí el directorio, como `MINGW64:/c/ruta`). Las rutas estilo MSYS, cygwin, `~` y `file://` se convierten a rutas del sistema.

Con ese directorio se lee `.git` directamente, sin ejecutar git: si es una carpeta se lee su `HEAD`, y si es un archivo (el caso de los worktrees) se sigue el `gitdir:` que contiene hasta el `HEAD` del worktree. Se revisa cada 5 segundos mientras el panel está visible, así que un `git checkout` se refleja solo.

Cuando un agente como Claude o Codex cambia el título de la ventana, se conserva el último directorio conocido de esa terminal.

## Pegar imágenes en la terminal

`Ctrl+Alt+V` guarda la imagen del portapapeles como PNG dentro del proyecto y escribe su ruta relativa en la terminal, lista para pasársela a un CLI como Claude Code. Funciona con capturas (`Win+Shift+S`), con "copiar imagen" del navegador y con archivos de imagen copiados desde el Explorador.

- La carpeta es `.muxentra-img/` en la raíz del workspace, configurable con `muxentra.imagePasteDir`.
- Se conservan las 6 imágenes más recientes (`muxentra.imagePasteMax`); al pegar una nueva se borran las más antiguas que sobren.
- Pegar dos veces la misma imagen no crea dos archivos: se compara el contenido y se reutiliza el que ya estaba, pegando su misma ruta.
- La carpeta se ignora escribiendo `.muxentra-img/` en `.git/info/exclude`: es una regla local del clon, así que no aparece como cambio del repositorio ni la ve el resto del equipo. En un worktree se escribe en el `.git` común.
- Solo Windows: la imagen se lee con `System.Windows.Forms.Clipboard` desde Windows PowerShell, que es el único que corre en modo STA.
- `Ctrl+Alt` es AltGr en los teclados latinoamericanos y españoles, pero AltGr+V no escribe ningún carácter, así que el atajo no quita nada. El resto de combinaciones de AltGr (`@`, `{`, `}`, `[`, `]`, `|`, `~`) siguen llegando a la terminal.

## Desarrollo

```
npm install
npm run build        # compila extensión y webview a dist/
npm run watch        # recompila al guardar
npm run typecheck    # tsc --noEmit
npm run package      # genera el .vsix
```

Con la carpeta abierta en VS Code, `F5` lanza una ventana de desarrollo con la extensión cargada. La configuración por defecto corre sin depurador (`noDebug`): en VS Code 1.136 a 1.138 el extension host se cae al arrancar (código 134) cuando se lanza con el depurador de js-debug adjunto, ver [microsoft/vscode#336233](https://github.com/microsoft/vscode/issues/336233). Para depurar usa la configuración "Depurar extensión" sabiendo que puede fallar al arrancar, o lanza desde consola:

```
code --extensionDevelopmentPath="<ruta-a-esta-carpeta>" --inspect-extensions=9333
```

y adjunta el depurador al puerto 9333. Los mensajes de diagnóstico de la extensión salen en la vista Output, canal "Muxentra".

### Publicar una versión para otros

```
npm run package
gh release create v0.1.0 muxentra-0.1.0.vsix --title v0.1.0 --notes "Qué cambió"
```

El `install.ps1` de la raíz siempre apunta al release más reciente, así que basta con subir el nuevo `.vsix` y avisar. Sube antes la `version` del `package.json`: el instalador usa `--force` y reinstala igual, pero sin cambiar el número nadie sabe qué versión tiene.

Con paquetes por plataforma (más livianos, y evita ofrecer en Linux algo que no funciona porque node-pty 1.1.0 no trae binario precompilado para Linux):

```
npx vsce package --target win32-x64
npx vsce package --target win32-arm64
npx vsce package --target darwin-x64
npx vsce package --target darwin-arm64
```

y se adjuntan los cuatro al mismo release; el instalador elige el de la máquina.

Antes de publicar nada, edita `$repo` en `install.ps1` con tu usuario y repositorio: mientras siga en `TU-USUARIO/…` el instalador se detiene con un error en vez de descargar algo raro. El instalador comprueba el SHA256 que GitHub publica para cada asset y no instala si no cuadra; si el release no trae ese dato, avisa y muestra el hash del archivo que bajó.

## Notas técnicas

- Backend: `node-pty` 1.1.0 (Node-API, trae binarios precompilados para Windows y macOS, en Linux se compila al instalar).
- Frontend: `@xterm/xterm` 6 dentro de un webview con `retainContextWhenHidden`.
- Servidor de terminales: `dist/server.js`, lanzado por la extensión con el propio ejecutable de VS Code en modo Node (`ELECTRON_RUN_AS_NODE`), desacoplado (`detached`). Escucha en un named pipe (Windows) o socket unix por usuario. Guarda hasta 1 MB de salida por terminal para reproducirla al reconectar. Se apaga solo tras 5 minutos sin terminales ni clientes. Su log está en `<globalStorage>/server.log` y se rota al llegar a 512 KB.

## Seguridad

Quien pueda hablar con el servidor de terminales puede abrir procesos con tu usuario, así que el canal está cerrado en los dos sentidos.

- **El token no se expone.** Es un secreto de 256 bits en `<globalStorage>/server-token`, con permisos 0600. Al servidor se le pasa la ruta del archivo, nunca el token como argumento: los argumentos de un proceso los lee cualquiera con `ps`.
- **El saludo es un reto-respuesta mutuo.** Cliente y servidor se demuestran que conocen el token con un HMAC-SHA256 sobre dos nonces, uno de cada parte. El token no viaja por el canal, y el cliente no manda nada (ni el entorno del shell, ni lo que tecleas) hasta que el servidor ha demostrado ser el suyo. Las pruebas se comparan en tiempo constante.
- **El nombre del canal es impredecible.** Se deriva del token, así que otro usuario de la máquina no puede adivinarlo para ocuparlo antes y hacerse pasar por el servidor. En Windows el espacio de nombres de los pipes es común a todo el sistema, y en Linux el socket vive en `XDG_RUNTIME_DIR` o en un directorio propio con permisos 0700, no suelto en `/tmp`.
- **Las conexiones se acotan.** Una conexión que no completa el saludo en 10 segundos se cierra, una línea sin terminar se corta al pasar de 4 KB antes de autenticar, y cualquier orden sin autenticar cierra la conexión.
- **Las rutas que llegan de la terminal se filtran.** El directorio de cada terminal lo reporta el shell con `OSC 7` o en el título, es decir, cualquier programa que esté corriendo ahí. Las rutas de red (`\\host\recurso`, `//host/x`, `file://host/x`) se descartan: en Windows basta con mirarlas para abrir una conexión SMB al host que diga el texto, que sirve para capturar el hash NTLM del usuario, y además bloquearía el extension host hasta que expire. Lo mismo se aplica al `gitdir:` de un archivo `.git`, que lo elige el repositorio que abras.
- **La extensión no funciona en modo restringido.** Declara `untrustedWorkspaces: false`, así que hasta que no confíes en la carpeta no se activa ni abre ningún shell.
- **El webview está encerrado.** `default-src 'none'`, scripts solo con un nonce aleatorio de 192 bits por carga, recursos limitados a `dist/`. No hay `eval` ni acceso de red desde la interfaz.
- **No se hace red ni se leen credenciales.** El consumo de Claude y Codex sale de archivos locales en modo solo lectura.
