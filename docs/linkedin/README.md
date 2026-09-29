# Muxentra: tres asistentes en un mismo espacio

Material para documentación y publicación en LinkedIn. Capturas reales de Muxentra en VS Code, tomadas el 29 de septiembre de 2026 con un perfil de demostración separado. La guía se publica con la versión 0.13.1.

## Capturas

Sube las imágenes en este orden:

1. [Claude Code, Codex y OpenCode](01-claude-codex-opencode.png): vista principal con los tres programas ejecutándose y sus respuestas reales.
2. [Consumo de IA](02-consumo.png): detalle de las cuotas de Claude, con la barra de Claude y Codex visible.
3. [Git integrado](03-git-integrado.png): historial y ramas del repositorio real dentro de Muxentra.

Los PNG se entregan a 1680 × 1050 píxeles. Las respuestas son ejemplos breves solicitados sin usar herramientas ni modificar archivos. Los porcentajes de consumo corresponden al momento de la captura y no representan un consumo fijo del producto. OpenCode no tiene tarjeta de consumo en esta versión.

## Videos

Dos versiones del mismo recorrido de 40 segundos, montadas a partir de estas tres capturas: [español](muxentra-demo.mp4) e [inglés](muxentra-demo-en.mp4). Son MP4 H.264 a 1920 × 1080 y 30 fps, sin audio. Los textos del video están traducidos, pero la interfaz que aparece en las capturas sigue en español. El README principal muestra la versión en inglés como [animación WebP](muxentra-demo-en.webp) enlazada al MP4.

## Cómo reproducir la distribución

### Preparar el entorno

Instala Muxentra siguiendo las [instrucciones del proyecto](../../README.md#installation). Necesitas VS Code 1.100 o posterior y una carpeta de confianza. Las capturas se hicieron en Windows.

Claude Code, Codex y OpenCode deben estar instalados y autenticados por separado. Muxentra utiliza los comandos disponibles en tu shell; no instala los asistentes ni incluye sus planes.

### Abrir las tres terminales

1. Abre tu proyecto y pulsa `Ctrl+Alt+T`.
2. Ejecuta `claude` en la primera terminal. Con `Shift+F2`, llámala **Claude Code**.
3. Pulsa `Ctrl+\` para dividir a la derecha. Ejecuta `codex` y nombra esa terminal **Codex**.
4. Desde la terminal de Codex, pulsa `Ctrl+Shift+\` para dividir abajo. Ejecuta `opencode` y nombra la tercera terminal **OpenCode**.
5. Pulsa `F2` para llamar **AI workspace** a la pestaña.
6. Arrastra los divisores o usa **Muxentra: Igualar tamaño de terminales** desde `Ctrl+Shift+P`.

La distribución resultante deja Claude Code a la izquierda, Codex arriba a la derecha y OpenCode abajo a la derecha. En macOS, consulta los [atajos equivalentes](../../README.md#shortcuts-with-the-panel-focused).

### Probar un ejemplo pequeño

En Claude Code:

```text
Sin herramientas ni cambios en archivos: en 5 líneas cortas propone la estructura de un tablero de tareas con React y TypeScript. Responde en español.
```

En Codex:

```text
Sin usar herramientas ni modificar archivos: en 5 líneas, enumera las pruebas esenciales de un tablero de tareas en React. Responde en español.
```

En OpenCode:

```text
Sin herramientas ni cambios en archivos: propone mejoras de accesibilidad para un tablero de tareas. Resume en 4 puntos cortos: teclado, foco visible, contraste y etiquetas claras. Responde en español.
```

Cada conversación es independiente. Estos ejemplos permiten mostrar las tres terminales sin que varios asistentes editen los mismos archivos.

### Consumo y Git

Haz clic en la tarjeta de Claude o Codex en la barra inferior para ver los datos disponibles y sus reinicios. Si una lectura no está disponible, la interfaz lo indica; no hace falta rellenarla manualmente.

Haz clic en el icono de Git junto al botón `+` para abrir el historial, las ramas, los cambios locales y los worktrees. Vuelve a **AI workspace** para recuperar la vista de terminales.

## Publicación

El [texto del post](post-linkedin.txt) está listo para copiar. Adjunta primero la imagen de los tres asistentes y después las de consumo y Git. Los archivos se prepararon localmente; la publicación queda a cargo del autor.

Texto alternativo sugerido para cada imagen:

1. «Muxentra en VS Code con Claude Code a la izquierda, Codex arriba a la derecha y OpenCode abajo a la derecha. Cada terminal muestra una respuesta sobre un tablero de tareas; debajo aparecen las cuotas de Claude y Codex».
2. «Las mismas tres terminales con el detalle del consumo de Claude abierto desde la barra inferior de Muxentra».
3. «Panel Git de Muxentra con el historial real del repositorio, sus ramas y los cambios locales, dentro del mismo espacio de trabajo».
