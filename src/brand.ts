/** Local, script-free identity shared by the host and both webview surfaces. */
export function brandMark(id: 'boot' | 'toolbar' | 'git'): string {
  return `<svg class="muxentra-mark" viewBox="0 0 256 256" fill="none" aria-hidden="true">
    <defs><linearGradient id="${id}-flow" x1="42" y1="100" x2="214" y2="150" gradientUnits="userSpaceOnUse">
      <stop stop-color="#79d4d3"/><stop offset=".5" stop-color="#ab9ce8"/><stop offset="1" stop-color="#f7ad8a"/>
    </linearGradient></defs>
    <path class="mark-track" d="M48 180 C56 149 64 103 76 77 C83 62 95 61 103 79 C114 105 118 139 128 139 C138 139 143 105 154 79 C162 61 174 62 181 77 C193 103 201 149 209 180"/>
    <path class="mark-flow" pathLength="1" stroke="url(#${id}-flow)" d="M48 180 C56 149 64 103 76 77 C83 62 95 61 103 79 C114 105 118 139 128 139 C138 139 143 105 154 79 C162 61 174 62 181 77 C193 103 201 149 209 180"/>
  </svg>`;
}

/**
 * Saludo de apertura. Dura lo que tarda la M en dibujarse y se va solo en
 * cuanto las terminales de la pestaña activa responden; nunca gatea el uso.
 * El texto de carga y el botón de entrar solo aparecen si algo tarda.
 */
export function bootScreen(): string {
  return `<div id="boot" class="boot">
    <div class="boot-glow" aria-hidden="true"></div>
    <div class="boot-content">
      <div class="boot-scene" aria-hidden="true">
        <span class="boot-ring"></span>
        <div class="boot-mark" id="boot-mark">${brandMark('boot')}</div>
      </div>
      <p class="boot-name" aria-hidden="true">Muxentra</p>
      <div class="boot-loading" id="boot-loading" hidden>
        <div class="boot-progress" aria-hidden="true"><span id="boot-progress-fill"></span></div>
        <p id="boot-status" role="status" aria-live="polite"></p>
        <button id="boot-skip" class="boot-skip" type="button" hidden>Entrar ahora</button>
      </div>
    </div>
  </div>`;
}
