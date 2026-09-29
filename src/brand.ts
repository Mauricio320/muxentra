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

export function bootScreen(): string {
  return `<div id="boot" class="boot">
    <div class="boot-ambient" aria-hidden="true"><i></i><i></i></div>
    <span class="boot-corner" aria-hidden="true">MUXENTRA <span>/</span> WORKSPACE</span>
    <div class="boot-content">
      <div class="boot-scene" aria-hidden="true">
        <div class="boot-orbit orbit-outer"><i></i></div>
        <div class="boot-orbit orbit-inner"><i></i></div>
        <span class="boot-axis axis-x"></span><span class="boot-axis axis-y"></span>
        <div class="boot-mark">${brandMark('boot')}</div>
      </div>
      <span class="boot-kicker">ENCUENTRA TU FLOW</span>
      <h1>Muxentra<span>.</span></h1>
      <p class="boot-tagline">Todo conectado. Tú, en foco.</p>
      <div class="boot-loading">
        <div class="boot-progress" aria-hidden="true"><span id="boot-progress-fill"></span></div>
        <p id="boot-status" role="status" aria-live="polite">Conectando tu espacio de trabajo…</p>
        <div class="boot-steps" aria-hidden="true"><span id="boot-terminals">Terminales</span><span id="boot-git">Git</span><span id="boot-workspace">Tu espacio</span></div>
      </div>
      <button id="boot-skip" class="boot-skip" type="button" hidden>Entrar al espacio <span aria-hidden="true">↗</span></button>
    </div>
    <span class="boot-signature" aria-hidden="true">UN ESPACIO. TODAS TUS IDEAS.</span>
  </div>`;
}
