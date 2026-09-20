import { Terminal, type ITerminalOptions, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import type {
  HostMessage,
  LayoutNode,
  MuxentraCommand,
  PaneActivity,
  SplitDir,
  SplitNode,
  TabState,
  TermSettings,
  UsageItem,
  UsageSnapshot,
  WebviewMessage,
  WorkspaceLayout,
} from '../protocol';
import * as L from './layout';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const api = acquireVsCodeApi();
const post = (message: WebviewMessage): void => api.postMessage(message);

type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

interface DragState {
  source: string;
  header: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  target?: string;
  zone?: DropZone;
  overlay: HTMLElement;
  ghost: HTMLElement;
}

interface Pane {
  termId: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  mount: HTMLElement;
  titleEl: HTMLElement;
  branchEl: HTMLElement;
  stateEl: HTMLElement;
  observer: ResizeObserver;
  opened: boolean;
  started: boolean;
  fitPending: boolean;
  rendererStarted: boolean;
  /** Último título reportado por el shell; el nombre manual tiene prioridad. */
  autoTitle: string;
  /** Último directorio avisado al host, para no repetir el mensaje. */
  lastCwd: string;
  /** Estado de trabajo deducido de la salida. */
  activity: PaneActivity;
  /** Marcas de tiempo del seguimiento de actividad. */
  busySince: number;
  lastOutput: number;
  lastInput: number;
  /** Instante hasta el que se ignora la salida (replay al reconectar). */
  ignoreUntil: number;
  /** Ticks de 200 ms con salida dentro de la ventana reciente. */
  ticks: number[];
  quietTimer?: number;
}

const ICONS = {
  splitRight:
    '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><line x1="8" y1="2.5" x2="8" y2="13.5"/></svg>',
  splitDown:
    '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><line x1="1.5" y1="8" x2="14.5" y2="8"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  add: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
  rename: '<svg viewBox="0 0 16 16"><path d="M11 2.5l2.5 2.5-7 7L4 12.5l.5-2.5z"/></svg>',
  branch:
    '<svg viewBox="0 0 16 16"><circle cx="4.5" cy="3.5" r="1.8"/><circle cx="4.5" cy="12.5" r="1.8"/><circle cx="11.5" cy="5.5" r="1.8"/><path d="M4.5 5.3v5.4M11.5 7.3c0 2.2-1.9 3.2-4.2 3.6"/></svg>',
  claude:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v2h3v3h2v6h-3v3h-2v2h-2v-4H9v4H7v-2H5v-3H2V9h2V6h3V4Zm2 5v2h2V9H9Zm4 0v2h2V9h-2Z"/></svg>',
  codex:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 5.1 12 2l5.4 3.1 3.1 5.4v6.2L15.1 20H8.9l-5.4-3.3v-6.2L6.6 5.1Zm2.8 3.4L6.8 12l2.6 3.5 1.5-1.1L9.1 12l1.8-2.4-1.5-1.1Zm4.7 6.8h3.5v-1.9h-3.5v1.9Z"/></svg>',
  clock:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.8v3.5l2.4 1.4"/></svg>',
  bell:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2a3.6 3.6 0 0 0-3.6 3.6c0 3-1.2 4-1.2 4h9.6s-1.2-1-1.2-4A3.6 3.6 0 0 0 8 2.2Z"/><path d="M6.9 12.1a1.3 1.3 0 0 0 2.2 0"/></svg>',
  check:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l3 3 6-6.8"/></svg>',
  refresh:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.1 5.7A5.4 5.4 0 1 0 13 10.6"/><path d="M10.2 5.7h3.2V2.5"/></svg>',
};

/** Paleta de colores para marcar pestañas. */
const TAB_COLORS: { key: string; name: string; value: string }[] = [
  { key: 'red', name: 'Rojo', value: '#f14c4c' },
  { key: 'orange', name: 'Naranja', value: '#e8a33d' },
  { key: 'yellow', name: 'Amarillo', value: '#e5c07b' },
  { key: 'green', name: 'Verde', value: '#23d18b' },
  { key: 'cyan', name: 'Cian', value: '#29b8db' },
  { key: 'blue', name: 'Azul', value: '#3b8eea' },
  { key: 'purple', name: 'Morado', value: '#b180d7' },
  { key: 'pink', name: 'Rosa', value: '#d670d6' },
];

const colorValue = (key: string | undefined): string | undefined =>
  key ? TAB_COLORS.find(c => c.key === key)?.value : undefined;

const state: WorkspaceLayout = { tabs: [], activeTabId: '', nextTabNumber: 1 };
const panes = new Map<string, Pane>();
const contents = new Map<string, HTMLElement>();
let settings: TermSettings = {
  fontFamily: 'monospace',
  fontSize: 14,
  letterSpacing: 0,
  lineHeight: 1,
  fontWeight: 'normal',
  fontWeightBold: 'bold',
  scrollback: 5000,
  cursorBlink: true,
  platform: 'linux',
  windowsBuildNumber: 0,
  agentStatus: true,
  quietSeconds: 3,
  attentionSound: false,
};
let theme: ITheme = buildTheme();

const tabbarEl = document.getElementById('tabbar') as HTMLElement;
const contentEl = document.getElementById('content') as HTMLElement;
const usageEl = document.getElementById('usage') as HTMLElement;

// ---------------------------------------------------------------- estado

const activeTab = (): TabState | undefined => state.tabs.find(t => t.id === state.activeTabId);
const tabOf = (termId: string): TabState | undefined =>
  state.tabs.find(t => L.leaves(t.root).some(l => l.termId === termId));
const activePane = (): Pane | undefined => {
  const tab = activeTab();
  return tab ? panes.get(tab.activeTermId) : undefined;
};

let persistTimer: number | undefined;
function persist(): void {
  if (persistTimer !== undefined) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = undefined;
    post({ type: 'layout', layout: structuredClone(state) });
  }, 150);
}

// ---------------------------------------------------------------- tema y opciones

function cssVar(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || undefined;
}

function buildTheme(): ITheme {
  const pick = (names: string[], fallback: string): string => {
    for (const name of names) {
      const value = cssVar(name);
      if (value) return value;
    }
    return fallback;
  };
  const ansi = (name: string, fallback: string): string => pick([`--vscode-terminal-ansi${name}`], fallback);
  return {
    background: pick(['--vscode-terminal-background', '--vscode-panel-background', '--vscode-editor-background'], '#1e1e1e'),
    foreground: pick(['--vscode-terminal-foreground', '--vscode-editor-foreground'], '#cccccc'),
    cursor: pick(['--vscode-terminalCursor-foreground', '--vscode-terminal-foreground', '--vscode-editor-foreground'], '#ffffff'),
    cursorAccent: pick(['--vscode-terminalCursor-background', '--vscode-terminal-background', '--vscode-editor-background'], '#000000'),
    selectionBackground: pick(['--vscode-terminal-selectionBackground', '--vscode-editor-selectionBackground'], '#264f78'),
    selectionInactiveBackground: pick(
      ['--vscode-terminal-inactiveSelectionBackground', '--vscode-editor-inactiveSelectionBackground'],
      '#3a3d41',
    ),
    black: ansi('Black', '#000000'),
    red: ansi('Red', '#cd3131'),
    green: ansi('Green', '#0dbc79'),
    yellow: ansi('Yellow', '#e5e510'),
    blue: ansi('Blue', '#2472c8'),
    magenta: ansi('Magenta', '#bc3fbc'),
    cyan: ansi('Cyan', '#11a8cd'),
    white: ansi('White', '#e5e5e5'),
    brightBlack: ansi('BrightBlack', '#666666'),
    brightRed: ansi('BrightRed', '#f14c4c'),
    brightGreen: ansi('BrightGreen', '#23d18b'),
    brightYellow: ansi('BrightYellow', '#f5f543'),
    brightBlue: ansi('BrightBlue', '#3b8eea'),
    brightMagenta: ansi('BrightMagenta', '#d670d6'),
    brightCyan: ansi('BrightCyan', '#29b8db'),
    brightWhite: ansi('BrightWhite', '#ffffff'),
  };
}

function terminalOptions(): ITerminalOptions {
  return {
    cursorBlink: settings.cursorBlink,
    customGlyphs: true,
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    letterSpacing: settings.letterSpacing,
    lineHeight: settings.lineHeight,
    fontWeight: settings.fontWeight,
    fontWeightBold: settings.fontWeightBold,
    scrollback: settings.scrollback,
    theme,
    windowsPty:
      settings.platform === 'win32' ? { backend: 'conpty', buildNumber: settings.windowsBuildNumber } : undefined,
  };
}

function applyTheme(): void {
  theme = buildTheme();
  for (const pane of panes.values()) pane.term.options.theme = theme;
}

async function applySettings(next: TermSettings): Promise<void> {
  const wasEnabled = settings.agentStatus;
  settings = next;
  if (wasEnabled && !next.agentStatus) {
    for (const pane of panes.values()) {
      if (pane.quietTimer !== undefined) window.clearTimeout(pane.quietTimer);
      pane.quietTimer = undefined;
      setActivity(pane, 'idle');
    }
  }
  try {
    await document.fonts.load(`${next.fontWeight} ${next.fontSize}px ${next.fontFamily}`, '█▄▀');
    await document.fonts.ready;
  } catch {
    // Si la fuente no expone FontFace, xterm conserva la alternativa del sistema.
  }
  for (const pane of panes.values()) {
    pane.term.options.fontFamily = next.fontFamily;
    pane.term.options.fontSize = next.fontSize;
    pane.term.options.letterSpacing = next.letterSpacing;
    pane.term.options.lineHeight = next.lineHeight;
    pane.term.options.fontWeight = next.fontWeight;
    pane.term.options.fontWeightBold = next.fontWeightBold;
    pane.term.options.scrollback = next.scrollback;
    pane.term.options.cursorBlink = next.cursorBlink;
  }
  fitVisible();
}

// ---------------------------------------------------------------- panes

function iconButton(svg: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'icon-btn';
  button.title = title;
  button.innerHTML = svg;
  button.addEventListener('mousedown', ev => ev.preventDefault());
  button.addEventListener('click', ev => {
    ev.stopPropagation();
    onClick();
  });
  return button;
}

function ensurePane(termId: string): Pane {
  const existing = panes.get(termId);
  if (existing) return existing;

  const term = new Terminal(terminalOptions());
  const fit = new FitAddon();
  term.loadAddon(fit);

  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.termId = termId;

  const header = document.createElement('div');
  header.className = 'pane-header';
  const titleEl = document.createElement('span');
  titleEl.className = 'pane-title';
  titleEl.textContent = 'Terminal';
  titleEl.addEventListener('dblclick', ev => {
    ev.stopPropagation();
    beginPaneRename(termId);
  });
  const branchEl = document.createElement('span');
  branchEl.className = 'pane-branch';
  branchEl.hidden = true;

  const stateEl = document.createElement('button');
  stateEl.className = 'pane-state';
  stateEl.type = 'button';
  stateEl.hidden = true;
  stateEl.addEventListener('click', ev => {
    ev.stopPropagation();
    focusPane(termId);
  });
  stateEl.addEventListener('pointerdown', ev => ev.stopPropagation());

  const actions = document.createElement('span');
  actions.className = 'pane-actions';
  actions.append(
    iconButton(ICONS.rename, 'Renombrar terminal (Shift+F2 o doble clic en el nombre)', () => beginPaneRename(termId)),
    iconButton(ICONS.splitRight, 'Dividir a la derecha (Ctrl+\\)', () => split('row', termId)),
    iconButton(ICONS.splitDown, 'Dividir abajo (Ctrl+Shift+\\)', () => split('col', termId)),
    iconButton(ICONS.close, 'Cerrar terminal (Ctrl+Shift+W)', () => closePane(termId, false)),
  );
  header.append(titleEl, stateEl, branchEl, actions);
  enablePaneDrag(header, termId);

  const mount = document.createElement('div');
  mount.className = 'pane-term';
  el.append(header, mount);

  const pane: Pane = {
    termId,
    term,
    fit,
    el,
    mount,
    titleEl,
    branchEl,
    stateEl,
    observer: new ResizeObserver(() => scheduleFit(pane)),
    opened: false,
    started: false,
    fitPending: false,
    rendererStarted: false,
    autoTitle: '',
    lastCwd: '',
    activity: 'idle',
    busySince: 0,
    lastOutput: 0,
    lastInput: 0,
    ignoreUntil: 0,
    ticks: [],
  };
  panes.set(termId, pane);
  pane.observer.observe(mount);

  el.addEventListener('mousedown', () => focusPane(termId), true);
  term.onData(data => {
    noteInput(pane);
    post({ type: 'input', termId, data });
  });
  // La campana es la señal explícita de "necesito algo" de Claude Code y Codex.
  term.onBell(() => raiseAttention(pane));
  term.onTitleChange(title => {
    pane.autoTitle = title;
    refreshPaneTitle(termId);
    // Git Bash pone el directorio en el título ("MINGW64:/c/ruta").
    const fromTitle = cwdFromTitle(title);
    if (fromTitle) reportCwd(pane, fromTitle);
  });

  // OSC 7: el shell informa su directorio como file://host/ruta.
  term.parser.registerOscHandler(7, data => {
    reportCwd(pane, data);
    return true;
  });
  // OSC 9: ConEmu lo usa con un subcomando numérico (9;9 es el directorio, 9;4 el
  // progreso); sin subcomando es la notificación de escritorio que manda Codex.
  term.parser.registerOscHandler(9, data => {
    const cwd = /^9;(.+)$/.exec(data);
    if (cwd) {
      reportCwd(pane, cwd[1]);
      return false;
    }
    if (!/^\d+;/.test(data) && data.trim()) raiseAttention(pane, data.trim());
    return false;
  });
  // OSC 777: "notify;título;cuerpo", la otra convención de notificación de escritorio.
  term.parser.registerOscHandler(777, data => {
    const parts = data.split(';');
    if (parts[0] !== 'notify') return false;
    raiseAttention(pane, parts.slice(1).filter(Boolean).join(': ').trim() || undefined);
    return false;
  });
  term.onResize(({ cols, rows }) => {
    if (pane.started) post({ type: 'resize', termId, cols, rows });
  });
  term.attachCustomKeyEventHandler(ev => handleKey(pane, ev));
  return pane;
}

function openPanes(tab: TabState): void {
  for (const lf of L.leaves(tab.root)) {
    const pane = ensurePane(lf.termId);
    refreshPaneTitle(lf.termId);
    if (pane.opened) continue;
    pane.term.open(pane.mount);
    pane.opened = true;
    startAcceleratedRenderer(pane);
    pane.term.textarea?.addEventListener('focus', () => onTermFocus(lf.termId));
  }
}

function startAcceleratedRenderer(pane: Pane): void {
  if (pane.rendererStarted) return;
  pane.rendererStarted = true;
  try {
    const renderer = new WebglAddon();
    renderer.onContextLoss(() => renderer.dispose());
    pane.term.loadAddon(renderer);
  } catch {
    // xterm conserva automáticamente su renderizador base si WebGL2 no está disponible.
  }
}

// ---------------------------------------------------------------- directorio y rama

/**
 * Cualquier programa que corra en la terminal elige el título y las secuencias
 * OSC, así que esto es texto de fuera. Las rutas que empiezan por dos barras
 * son recursos de red en Windows (\\host\recurso) y solo mirarlas abre una
 * conexión al host que diga el texto, así que no se dan por buenas.
 */
function isRemoteLike(value: string): boolean {
  return /^[\\/]{2}/.test(value);
}

/** Extrae una ruta del título de la ventana, si el shell la pone ahí. */
function cwdFromTitle(title: string): string | undefined {
  const value = title.trim();
  if (!value || value.length > 260) return undefined;
  // Ruta de Windows completa: se toma tal cual (la "C:" no es un prefijo).
  if (/^[A-Za-z]:[\\/]/.test(value)) return value;
  // "MINGW64:/c/ruta" o "user@host:/ruta".
  const prefixed = /^[^\s:]{1,40}:([\\/~].*)$/.exec(value);
  if (prefixed) return isRemoteLike(prefixed[1]) ? undefined : prefixed[1];
  if (isRemoteLike(value)) return undefined;
  if (/^([\\/]|~[\\/]|~$)/.test(value)) return value;
  return undefined;
}

function reportCwd(pane: Pane, cwd: string): void {
  const value = cwd.trim();
  if (!value || value.length > 512 || value === pane.lastCwd) return;
  // file://host/... también es una ruta de red; el host lo vuelve a comprobar.
  if (isRemoteLike(value) || /^file:\/\/[^/]/i.test(value)) return;
  pane.lastCwd = value;
  post({ type: 'cwd', termId: pane.termId, cwd: value });
}

function setBranch(termId: string, branch: string | null, detached: boolean, cwd: string | null): void {
  const pane = panes.get(termId);
  if (!pane) return;
  if (!branch) {
    pane.branchEl.hidden = true;
    pane.branchEl.replaceChildren();
    return;
  }
  const icon = document.createElement('span');
  icon.className = 'branch-icon';
  icon.innerHTML = ICONS.branch;
  const name = document.createElement('span');
  name.className = 'branch-name';
  name.textContent = branch;
  pane.branchEl.replaceChildren(icon, name);
  pane.branchEl.classList.toggle('detached', detached);
  pane.branchEl.title = detached
    ? `HEAD desacoplado en ${branch}${cwd ? `\n${cwd}` : ''}`
    : `Rama ${branch}${cwd ? `\n${cwd}` : ''}`;
  pane.branchEl.hidden = false;
}

// ---------------------------------------------------------------- estado de cada terminal

// La detección es solo visual: se mira cuánta salida produce la terminal, sin
// saber qué programa corre dentro. Un agente pensando repinta su spinner varias
// veces por segundo; cuando calla, terminó o está esperando una respuesta.
const TICK_MS = 200;
/** Ticks distintos con salida dentro de la ventana para considerar que trabaja. */
const BUSY_TICKS = 3;
const BUSY_WINDOW_MS = 2000;
/** Tras escribir, la salida inmediata es el eco de las teclas: no es trabajo. */
const ECHO_GRACE_MS = 300;
/** Trabajos más cortos que esto no avisan: un `ls` no merece una notificación. */
const MIN_BUSY_MS = 4000;
/** Salida que se ignora al reconectar, mientras se reproduce el buffer guardado. */
const REPLAY_GRACE_MS = 1500;

const STATE_LABELS: Record<PaneActivity, string> = {
  idle: '',
  busy: 'trabajando',
  done: 'listo',
  attention: 'atención',
};

const statusEnabled = (): boolean => settings.agentStatus;

/** El usuario está mirando esta terminal ahora mismo. */
function isWatching(pane: Pane): boolean {
  const tab = tabOf(pane.termId);
  return !!tab && tab.id === state.activeTabId && tab.activeTermId === pane.termId && document.hasFocus();
}

function noteInput(pane: Pane): void {
  pane.lastInput = Date.now();
  // Escribir en una terminal es haberla visto.
  if (pane.activity === 'done' || pane.activity === 'attention') setActivity(pane, 'idle');
}

/** Contabiliza la salida de una terminal para deducir si está trabajando. */
function noteOutput(pane: Pane, data: string): void {
  if (!statusEnabled()) return;
  const now = Date.now();
  if (now < pane.ignoreUntil) return;
  pane.lastOutput = now;

  const echo = now - pane.lastInput < ECHO_GRACE_MS && data.length < 512;
  if (!echo) {
    const tick = Math.floor(now / TICK_MS);
    if (pane.ticks[pane.ticks.length - 1] !== tick) pane.ticks.push(tick);
    while (pane.ticks.length && now - pane.ticks[0] * TICK_MS > BUSY_WINDOW_MS) pane.ticks.shift();
    if (pane.ticks.length >= BUSY_TICKS || data.length > 4096) markBusy(pane);
  }
  scheduleQuiet(pane);
}

function markBusy(pane: Pane): void {
  if (pane.activity === 'attention') return;
  if (pane.activity !== 'busy') {
    pane.busySince = Date.now();
    setActivity(pane, 'busy');
  }
}

function scheduleQuiet(pane: Pane): void {
  if (pane.quietTimer !== undefined) window.clearTimeout(pane.quietTimer);
  pane.quietTimer = window.setTimeout(() => {
    pane.quietTimer = undefined;
    onQuiet(pane);
  }, Math.max(1, settings.quietSeconds) * 1000);
}

/** La terminal lleva un rato callada: si venía trabajando, terminó. */
function onQuiet(pane: Pane): void {
  pane.ticks = [];
  if (pane.activity !== 'busy') return;
  const worked = pane.lastOutput - pane.busySince;
  setActivity(pane, worked >= MIN_BUSY_MS && !isWatching(pane) ? 'done' : 'idle');
}

/** La terminal pidió algo explícitamente (campana o secuencia de notificación). */
function raiseAttention(pane: Pane, message?: string): void {
  if (!statusEnabled()) return;
  if (isWatching(pane)) return;
  setActivity(pane, 'attention', message);
  if (settings.attentionSound) beep();
}

function setActivity(pane: Pane, next: PaneActivity, message?: string): void {
  if (pane.activity === next) return;
  pane.activity = next;
  if (next === 'idle' || next === 'busy') {
    pane.busySince = next === 'busy' ? pane.busySince : 0;
  }
  renderPaneState(pane);
  refreshTabStates();
  post({ type: 'activity', termId: pane.termId, state: next, label: paneLabel(pane.termId), message });
}

/** Vuelve a dejar la terminal en silencio cuando el usuario la mira. */
function clearActivity(termId: string): void {
  const pane = panes.get(termId);
  if (!pane) return;
  if (pane.activity === 'done' || pane.activity === 'attention') setActivity(pane, 'idle');
}

function renderPaneState(pane: Pane): void {
  const activity = pane.activity;
  for (const name of ['busy', 'done', 'attention'] as const) {
    pane.el.classList.toggle(`act-${name}`, activity === name);
  }
  const visible = activity === 'done' || activity === 'attention';
  pane.stateEl.hidden = !visible;
  if (!visible) {
    pane.stateEl.replaceChildren();
    return;
  }
  const icon = document.createElement('span');
  icon.className = 'state-icon';
  icon.innerHTML = activity === 'attention' ? ICONS.bell : ICONS.check;
  const text = document.createElement('span');
  text.textContent = STATE_LABELS[activity];
  pane.stateEl.replaceChildren(icon, text);
  pane.stateEl.title =
    activity === 'attention'
      ? 'Esta terminal pidió atención. Clic para ir a ella.'
      : 'Esta terminal terminó lo que estaba haciendo. Clic para ir a ella.';
}

/** Estado más urgente de una pestaña, para el punto de la barra de pestañas. */
function tabActivity(tab: TabState): PaneActivity {
  let strongest: PaneActivity = 'idle';
  for (const lf of L.leaves(tab.root)) {
    const activity = panes.get(lf.termId)?.activity ?? 'idle';
    if (activity === 'attention') return 'attention';
    if (activity === 'done') strongest = 'done';
    else if (activity === 'busy' && strongest === 'idle') strongest = 'busy';
  }
  return strongest;
}

function refreshTabStates(): void {
  for (const tab of state.tabs) {
    const el = tabbarEl.querySelector<HTMLElement>(`.tab[data-tab-id="${tab.id}"]`);
    if (!el) continue;
    const activity = tabActivity(tab);
    for (const name of ['busy', 'done', 'attention'] as const) {
      el.classList.toggle(`act-${name}`, activity === name);
    }
  }
}

let audio: AudioContext | undefined;

/** Pitido corto, sin archivos: la política de contenido del webview no deja cargar audio. */
function beep(): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, audio.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.2);
  } catch {
    // Sin audio disponible: el aviso visual ya se mostró.
  }
}

// ---------------------------------------------------------------- nombre de la terminal

function leafOf(termId: string): { tab: TabState; leaf: ReturnType<typeof L.findLeaf> } | undefined {
  const tab = tabOf(termId);
  if (!tab) return undefined;
  return { tab, leaf: L.findLeaf(tab.root, termId) };
}

/** Nombre visible: el manual si existe, si no el título que reporta el shell. */
function paneLabel(termId: string): string {
  const manual = leafOf(termId)?.leaf?.name;
  if (manual) return manual;
  return panes.get(termId)?.autoTitle || 'Terminal';
}

function refreshPaneTitle(termId: string): void {
  const pane = panes.get(termId);
  if (!pane) return;
  const manual = leafOf(termId)?.leaf?.name;
  const label = paneLabel(termId);
  pane.titleEl.textContent = label;
  pane.titleEl.title = manual
    ? `${label} — nombre fijo. Doble clic para cambiarlo, vacío para volver al automático.`
    : `${label} — doble clic para ponerle un nombre fijo.`;
  pane.titleEl.classList.toggle('manual', !!manual);
}

/** Edita el nombre en el propio encabezado. Dejarlo vacío vuelve al título automático. */
function beginPaneRename(termId: string): void {
  const pane = panes.get(termId);
  const found = leafOf(termId);
  if (!pane || !found?.leaf) return;
  if (pane.titleEl.hidden) return;

  const input = document.createElement('input');
  input.className = 'pane-rename';
  input.value = found.leaf.name ?? pane.autoTitle ?? '';
  input.placeholder = 'Nombre de la terminal';
  input.spellcheck = false;

  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    if (commit) {
      const value = input.value.trim().slice(0, 60);
      const leaf = leafOf(termId)?.leaf;
      if (leaf) {
        if (value) leaf.name = value;
        else delete leaf.name;
      }
      persist();
    }
    input.remove();
    pane.titleEl.hidden = false;
    refreshPaneTitle(termId);
    pane.term.focus();
  };

  input.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') finish(true);
    else if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('mousedown', ev => ev.stopPropagation());
  input.addEventListener('pointerdown', ev => ev.stopPropagation());

  pane.titleEl.hidden = true;
  pane.titleEl.after(input);
  input.focus();
  input.select();
}

function scheduleFit(pane: Pane): void {
  if (pane.fitPending) return;
  pane.fitPending = true;
  requestAnimationFrame(() => {
    pane.fitPending = false;
    if (!pane.opened) return;
    if (pane.mount.clientWidth === 0 || pane.mount.clientHeight === 0) return;
    pane.fit.fit();
  });
}

function fitVisible(): void {
  const tab = activeTab();
  if (!tab) return;
  for (const lf of L.leaves(tab.root)) {
    const pane = panes.get(lf.termId);
    if (pane) scheduleFit(pane);
  }
}

function startPane(termId: string, attach: boolean): void {
  const pane = ensurePane(termId);
  let cols = 80;
  let rows = 24;
  if (pane.opened) {
    const dims = pane.fit.proposeDimensions();
    if (dims && dims.cols > 0 && dims.rows > 0) {
      pane.fit.fit();
      cols = pane.term.cols;
      rows = pane.term.rows;
    }
  }
  pane.started = true;
  // Al reconectar llega de golpe todo el buffer guardado: no es trabajo nuevo.
  pane.ignoreUntil = Date.now() + REPLAY_GRACE_MS;
  pane.ticks = [];
  post({ type: attach ? 'attach' : 'spawn', termId, cols, rows });
}

function disposePane(pane: Pane): void {
  if (pane.quietTimer !== undefined) window.clearTimeout(pane.quietTimer);
  pane.observer.disconnect();
  pane.term.dispose();
  pane.el.remove();
  panes.delete(pane.termId);
}

function updateActiveClasses(tab: TabState): void {
  for (const lf of L.leaves(tab.root)) {
    panes.get(lf.termId)?.el.classList.toggle('active', lf.termId === tab.activeTermId);
  }
}

function onTermFocus(termId: string): void {
  clearActivity(termId);
  const tab = tabOf(termId);
  if (!tab || tab.activeTermId === termId) return;
  tab.activeTermId = termId;
  updateActiveClasses(tab);
  persist();
}

function focusPane(termId: string): void {
  const tab = tabOf(termId);
  if (!tab) return;
  clearActivity(termId);
  if (tab.activeTermId !== termId) {
    tab.activeTermId = termId;
    persist();
  }
  updateActiveClasses(tab);
  const pane = panes.get(termId);
  if (pane?.opened) pane.term.focus();
}

// ---------------------------------------------------------------- render del árbol

function ensureContent(tab: TabState): HTMLElement {
  let el = contents.get(tab.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'tab-content';
    el.hidden = tab.id !== state.activeTabId;
    contents.set(tab.id, el);
    contentEl.append(el);
  }
  return el;
}

function renderTab(tab: TabState): void {
  const container = ensureContent(tab);
  const root = renderNode(tab.root);
  root.style.flex = '1 1 0px';
  container.replaceChildren(root);
  if (!container.hidden) openPanes(tab);
  updateActiveClasses(tab);
  fitVisible();
}

function renderNode(node: LayoutNode): HTMLElement {
  if (node.kind === 'leaf') return ensurePane(node.termId).el;
  const container = document.createElement('div');
  container.className = `split ${node.dir}`;
  const children = node.children.map(renderNode);
  children.forEach((child, i) => {
    child.style.flex = `${node.sizes[i] ?? 1} 1 0px`;
    if (i > 0) container.append(makeDivider(node, i - 1, children[i - 1], child, container));
    container.append(child);
  });
  return container;
}

function makeDivider(
  split: SplitNode,
  index: number,
  before: HTMLElement,
  after: HTMLElement,
  container: HTMLElement,
): HTMLElement {
  const divider = document.createElement('div');
  divider.className = `divider ${split.dir}`;
  divider.addEventListener('mousedown', ev => {
    ev.preventDefault();
    const horizontal = split.dir === 'row';
    const start = horizontal ? ev.clientX : ev.clientY;
    const total = horizontal ? container.clientWidth : container.clientHeight;
    if (total <= 0) return;
    const first = split.sizes[index];
    const pair = first + split.sizes[index + 1];
    const min = Math.min(0.08, pair / 2);

    const onMove = (e: MouseEvent): void => {
      const delta = ((horizontal ? e.clientX : e.clientY) - start) / total;
      const a = Math.min(Math.max(first + delta, min), pair - min);
      split.sizes[index] = a;
      split.sizes[index + 1] = pair - a;
      before.style.flex = `${a} 1 0px`;
      after.style.flex = `${pair - a} 1 0px`;
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      divider.classList.remove('dragging');
      document.body.classList.remove('dragging');
      fitVisible();
      persist();
    };
    divider.classList.add('dragging');
    document.body.classList.add('dragging');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  return divider;
}

// ---------------------------------------------------------------- arrastrar terminales

let drag: DragState | undefined;

function enablePaneDrag(header: HTMLElement, termId: string): void {
  header.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || drag || (ev.target as HTMLElement).closest('button')) return;
    const overlay = document.createElement('div');
    overlay.className = 'drop-overlay';
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    drag = {
      source: termId,
      header,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      active: false,
      overlay,
      ghost,
    };
    header.setPointerCapture(ev.pointerId);
  });

  header.addEventListener('pointermove', ev => {
    if (!drag || drag.pointerId !== ev.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 6) return;
      drag.active = true;
      document.body.classList.add('dragging', 'pane-dragging');
      const source = panes.get(drag.source);
      source?.el.classList.add('drag-source');
      drag.ghost.textContent = paneLabel(drag.source);
      document.body.append(drag.ghost);
    }
    drag.ghost.style.left = `${ev.clientX + 14}px`;
    drag.ghost.style.top = `${ev.clientY + 14}px`;
    updateDragTarget(ev.clientX, ev.clientY);
  });

  header.addEventListener('pointerup', ev => {
    if (drag && drag.pointerId === ev.pointerId) endDrag(true);
  });
  header.addEventListener('pointercancel', ev => {
    if (drag && drag.pointerId === ev.pointerId) endDrag(false);
  });
}

function updateDragTarget(x: number, y: number): void {
  if (!drag) return;
  // Con body.dragging los .pane-term no reciben eventos, así que el punto cae en el .pane.
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.pane');
  const target = el?.dataset.termId;
  if (!el || !target || target === drag.source) {
    drag.target = undefined;
    drag.zone = undefined;
    drag.overlay.remove();
    return;
  }
  const rect = el.getBoundingClientRect();
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  let zone: DropZone;
  if (rx > 0.25 && rx < 0.75 && ry > 0.25 && ry < 0.75) {
    zone = 'center';
  } else {
    const edges: [DropZone, number][] = [
      ['left', rx],
      ['right', 1 - rx],
      ['top', ry],
      ['bottom', 1 - ry],
    ];
    zone = edges.reduce((best, cur) => (cur[1] < best[1] ? cur : best))[0];
  }
  drag.target = target;
  drag.zone = zone;
  drag.overlay.className = `drop-overlay ${zone}`;
  if (drag.overlay.parentElement !== el) el.append(drag.overlay);
}

function endDrag(commit: boolean): void {
  if (!drag) return;
  const { source, header, pointerId, active, target, zone, overlay, ghost } = drag;
  drag = undefined;
  try {
    header.releasePointerCapture(pointerId);
  } catch {
    // Ya estaba liberado.
  }
  overlay.remove();
  ghost.remove();
  document.body.classList.remove('dragging', 'pane-dragging');
  panes.get(source)?.el.classList.remove('drag-source');
  if (!active) return;
  if (commit && target && zone) movePane(source, target, zone);
  else focusPane(source);
}

/** Centro: intercambia las dos terminales. Borde: mueve la arrastrada a ese lado de la destino. */
function movePane(source: string, target: string, zone: DropZone): void {
  const tab = tabOf(source);
  if (!tab || source === target || tabOf(target) !== tab) return;
  if (zone === 'center') {
    L.swapLeaves(tab.root, source, target);
  } else {
    // El nombre manual viaja con la terminal al moverla de sitio.
    const name = L.findLeaf(tab.root, source)?.name;
    const without = L.removeLeaf(tab.root, source);
    if (!without) return;
    const dir: SplitDir = zone === 'left' || zone === 'right' ? 'row' : 'col';
    tab.root = L.splitLeaf(without, target, dir, L.leaf(source, name), zone === 'left' || zone === 'top');
  }
  renderTab(tab);
  focusPane(source);
  persist();
}

window.addEventListener(
  'keydown',
  ev => {
    if (ev.key !== 'Escape') return;
    if (drag?.active) {
      ev.preventDefault();
      ev.stopPropagation();
      endDrag(false);
    } else if (openMenu) {
      ev.preventDefault();
      ev.stopPropagation();
      closeTabMenu();
    }
  },
  true,
);

// ---------------------------------------------------------------- barra de pestañas

function renderTabBar(): void {
  tabbarEl.replaceChildren();
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '');
    el.dataset.tabId = tab.id;

    const color = colorValue(tab.color);
    if (color) {
      el.classList.add('has-color');
      el.style.setProperty('--tab-color', color);
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      el.append(dot);
    }

    const activity = tabActivity(tab);
    if (activity !== 'idle') el.classList.add(`act-${activity}`);
    const stateDot = document.createElement('span');
    stateDot.className = 'tab-state';
    el.append(stateDot);

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = tab.name;
    name.title = `${tab.name} — doble clic para renombrar, clic derecho para color`;

    const close = iconButton(ICONS.close, 'Cerrar pestaña', () => closeTab(tab.id));
    close.classList.add('tab-close');

    el.append(name, close);
    el.addEventListener('click', () => {
      if (state.activeTabId !== tab.id) activateTab(tab.id);
      else activePane()?.term.focus();
    });
    el.addEventListener('dblclick', () => beginRename(tab.id));
    el.addEventListener('auxclick', ev => {
      if (ev.button === 1) closeTab(tab.id);
    });
    el.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      showTabMenu(tab.id, ev.clientX, ev.clientY);
    });
    tabbarEl.append(el);
  }
  const add = iconButton(ICONS.add, 'Nueva pestaña (Ctrl+Shift+T)', () => newTab());
  add.classList.add('tab-add');
  tabbarEl.append(add);
}

// ---------------------------------------------------------------- menú de pestaña

let openMenu: HTMLElement | undefined;

function closeTabMenu(): void {
  openMenu?.remove();
  openMenu = undefined;
}

function showTabMenu(tabId: string, x: number, y: number): void {
  closeTabMenu();
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;

  const menu = document.createElement('div');
  menu.className = 'menu';

  const item = (label: string, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.className = 'menu-item';
    button.textContent = label;
    button.addEventListener('click', () => {
      closeTabMenu();
      onClick();
    });
    return button;
  };

  const colorsLabel = document.createElement('div');
  colorsLabel.className = 'menu-label';
  colorsLabel.textContent = 'Color de la pestaña';

  const colors = document.createElement('div');
  colors.className = 'menu-colors';

  const none = document.createElement('button');
  none.className = 'swatch none' + (tab.color ? '' : ' selected');
  none.title = 'Sin color';
  none.addEventListener('click', () => {
    closeTabMenu();
    setTabColor(tabId, undefined);
  });
  colors.append(none);

  for (const c of TAB_COLORS) {
    const swatch = document.createElement('button');
    swatch.className = 'swatch' + (tab.color === c.key ? ' selected' : '');
    swatch.title = c.name;
    swatch.style.setProperty('--c', c.value);
    swatch.addEventListener('click', () => {
      closeTabMenu();
      setTabColor(tabId, c.key);
    });
    colors.append(swatch);
  }

  const sep = document.createElement('div');
  sep.className = 'menu-sep';

  menu.append(
    item('Renombrar pestaña', () => beginRename(tabId)),
    item('Nueva pestaña', () => newTab()),
    colorsLabel,
    colors,
    sep,
    item('Cerrar pestaña', () => closeTab(tabId)),
  );

  menu.style.visibility = 'hidden';
  document.body.append(menu);
  // Se ajusta para que no se salga de la ventana.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  menu.style.visibility = 'visible';
  openMenu = menu;
}

function setTabColor(tabId: string, color: string | undefined): void {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;
  if (color) tab.color = color;
  else delete tab.color;
  renderTabBar();
  persist();
  activePane()?.term.focus();
}

document.addEventListener('mousedown', ev => {
  if (openMenu && !(ev.target as HTMLElement).closest('.menu')) closeTabMenu();
});
window.addEventListener('blur', closeTabMenu);

function beginRename(tabId: string): void {
  const tab = state.tabs.find(t => t.id === tabId);
  const nameEl = tabbarEl.querySelector<HTMLElement>(`.tab[data-tab-id="${tabId}"] .tab-name`);
  if (!tab || !nameEl) return;

  const input = document.createElement('input');
  input.className = 'tab-rename';
  input.value = tab.name;
  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (commit && value) tab.name = value;
    renderTabBar();
    persist();
    activePane()?.term.focus();
  };
  input.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') finish(true);
    else if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', ev => ev.stopPropagation());
  input.addEventListener('dblclick', ev => ev.stopPropagation());
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

// ---------------------------------------------------------------- acciones

function activateTab(tabId: string): void {
  state.activeTabId = tabId;
  for (const tab of state.tabs) ensureContent(tab).hidden = tab.id !== tabId;
  renderTabBar();
  const tab = activeTab();
  if (tab) {
    openPanes(tab);
    updateActiveClasses(tab);
    fitVisible();
    requestAnimationFrame(() => {
      for (const lf of L.leaves(tab.root)) {
        const pane = panes.get(lf.termId);
        if (pane?.opened) pane.term.refresh(0, pane.term.rows - 1);
      }
      panes.get(tab.activeTermId)?.term.focus();
    });
  }
  persist();
}

function newTab(): void {
  const termId = L.newId();
  const tab: TabState = {
    id: L.newId(),
    name: `Terminal ${state.nextTabNumber++}`,
    root: L.leaf(termId),
    activeTermId: termId,
  };
  state.tabs.push(tab);
  // Primero se inserta el árbol en el DOM y luego se activa la pestaña, para
  // que xterm se abra sobre un elemento visible y mida bien la fuente.
  ensureContent(tab);
  renderTab(tab);
  activateTab(tab.id);
  startPane(termId, false);
  focusPane(termId);
  persist();
}

function closeTab(tabId: string): void {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;
  for (const lf of L.leaves(tab.root)) {
    const pane = panes.get(lf.termId);
    if (!pane) continue;
    post({ type: 'kill', termId: lf.termId });
    disposePane(pane);
  }
  removeTabEntry(tab);
}

function removeTabEntry(tab: TabState): void {
  contents.get(tab.id)?.remove();
  contents.delete(tab.id);
  const index = state.tabs.indexOf(tab);
  state.tabs.splice(index, 1);
  if (state.tabs.length === 0) {
    newTab();
    return;
  }
  if (state.activeTabId === tab.id) {
    activateTab(state.tabs[Math.min(index, state.tabs.length - 1)].id);
  } else {
    renderTabBar();
  }
  persist();
}

function cycleTab(delta: number): void {
  const count = state.tabs.length;
  if (count < 2) return;
  const index = state.tabs.findIndex(t => t.id === state.activeTabId);
  activateTab(state.tabs[(index + delta + count) % count].id);
}

function split(dir: SplitDir, sourceTermId?: string): void {
  const tab = sourceTermId ? tabOf(sourceTermId) : activeTab();
  if (!tab) return;
  const source = sourceTermId ?? tab.activeTermId;
  const termId = L.newId();
  tab.root = L.splitLeaf(tab.root, source, dir, L.leaf(termId));
  if (tab.id !== state.activeTabId) activateTab(tab.id);
  renderTab(tab);
  startPane(termId, false);
  focusPane(termId);
  persist();
}

function closePane(termId: string, alreadyExited: boolean): void {
  const tab = tabOf(termId);
  if (!tab) return;
  const pane = panes.get(termId);
  if (pane) {
    if (!alreadyExited) post({ type: 'kill', termId });
    disposePane(pane);
  }
  const next = L.removeLeaf(tab.root, termId);
  if (!next) {
    removeTabEntry(tab);
    return;
  }
  tab.root = next;
  if (tab.activeTermId === termId) tab.activeTermId = L.leaves(tab.root)[0].termId;
  renderTab(tab);
  if (tab.id === state.activeTabId) focusPane(tab.activeTermId);
  persist();
}

function cyclePane(delta: number): void {
  const tab = activeTab();
  if (!tab) return;
  const ids = L.leaves(tab.root).map(l => l.termId);
  if (ids.length < 2) return;
  const index = ids.indexOf(tab.activeTermId);
  focusPane(ids[(index + delta + ids.length) % ids.length]);
}

function runCommand(command: MuxentraCommand, arg?: string): void {
  switch (command) {
    case 'newTab':
      newTab();
      break;
    case 'closeTab':
      closeTab(state.activeTabId);
      break;
    case 'renameTab':
      beginRename(state.activeTabId);
      break;
    case 'renamePane': {
      const tab = activeTab();
      if (tab) beginPaneRename(tab.activeTermId);
      break;
    }
    case 'tabColor': {
      const el = tabbarEl.querySelector<HTMLElement>(`.tab[data-tab-id="${state.activeTabId}"]`);
      const rect = el?.getBoundingClientRect();
      showTabMenu(state.activeTabId, rect?.left ?? 8, rect ? rect.bottom : 40);
      break;
    }
    case 'nextTab':
      cycleTab(1);
      break;
    case 'prevTab':
      cycleTab(-1);
      break;
    case 'splitRight':
      split('row');
      break;
    case 'splitDown':
      split('col');
      break;
    case 'closePane': {
      const tab = activeTab();
      if (tab) closePane(tab.activeTermId, false);
      break;
    }
    case 'focusNextPane':
      cyclePane(1);
      break;
    case 'focusPrevPane':
      cyclePane(-1);
      break;
    case 'equalize': {
      const tab = activeTab();
      if (tab) {
        L.equalize(tab.root);
        renderTab(tab);
        focusPane(tab.activeTermId);
        persist();
      }
      break;
    }
    case 'copy': {
      const pane = activePane();
      if (pane?.term.hasSelection()) post({ type: 'copy', text: pane.term.getSelection() });
      break;
    }
    case 'paste': {
      const pane = activePane();
      if (pane && arg) {
        pane.term.paste(arg);
        pane.term.focus();
      }
      break;
    }
    case 'refit':
      fitVisible();
      activePane()?.term.focus();
      break;
    case 'focusTerm': {
      const termId = arg && panes.has(arg) ? arg : undefined;
      if (!termId) break;
      const tab = tabOf(termId);
      if (!tab) break;
      if (tab.id !== state.activeTabId) activateTab(tab.id);
      focusPane(termId);
      break;
    }
  }
}

// ---------------------------------------------------------------- teclado

/** Teclas con Ctrl (Cmd en mac) que se dejan pasar a VS Code en vez de al shell. */
const FORWARD_MOD_KEYS = new Set([
  '\\', 'p', 'b', 'j', '`', ',', 'v', 'tab', 'pageup', 'pagedown', '=', '-',
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);
const FORWARD_MOD_ALT_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'v']);
const FORWARD_PLAIN_KEYS = new Set(['f1', 'f2', 'f11']);

/**
 * Devuelve false cuando xterm debe ignorar el evento (y dejar que burbujee a
 * VS Code, que aplica los keybindings de la extensión); true cuando lo maneja xterm.
 */
function handleKey(pane: Pane, ev: KeyboardEvent): boolean {
  const key = ev.key.toLowerCase();
  const mac = settings.platform === 'darwin';
  const mod = mac ? ev.metaKey : ev.ctrlKey;

  if (ev.type === 'keydown' && mod && !ev.shiftKey && !ev.altKey && key === 'c' && pane.term.hasSelection()) {
    post({ type: 'copy', text: pane.term.getSelection() });
    pane.term.clearSelection();
    return false;
  }
  if (mod && ev.shiftKey && !ev.altKey) return false;
  // Ctrl+Alt casi no se cede a VS Code: en Windows Ctrl+Alt es AltGr y
  // se necesita para escribir @ \ { } [ ] | ~ en teclados latinoamericanos/españoles.
  // Pasan las flechas y la v (pegar imagen), que con AltGr no escriben ningún carácter.
  if (mod && ev.altKey && !ev.shiftKey && FORWARD_MOD_ALT_KEYS.has(key)) return false;
  if (mod && !ev.shiftKey && !ev.altKey && FORWARD_MOD_KEYS.has(key)) return false;
  if (!ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey && FORWARD_PLAIN_KEYS.has(key)) return false;
  return true;
}

// ---------------------------------------------------------------- barra de uso

let showUsage = true;

/** "2h 13m", "3d 22h" o "ahora" para el momento en que se reinicia una ventana. */
function formatReset(resetsAt: number | undefined): string | undefined {
  if (!resetsAt) return undefined;
  const seconds = resetsAt - Date.now() / 1000;
  if (seconds <= 0) return 'ahora';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function severity(percent: number): string {
  if (percent >= 0.85) return 'crit';
  if (percent >= 0.6) return 'warn';
  return 'ok';
}

function renderUsage(snapshot: UsageSnapshot | null): void {
  if (!showUsage) {
    usageEl.hidden = true;
    usageEl.replaceChildren();
    return;
  }
  const items = (snapshot?.items ?? []).filter(i => i.windows.length > 0 || i.detail);
  if (items.length === 0) {
    usageEl.hidden = true;
    usageEl.replaceChildren();
    return;
  }
  usageEl.hidden = false;
  const spacer = document.createElement('span');
  spacer.className = 'usage-spacer';
  usageEl.replaceChildren(...items.map(renderUsageItem), spacer, renderUsageRefresh(snapshot?.updatedAt));
  fitVisible();
}

function renderUsageItem(item: UsageItem): HTMLElement {
  const el = document.createElement('div');
  el.className = `usage-item ${item.id}`;
  el.style.setProperty('--usage-brand', item.id === 'claude' ? '#e07a5f' : '#22c55e');

  const provider = document.createElement('span');
  provider.className = 'usage-provider';

  const icon = document.createElement('span');
  icon.className = 'usage-provider-icon';
  icon.innerHTML = item.id === 'claude' ? ICONS.claude : ICONS.codex;

  const identity = document.createElement('span');
  identity.className = 'usage-identity';

  const label = document.createElement('span');
  label.className = 'usage-name';
  label.textContent = item.label;

  identity.append(label);
  if (item.plan) {
    const plan = document.createElement('span');
    plan.className = 'usage-plan';
    plan.textContent = item.plan;
    identity.append(plan);
  }
  provider.append(icon, identity);
  el.append(provider);

  for (const w of item.windows) {
    const percent = Math.round(w.percent * 100);
    const chunk = document.createElement('span');
    chunk.className = `usage-win ${severity(w.percent)}`;

    const name = document.createElement('span');
    name.className = 'usage-win-label';
    name.textContent = w.label;

    const bar = document.createElement('span');
    bar.className = 'usage-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `${item.label}, ${w.label}: ${percent}% consumido`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(percent));
    const fill = document.createElement('i');
    fill.style.width = `${percent}%`;
    bar.append(fill);

    const value = document.createElement('span');
    value.className = 'usage-pct';
    value.textContent = `${percent}%`;

    chunk.append(name, bar, value);
    el.append(chunk);
  }

  const reset = formatReset(item.windows.find(w => w.resetsAt)?.resetsAt);
  if (reset) {
    const resetEl = document.createElement('span');
    resetEl.className = 'usage-reset';
    resetEl.innerHTML = ICONS.clock;
    const resetText = document.createElement('span');
    resetText.textContent = reset;
    resetEl.append(resetText);
    el.append(resetEl);
  }

  if (item.detail) {
    const detail = document.createElement('span');
    detail.className = 'usage-detail';
    if (item.windows.length > 0) detail.classList.add('status');
    detail.textContent = item.detail;
    el.append(detail);
  }

  el.title = usageTooltip(item);
  return el;
}

function renderUsageRefresh(updatedAt: number | undefined): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'usage-refresh';
  button.type = 'button';
  button.innerHTML = ICONS.refresh;
  button.setAttribute('aria-label', 'Actualizar consumo de IA');
  button.title = 'Actualizar consumo de IA';

  const label = document.createElement('span');
  label.className = 'usage-refresh-label';
  label.textContent = updatedAt
    ? `Actualizado ${new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'Actualizar';
  button.append(label);
  button.addEventListener('click', ev => {
    ev.stopPropagation();
    post({ type: 'refreshUsage' });
  });
  return button;
}

function usageTooltip(item: UsageItem): string {
  const lines = [item.plan ? `${item.label} · plan ${item.plan}` : item.label];
  for (const w of item.windows) {
    const reset = formatReset(w.resetsAt);
    const when = w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString() : undefined;
    lines.push(`${w.label}: ${Math.round(w.percent * 100)}%${reset ? ` · se reinicia en ${reset} (${when})` : ''}`);
  }
  if (item.detail) lines.push(item.detail);
  if (item.updatedAt) lines.push(`Dato de ${new Date(item.updatedAt).toLocaleTimeString()}`);
  lines.push('Clic para actualizar.');
  return lines.join('\n');
}

usageEl.addEventListener('click', () => post({ type: 'refreshUsage' }));

// ---------------------------------------------------------------- mensajes del host

async function onInit(msg: Extract<HostMessage, { type: 'init' }>): Promise<void> {
  await applySettings(msg.settings);
  showUsage = msg.showUsage;
  const alive = new Set(msg.alive);
  const exited = new Set(msg.exited);

  if (msg.layout && Array.isArray(msg.layout.tabs)) {
    state.tabs = [];
    for (const raw of msg.layout.tabs) {
      let root = L.sanitize(raw.root);
      if (!root) continue;
      for (const lf of L.leaves(root)) {
        if (exited.has(lf.termId)) root = L.removeLeaf(root, lf.termId);
        if (!root) break;
      }
      if (!root) continue;
      const ids = L.leaves(root).map(l => l.termId);
      const color = typeof raw.color === 'string' && TAB_COLORS.some(c => c.key === raw.color) ? raw.color : undefined;
      state.tabs.push({
        id: typeof raw.id === 'string' ? raw.id : L.newId(),
        name: typeof raw.name === 'string' && raw.name ? raw.name : `Terminal ${state.tabs.length + 1}`,
        root,
        activeTermId: ids.includes(raw.activeTermId) ? raw.activeTermId : ids[0],
        ...(color ? { color } : {}),
      });
    }
    state.activeTabId = msg.layout.activeTabId;
    state.nextTabNumber = Math.max(1, Number(msg.layout.nextTabNumber) || state.tabs.length + 1);
  }

  if (state.tabs.length === 0) {
    newTab();
    return;
  }
  if (!state.tabs.some(t => t.id === state.activeTabId)) state.activeTabId = state.tabs[0].id;

  for (const tab of state.tabs) ensureContent(tab);
  for (const tab of state.tabs) renderTab(tab);
  activateTab(state.activeTabId);
  for (const tab of state.tabs) {
    for (const lf of L.leaves(tab.root)) startPane(lf.termId, alive.has(lf.termId));
  }
  persist();
}

window.addEventListener('message', (ev: MessageEvent<HostMessage>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      void onInit(msg);
      break;
    case 'data': {
      const pane = panes.get(msg.termId);
      if (pane) {
        pane.term.write(msg.data);
        noteOutput(pane, msg.data);
      }
      break;
    }
    case 'exit':
      closePane(msg.termId, true);
      break;
    case 'spawnError': {
      const pane = panes.get(msg.termId);
      pane?.term.write(`\r\n\x1b[31mNo se pudo iniciar el shell: ${msg.message}\x1b[0m\r\n`);
      break;
    }
    case 'serverLost':
      for (const pane of panes.values()) {
        pane.term.reset();
        pane.term.write('\x1b[33mSe perdió el servidor de terminales; iniciando un shell nuevo.\x1b[0m\r\n');
        startPane(pane.termId, false);
      }
      break;
    case 'settings':
      void applySettings(msg.settings);
      break;
    case 'usage':
      showUsage = msg.showUsage;
      renderUsage(msg.usage);
      break;
    case 'branch':
      setBranch(msg.termId, msg.branch, msg.detached, msg.cwd);
      break;
    case 'command':
      runCommand(msg.command, msg.arg);
      break;
  }
});

new MutationObserver(applyTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['style', 'class'],
});
new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
window.addEventListener('focus', () => activePane()?.term.focus());

post({ type: 'ready' });
