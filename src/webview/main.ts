import { Terminal, type ITerminalOptions, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { brandMark } from '../brand';
import { formatReset, preferredUsageReset } from './usageReset';
import { defaultFocusTimer, validFocusSound, type FocusPhase, type FocusSound, type FocusTimerState } from '../focusTimer';
import { mountGitView } from '../gitView/main';
import type {
  HostMessage,
  LayoutNode,
  MuxentraCommand,
  PaneActivity,
  SplitDir,
  SplitNode,
  TabState,
  TermSettings,
  TerminalSnapshot,
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
  fitTimer: number | undefined;
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
  /** Veces que el usuario movió la vista con la rueda o la barra; distingue su scroll del de la aplicación. */
  userScroll: number;
  /** Replay uses the original geometry without sending terminal responses. */
  restoring: boolean;
  restorePending: string[];
  restoreGeneration: number;
  /** Comando que se deja escrito en el prompt nuevo para retomar al agente; Enter lo lanza. */
  prefill?: string;
  prefillTimer?: number;
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
  bell:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2a3.6 3.6 0 0 0-3.6 3.6c0 3-1.2 4-1.2 4h9.6s-1.2-1-1.2-4A3.6 3.6 0 0 0 8 2.2Z"/><path d="M6.9 12.1a1.3 1.3 0 0 0 2.2 0"/></svg>',
  check:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l3 3 6-6.8"/></svg>',
  refresh:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.1 5.7A5.4 5.4 0 1 0 13 10.6"/><path d="M10.2 5.7h3.2V2.5"/></svg>',
  bellOff:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M4.4 6.3a3.6 3.6 0 0 1 6.2-2.5 3.6 3.6 0 0 1 1 2.5c0 3 1.2 4 1.2 4H6.7M6.9 12.1a1.3 1.3 0 0 0 2.2 0"/></svg>',
  timer:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.2v3.6l2.2 1.3M6.2 1.5h3.6"/></svg>',
  font:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 12.5 5.4 3.2l3.6 9.3M3 9.4h4.8M14.2 12.5V8.6c0-1.1-.8-1.8-2-1.8-1 0-1.7.4-2.1 1M14.2 10.3c-.6-.3-1.4-.4-2.1-.2-.9.2-1.5.7-1.5 1.4 0 .8.7 1.2 1.6 1.2.9 0 1.6-.4 2-1"/></svg>',
  pause:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3v10M10.5 3v10"/></svg>',
  play:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 8 5-8 5z"/></svg>',
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
  scrollback: 20000,
  rebuildAwareScrollback: true,
  cursorBlink: true,
  platform: 'linux',
  windowsBuildNumber: 0,
  agentStatus: true,
  quietSeconds: 3,
  attentionSound: false,
  notificationsEnabled: true,
  openingAnimation: true,
  customFontFamily: '',
  inheritedFontFamily: 'monospace',
  customFontSize: 0,
  inheritedFontSize: 14,
};
let theme: ITheme = buildTheme();

const tabbarEl = document.getElementById('tabbar') as HTMLElement;
const contentEl = document.getElementById('content') as HTMLElement;
const gitEl = document.getElementById('git-view') as HTMLElement;
let gitView: ReturnType<typeof mountGitView>;
let gitEnabled = false;
let gitActive = false;
const usageEl = document.getElementById('usage') as HTMLElement;
const usagePopoverEl = document.getElementById('usage-popover') as HTMLElement;
const bottomBarEl = document.getElementById('bottom-bar') as HTMLElement;
const focusEl = document.getElementById('focus') as HTMLElement;
const focusStatusEl = document.getElementById('focus-status') as HTMLButtonElement;
const focusPhaseEl = document.getElementById('focus-phase') as HTMLElement;
const focusTimeEl = document.getElementById('focus-time') as HTMLElement;
const focusPauseEl = document.getElementById('focus-pause') as HTMLButtonElement;
const focusPopoverEl = document.getElementById('focus-popover') as HTMLElement;
const focusFormEl = document.getElementById('focus-form') as HTMLFormElement;
const focusWorkEl = document.getElementById('focus-work') as HTMLInputElement;
const focusBreakEl = document.getElementById('focus-break') as HTMLInputElement;
const focusSoundEl = document.getElementById('focus-sound') as HTMLSelectElement;
const focusSaveEl = document.getElementById('focus-save') as HTMLButtonElement;
const focusHintEl = document.getElementById('focus-hint') as HTMLElement;
const focusPreviewEl = document.getElementById('focus-preview') as HTMLButtonElement;
const focusActionsEl = document.getElementById('focus-actions') as HTMLElement;
const focusToggleEl = document.getElementById('focus-toggle') as HTMLButtonElement;
const focusSkipEl = document.getElementById('focus-skip') as HTMLButtonElement;
const focusStopEl = document.getElementById('focus-stop') as HTMLButtonElement;
const fontPopoverEl = document.getElementById('font-popover') as HTMLElement;
const fontListEl = document.getElementById('font-list') as HTMLElement;
const fontCustomFormEl = document.getElementById('font-custom-form') as HTMLFormElement;
const fontCustomEl = document.getElementById('font-custom') as HTMLInputElement;
const fontSizeValueEl = document.getElementById('font-size-value') as HTMLElement;
const fontSizeMinusEl = document.getElementById('font-size-minus') as HTMLButtonElement;
const fontSizePlusEl = document.getElementById('font-size-plus') as HTMLButtonElement;
const fontResetEl = document.getElementById('font-reset') as HTMLButtonElement;
// ---------------------------------------------------------------- apertura
//
// Un saludo, no una puerta. Dura lo que tarda la M en dibujarse y se va en
// cuanto las terminales de la pestaña activa responden. Cualquier tecla o clic
// lo cierra. Git carga aparte y nunca retiene el espacio. Si el ajuste
// muxentra.openingAnimation está apagado, el HTML no trae el marcado y todo
// esto queda inerte.

const bootEl = document.getElementById('boot');
const bootStatusEl = document.getElementById('boot-status');
const bootProgressEl = document.getElementById('boot-progress-fill');
const bootLoadingEl = document.getElementById('boot-loading');
const bootSkipEl = document.getElementById('boot-skip');
const bootMarkEl = document.getElementById('boot-mark');
let focusTimer = defaultFocusTimer();
let focusPopoverOpen = false;
let bootInitialized = false;
let bootDismissed = bootEl === null;
let bootDrawn = false;
const bootReady = new Set<string>();
/** Lo que tarda el trazo de la M (620 ms más su retardo): el saludo no se corta antes. */
const BOOT_DRAW_MS = 680;
/** Desde aquí se dice qué se espera; desde los tres segundos, el botón de entrar. */
const BOOT_LOADING_AFTER_MS = 1_200;
const BOOT_SKIP_AFTER_MS = 3_000;
const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const bootDrawTimer = window.setTimeout(() => {
  bootDrawn = true;
  updateBoot();
}, prefersReducedMotion() ? 0 : BOOT_DRAW_MS);
const bootLoadingTimer = window.setTimeout(() => {
  if (bootDismissed || !bootLoadingEl) return;
  bootLoadingEl.hidden = false;
  updateBoot();
}, BOOT_LOADING_AFTER_MS);
const bootSkipTimer = window.setTimeout(() => {
  if (bootDismissed || !bootSkipEl) return;
  bootSkipEl.hidden = false;
}, BOOT_SKIP_AFTER_MS);

function updateBoot(): void {
  if (!bootInitialized || bootDismissed) return;
  const tab = activeTab();
  const ids = tab ? L.leaves(tab.root).map(leaf => leaf.termId) : [];
  const ready = ids.filter(id => bootReady.has(id)).length;
  if (bootProgressEl) bootProgressEl.style.transform = `scaleX(${ids.length ? ready / ids.length : 1})`;
  if (ready === ids.length) {
    if (bootDrawn) dismissBoot();
    return;
  }
  if (bootStatusEl && bootLoadingEl && !bootLoadingEl.hidden) {
    bootStatusEl.textContent = ready === 0
      ? `Recuperando ${ids.length} ${ids.length === 1 ? 'terminal' : 'terminales'}…`
      : `${ready} de ${ids.length} terminales listas…`;
  }
}

function markBootReady(termId: string): void {
  if (bootDismissed) return;
  bootReady.add(termId);
  updateBoot();
}

function beginBoot(): void {
  if (bootDismissed) return;
  bootInitialized = true;
  updateBoot();
}

function onBootKey(ev: KeyboardEvent): void {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(ev.key)) return;
  dismissBoot();
}

/**
 * Cierra el saludo. El anillo se abre como una onda y la marca vuela hasta el
 * logo de la barra, que es donde vive. El espacio ya estaba dibujado debajo y
 * queda usable en el mismo instante; la capa solo termina de desvanecerse.
 */
function dismissBoot(): void {
  if (bootDismissed) return;
  bootDismissed = true;
  window.clearTimeout(bootDrawTimer);
  window.clearTimeout(bootLoadingTimer);
  window.clearTimeout(bootSkipTimer);
  window.removeEventListener('keydown', onBootKey, true);
  const app = document.getElementById('app');
  const instant = prefersReducedMotion();
  if (bootEl && !instant && bootMarkEl) {
    // FLIP: medir dónde está el logo de la barra y volar hasta él.
    const target = tabbarEl.querySelector<HTMLElement>('.workspace-brand .muxentra-mark');
    const from = bootMarkEl.getBoundingClientRect();
    const to = target?.getBoundingClientRect();
    bootMarkEl.style.transform = to && from.width > 0
      ? `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px) scale(${to.width / from.width})`
      : 'scale(.3)';
  }
  bootEl?.classList.add(instant ? 'is-instant' : 'is-leaving');
  app?.classList.add('workspace-ready');
  for (const el of [tabbarEl, contentEl, gitEl, bottomBarEl]) el.removeAttribute('inert');
  if (!gitActive) activePane()?.term.focus();
  const finish = (): void => {
    if (bootEl) bootEl.hidden = true;
    app?.setAttribute('aria-busy', 'false');
  };
  if (instant) finish();
  else window.setTimeout(finish, 460);
}

if (bootEl) {
  bootEl.addEventListener('pointerdown', () => dismissBoot());
  bootSkipEl?.addEventListener('click', () => dismissBoot());
  window.addEventListener('keydown', onBootKey, true);
}

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
    state.terminalSizes = Object.fromEntries([...panes.values()].map(pane => [pane.termId,
      { cols: pane.term.cols, rows: pane.term.rows },
    ]));
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
    scrollbarSliderBackground: pick(['--vscode-scrollbarSlider-background'], 'rgba(121, 121, 121, 0.4)'),
    scrollbarSliderHoverBackground: pick(['--vscode-scrollbarSlider-hoverBackground'], 'rgba(100, 100, 100, 0.7)'),
    scrollbarSliderActiveBackground: pick(['--vscode-scrollbarSlider-activeBackground'], 'rgba(191, 191, 191, 0.4)'),
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
  renderTabBar();
  fitVisible();
  if (fontPopoverOpen) renderFontList();
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
    fitTimer: undefined,
    rendererStarted: false,
    autoTitle: '',
    lastCwd: '',
    activity: 'idle',
    busySince: 0,
    lastOutput: 0,
    lastInput: 0,
    ignoreUntil: 0,
    ticks: [],
    userScroll: 0,
    restoring: false,
    restorePending: [],
    restoreGeneration: 0,
  };
  panes.set(termId, pane);
  pane.observer.observe(mount);

  el.addEventListener('mousedown', () => focusPane(termId), true);
  term.onData(data => {
    if (pane.restoring || !pane.started) return;
    // Si el usuario teclea antes, manda él: el comando de retomar no se escribe.
    cancelPrefill(pane);
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
    if (!pane.started) return;
    post({ type: 'resize', termId, cols, rows });
    persist();
  });
  for (const type of ['wheel', 'mousedown'] as const) {
    mount.addEventListener(type, () => { pane.userScroll++; }, { passive: true });
  }
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
  if (worked < MIN_BUSY_MS) {
    setActivity(pane, 'idle');
    return;
  }
  // Se marca siempre; si el usuario tenía esa terminal delante, sin avisar.
  setActivity(pane, 'done', undefined, isWatching(pane));
}

/** La terminal pidió algo explícitamente (campana o secuencia de notificación). */
function raiseAttention(pane: Pane, message?: string): void {
  if (!statusEnabled()) return;
  const watching = isWatching(pane);
  setActivity(pane, 'attention', message, watching);
  if (settings.attentionSound && !watching) beep();
}

function setActivity(pane: Pane, next: PaneActivity, message?: string, silent = false): void {
  if (pane.activity === next) return;
  pane.activity = next;
  if (next !== 'busy') pane.busySince = 0;
  renderPaneState(pane);
  refreshTabStates();
  post({ type: 'activity', termId: pane.termId, state: next, label: paneLabel(pane.termId), message, silent });
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

function prepareAudio(): AudioContext {
  audio ??= new AudioContext();
  if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
  return audio;
}

/** Pitido corto, sin archivos: la política de contenido del webview no deja cargar audio. */
function beep(): void {
  try {
    const context = prepareAudio();
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
    osc.connect(gain).connect(context.destination);
    osc.start();
    osc.stop(context.currentTime + 0.2);
  } catch {
    // Sin audio disponible: el aviso visual ya se mostró.
  }
}

const FOCUS_CHIMES: Record<FocusSound, {
  notes: readonly number[];
  step: number;
  ring: number;
  volume: number;
  harmonic: number;
}> = {
  subtle: { notes: [523.25, 659.25], step: 0.19, ring: 0.43, volume: 0.025, harmonic: 0.004 },
  warm: { notes: [392, 523.25, 659.25], step: 0.25, ring: 0.58, volume: 0.021, harmonic: 0.0035 },
  long: { notes: [392, 493.88, 587.33, 783.99], step: 0.34, ring: 0.78, volume: 0.017, harmonic: 0.003 },
};

/** Melodía ascendente al terminar trabajo, descendente al terminar descanso. */
function playFocusChime(completed: FocusPhase, sound: FocusSound): void {
  try {
    const context = prepareAudio();
    const start = context.currentTime + 0.01;
    const chime = FOCUS_CHIMES[sound];
    const notes = completed === 'work' ? chime.notes : [...chime.notes].reverse();
    for (const [index, note] of notes.entries()) {
      const at = start + index * chime.step;
      for (const [partial, volume] of [[1, chime.volume], [2, chime.harmonic]] as const) {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(note * partial, at);
        osc.frequency.exponentialRampToValueAtTime(note * partial * 0.995, at + chime.ring);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(volume, at + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + chime.ring);
        osc.connect(gain).connect(context.destination);
        osc.start(at);
        osc.stop(at + chime.ring + 0.01);
      }
    }
  } catch {
    // El cambio de fase sigue visible aunque el dispositivo no admita audio.
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

/**
 * Espera a que el arrastre pare antes de recalcular el tamaño. Cada cambio de
 * columnas hace que xterm rehaga el ajuste de líneas de todo el historial y que
 * la TUI del agente repinte; a un ajuste por fotograma, arrastrar un divisor
 * deja el scrollback lleno de fragmentos repetidos.
 */
const FIT_DELAY_MS = 120;

function scheduleFit(pane: Pane): void {
  if (pane.fitTimer !== undefined) window.clearTimeout(pane.fitTimer);
  pane.fitTimer = window.setTimeout(() => {
    pane.fitTimer = undefined;
    if (!pane.opened || pane.restoring || !pane.started) return;
    if (pane.mount.clientWidth === 0 || pane.mount.clientHeight === 0) return;
    const view = readingPosition(pane);
    pane.fit.fit();
    restoreReadingPosition(pane, view);
  }, FIT_DELAY_MS);
}

interface ReadingPosition {
  line: number;
  stamp: number;
}

/** Línea que el usuario tiene arriba si está leyendo historial; undefined si está al final. */
function readingPosition(pane: Pane): ReadingPosition | undefined {
  const buf = pane.term.buffer.active;
  if (buf.viewportY >= buf.baseY) return undefined;
  return { line: buf.viewportY, stamp: pane.userScroll };
}

/**
 * xterm 6 devuelve la vista al final con algunas secuencias de borrado que
 * usan las TUI al repintar (xtermjs/xterm.js#5801), y al cambiar de tamaño.
 * Con un agente escribiendo, leer historial era imposible: cada frame te
 * bajaba. Si el usuario no tocó la rueda entre medias, se vuelve a su línea.
 */
function restoreReadingPosition(pane: Pane, view: ReadingPosition | undefined): void {
  if (!view || pane.userScroll !== view.stamp) return;
  const buf = pane.term.buffer.active;
  if (buf.viewportY < buf.baseY) return;
  pane.term.scrollToLine(Math.min(view.line, buf.baseY));
}

function writeKeepingView(pane: Pane, data: string, done?: () => void): void {
  const view = readingPosition(pane);
  if (!view) {
    pane.term.write(data, done);
    return;
  }
  pane.term.write(data, () => {
    restoreReadingPosition(pane, view);
    done?.();
  });
}

// ---------------------------------------------------------------- replay

function restoreTerminal(pane: Pane, snapshot: TerminalSnapshot): void {
  const generation = ++pane.restoreGeneration;
  pane.restoring = true;
  pane.started = false;
  pane.term.options.disableStdin = true;
  // Drain pending writes before replacing the terminal state.
  pane.term.write('', () => {
    if (panes.get(pane.termId) !== pane || pane.restoreGeneration !== generation) return;
    pane.term.reset();
    if (snapshot.windowsPty) pane.term.options.windowsPty = snapshot.windowsPty;
    pane.term.resize(snapshot.cols, snapshot.rows);
    pane.term.write(snapshot.data, () => {
      if (panes.get(pane.termId) !== pane || pane.restoreGeneration !== generation) return;
      pane.restoring = false;
      pane.started = true;
      pane.term.options.disableStdin = false;
      const pending = pane.restorePending.splice(0);
      for (const data of pending) writeKeepingView(pane, data);
      if (pending.length) schedulePrefill(pane);
      scheduleFit(pane);
      persist();
      markBootReady(pane.termId);
    });
  });
}

/** Silencio del shell tras arrancar que se toma por "ya está el prompt". */
const PREFILL_QUIET_MS = 1200;

/**
 * Tras revivir una terminal donde corría un agente, se deja escrito su
 * comando de continuar en cuanto el shell se calla. No se pulsa Enter: lanzar
 * un agente gasta cuota y eso lo decide el usuario, con Enter o con Ctrl+C.
 */
function schedulePrefill(pane: Pane): void {
  if (!pane.prefill) return;
  if (pane.prefillTimer !== undefined) window.clearTimeout(pane.prefillTimer);
  pane.prefillTimer = window.setTimeout(() => {
    pane.prefillTimer = undefined;
    const command = pane.prefill;
    if (!command || pane.restoring || panes.get(pane.termId) !== pane) return;
    pane.prefill = undefined;
    post({ type: 'input', termId: pane.termId, data: command });
  }, PREFILL_QUIET_MS);
}

function cancelPrefill(pane: Pane): void {
  pane.prefill = undefined;
  if (pane.prefillTimer !== undefined) window.clearTimeout(pane.prefillTimer);
  pane.prefillTimer = undefined;
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
  pane.restoreGeneration++;
  pane.restoring = false;
  pane.restorePending = [];
  pane.term.options.disableStdin = false;
  const saved = state.terminalSizes?.[termId];
  let cols = saved && Number.isInteger(saved.cols) && saved.cols >= 2 && saved.cols <= 5000 ? saved.cols : 80;
  let rows = saved && Number.isInteger(saved.rows) && saved.rows >= 1 && saved.rows <= 5000 ? saved.rows : 24;
  pane.started = false;
  pane.term.resize(cols, rows);
  if (pane.opened) {
    const dims = pane.fit.proposeDimensions();
    if (dims && dims.cols > 0 && dims.rows > 0) {
      pane.fit.fit();
      cols = pane.term.cols;
      rows = pane.term.rows;
    }
  }
  pane.started = !attach;
  // Al reconectar llega de golpe todo el buffer guardado: no es trabajo nuevo.
  pane.ignoreUntil = Date.now() + REPLAY_GRACE_MS;
  pane.ticks = [];
  post({ type: attach ? 'attach' : 'spawn', termId, cols, rows });
}

function disposePane(pane: Pane): void {
  cancelPrefill(pane);
  if (pane.quietTimer !== undefined) window.clearTimeout(pane.quietTimer);
  if (pane.fitTimer !== undefined) window.clearTimeout(pane.fitTimer);
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
  if (pane?.opened && bootDismissed) pane.term.focus();
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
    } else if (openUsageId) {
      ev.preventDefault();
      ev.stopPropagation();
      openUsageId = null;
      renderUsagePopover();
    } else if (focusPopoverOpen) {
      ev.preventDefault();
      ev.stopPropagation();
      setFocusPopover(false);
    } else if (fontPopoverOpen) {
      ev.preventDefault();
      ev.stopPropagation();
      setFontPopover(false);
      if (!gitActive) activePane()?.term.focus();
    }
  },
  true,
);

// ---------------------------------------------------------------- barra de pestañas

function renderTabBar(): void {
  tabbarEl.replaceChildren();
  const brand = document.createElement('span');
  brand.className = 'workspace-brand';
  brand.title = 'Muxentra';
  brand.setAttribute('aria-label', 'Muxentra');
  brand.innerHTML = brandMark('toolbar');
  const tabs = document.createElement('div');
  tabs.className = 'workspace-tabs';
  const actions = document.createElement('div');
  actions.className = 'workspace-actions';
  tabbarEl.append(brand, tabs, actions);
  if (gitEnabled) {
    const gitTab = document.createElement('button');
    gitTab.type = 'button';
    gitTab.className = `tab git-tab${gitActive ? ' active' : ''}`;
    gitTab.title = 'Historial Git';
    gitTab.setAttribute('aria-label', 'Historial Git');
    gitTab.setAttribute('aria-pressed', String(gitActive));
    gitTab.innerHTML = ICONS.branch;
    gitTab.addEventListener('click', activateGit);
    tabs.append(gitTab);
  }
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (!gitActive && tab.id === state.activeTabId ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-pressed', String(!gitActive && tab.id === state.activeTabId));
    el.addEventListener('keydown', event => {
      if (event.target !== el || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      activateTab(tab.id);
    });

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
      if (gitActive || state.activeTabId !== tab.id) activateTab(tab.id);
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
    tabs.append(el);
  }
  const add = iconButton(ICONS.add, 'Nueva pestaña (Ctrl+Shift+T)', () => newTab());
  add.classList.add('tab-add');
  const openGit = iconButton(ICONS.branch, gitActive ? 'Git ya está abierto' : 'Abrir Git', activateGit);
  openGit.classList.add('tab-git-action');
  openGit.setAttribute('aria-label', openGit.title);
  openGit.disabled = gitActive;
  const focus = iconButton(ICONS.timer, 'Configurar temporizador de enfoque', () => setFocusPopover(!focusPopoverOpen));
  focus.classList.add('tab-focus');
  focus.classList.toggle('active', focusTimer.enabled);
  focus.setAttribute('aria-label', focus.title);
  focus.setAttribute('aria-controls', 'focus-popover');
  focus.setAttribute('aria-expanded', String(focusPopoverOpen));
  const notifications = iconButton(
    settings.notificationsEnabled ? ICONS.bell : ICONS.bellOff,
    settings.notificationsEnabled ? 'Desactivar notificaciones' : 'Activar notificaciones',
    () => post({ type: 'setNotifications', enabled: !settings.notificationsEnabled }),
  );
  notifications.classList.add('tab-notifications');
  notifications.setAttribute('aria-label', notifications.title);
  notifications.setAttribute('aria-pressed', String(settings.notificationsEnabled));
  const font = iconButton(ICONS.font, 'Tipografía de la terminal', () => setFontPopover(!fontPopoverOpen));
  font.classList.add('tab-font');
  font.classList.toggle('active', !!settings.customFontFamily || !!settings.customFontSize);
  font.setAttribute('aria-label', font.title);
  font.setAttribute('aria-controls', 'font-popover');
  font.setAttribute('aria-expanded', String(fontPopoverOpen));
  actions.append(add, openGit, focus, font, notifications);
  tabs.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
  if (gitActive) post({ type: 'gitVisibility', visible: false });
  gitActive = false;
  contentEl.hidden = false;
  gitEl.hidden = true;
  gitEl.classList.remove('git-entering');
  updateBottomBarVisibility();
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
      if (bootDismissed) panes.get(tab.activeTermId)?.term.focus();
    });
  }
  updateBoot();
  persist();
}

function activateGit(): void {
  if (gitActive) return;
  gitEnabled = true;
  gitActive = true;
  post({ type: 'gitVisibility', visible: true });
  contentEl.hidden = true;
  gitEl.hidden = false;
  gitEl.classList.add('git-entering');
  setFocusPopover(false);
  setFontPopover(false);
  updateBottomBarVisibility();
  renderTabBar();
  post({ type: 'git', message: { type: 'refresh' } });
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
    updateBoot();
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
  const ids = gitEnabled ? ['git', ...state.tabs.map(tab => tab.id)] : state.tabs.map(tab => tab.id);
  const count = ids.length;
  if (count < 2) return;
  const index = ids.indexOf(gitActive ? 'git' : state.activeTabId);
  const next = ids[(index + delta + count) % count];
  if (next === 'git') activateGit();
  else activateTab(next);
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
      if (gitActive) activateTab(state.activeTabId);
      else closeTab(state.activeTabId);
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
      if (!gitActive) activePane()?.term.focus();
      break;
    case 'openGit':
      activateGit();
      break;
    case 'focusTerm': {
      const termId = arg && panes.has(arg) ? arg : undefined;
      if (!termId) break;
      const tab = tabOf(termId);
      if (!tab) break;
      if (gitActive || tab.id !== state.activeTabId) activateTab(tab.id);
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

  // xterm envía \r tanto para Enter como para Shift+Enter. La secuencia CSI-u
  // conserva el modificador para que Claude Code inserte una línea nueva.
  if (key === 'enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.isComposing) {
    if (ev.type === 'keydown') pane.term.input('\x1b[13;2u');
    ev.preventDefault();
    ev.stopPropagation();
    return false;
  }

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

// ---------------------------------------------------------------- temporizador de enfoque

function updateBottomBarVisibility(): void {
  bottomBarEl.hidden = gitActive || (!showUsage && !focusTimer.enabled);
}

function setFocusPopover(open: boolean, anchor: 'top' | 'bottom' = 'top'): void {
  focusPopoverOpen = open;
  focusPopoverEl.hidden = !open;
  focusPopoverEl.classList.toggle('from-bottom', open && anchor === 'bottom');
  tabbarEl.querySelector('.tab-focus')?.setAttribute('aria-expanded', String(open));
  focusStatusEl.setAttribute('aria-expanded', String(open));
  if (!open) return;
  openUsageId = null;
  renderUsagePopover();
  if (fontPopoverOpen) setFontPopover(false);
  focusWorkEl.value = String(focusTimer.workMinutes);
  focusBreakEl.value = String(focusTimer.breakMinutes);
  focusSoundEl.value = focusTimer.sound;
  if (focusTimer.enabled) {
    try { prepareAudio(); } catch { /* El panel puede funcionar sin audio. */ }
  }
  updateFocusActions();
  focusWorkEl.focus();
}

// ---------------------------------------------------------------- tipografía

let fontPopoverOpen = false;
/** Vienen dentro de la extensión (assets/fonts, licencia OFL): siempre disponibles. */
const BUNDLED_FONTS = ['Fira Code', 'JetBrains Mono'];
/** Familias monoespaciadas habituales; solo se listan las que estén instaladas. */
const FONT_CANDIDATES = [
  'MesloLGM Nerd Font', 'MesloLGS Nerd Font', 'MesloLGM Nerd Font Mono', 'JetBrainsMono Nerd Font', 'JetBrainsMono Nerd Font Mono',
  'FiraCode Nerd Font', 'FiraCode Nerd Font Mono', 'CaskaydiaCove Nerd Font', 'CaskaydiaCove Nerd Font Mono', 'Hack Nerd Font',
  'Hack Nerd Font Mono', 'SauceCodePro Nerd Font', 'UbuntuMono Nerd Font', 'DejaVuSansM Nerd Font', 'RobotoMono Nerd Font',
  'Iosevka Nerd Font', '0xProto Nerd Font', 'GeistMono Nerd Font', 'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Source Code Pro',
  'Hack', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Menlo', 'Monaco', 'SF Mono', 'Iosevka', 'Victor Mono', 'IBM Plex Mono', 'Roboto Mono',
  'Geist Mono', 'Courier New',
];
const fontAvailability = new Map<string, boolean>();

/**
 * Un webview no puede enumerar las fuentes del sistema, pero sí medir: si un
 * texto cambia de ancho al pedir la familia con distintas alternativas, la
 * familia existe. Comparar contra serif y sans-serif evita el falso negativo
 * de dos monoespaciadas con el mismo avance.
 */
function fontAvailable(family: string): boolean {
  if (BUNDLED_FONTS.includes(family)) return true;
  const cached = fontAvailability.get(family);
  if (cached !== undefined) return cached;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return false;
  const sample = 'mmmmmmmmmmlliI1|{}[]=>~@';
  const differs = (fallback: string): boolean => {
    context.font = `72px ${fallback}`;
    const base = context.measureText(sample).width;
    context.font = `72px "${family.replace(/"/g, '')}", ${fallback}`;
    return context.measureText(sample).width !== base;
  };
  const available = differs('serif') || differs('sans-serif') || differs('monospace');
  fontAvailability.set(family, available);
  return available;
}

function setFontPopover(open: boolean): void {
  fontPopoverOpen = open;
  fontPopoverEl.hidden = !open;
  tabbarEl.querySelector('.tab-font')?.setAttribute('aria-expanded', String(open));
  if (!open) return;
  setFocusPopover(false);
  openUsageId = null;
  renderUsagePopover();
  renderFontList();
  fontListEl.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}

function chooseFont(fontFamily: string): void {
  post({ type: 'setFont', fontFamily });
  settings = { ...settings, customFontFamily: fontFamily, fontFamily: fontFamily || settings.inheritedFontFamily };
  renderFontList();
}

function renderFontList(): void {
  const current = settings.customFontFamily;
  const entries: { family: string; label: string; tag: string }[] = [
    { family: '', label: 'Igual que VS Code', tag: settings.inheritedFontFamily },
  ];
  if (current && !BUNDLED_FONTS.includes(current) && !FONT_CANDIDATES.includes(current)) {
    entries.push({ family: current, label: current, tag: 'actual' });
  }
  for (const family of BUNDLED_FONTS) entries.push({ family, label: family, tag: 'incluida' });
  for (const family of FONT_CANDIDATES) {
    if (fontAvailable(family)) entries.push({ family, label: family, tag: /nerd font/i.test(family) ? 'Nerd Font · iconos' : 'instalada' });
  }
  fontListEl.replaceChildren(...entries.map(entry => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'font-option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(entry.family === current));
    option.style.fontFamily = entry.family ? `"${entry.family.replace(/"/g, '')}"` : settings.inheritedFontFamily;
    const name = document.createElement('span');
    name.className = 'font-option-name';
    name.textContent = entry.label;
    const sample = document.createElement('span');
    sample.className = 'font-option-sample';
    sample.textContent = 'Aa 0O il1 {} -> => ~/src';
    const tag = document.createElement('span');
    tag.className = 'font-option-tag';
    tag.textContent = entry.tag;
    option.append(name, sample, tag);
    option.addEventListener('click', () => chooseFont(entry.family));
    return option;
  }));
  fontSizeValueEl.textContent = String(settings.fontSize);
  fontResetEl.disabled = !current && !settings.customFontSize;
}

fontCustomFormEl.addEventListener('submit', ev => {
  ev.preventDefault();
  const family = fontCustomEl.value.trim();
  if (!family) return;
  fontCustomEl.value = '';
  chooseFont(family);
});
const stepFontSize = (delta: number): void => {
  const size = Math.min(40, Math.max(6, settings.fontSize + delta));
  post({ type: 'setFont', fontSize: size });
  settings = { ...settings, fontSize: size, customFontSize: size };
  fontSizeValueEl.textContent = String(size);
  fontResetEl.disabled = false;
};
fontSizeMinusEl.addEventListener('click', () => stepFontSize(-1));
fontSizePlusEl.addEventListener('click', () => stepFontSize(1));
fontResetEl.addEventListener('click', () => {
  post({ type: 'setFont', fontFamily: '', fontSize: 0 });
  settings = { ...settings, customFontFamily: '', fontFamily: settings.inheritedFontFamily, customFontSize: 0, fontSize: settings.inheritedFontSize };
  renderFontList();
});
// Cargar las incluidas desde el principio: así el primer render con ellas ya sale bien.
for (const family of BUNDLED_FONTS) void document.fonts.load(`12px "${family}"`).catch(() => undefined);

function updateFocusActions(): void {
  focusSaveEl.textContent = focusTimer.enabled ? 'Guardar ajustes' : 'Iniciar';
  focusActionsEl.hidden = !focusTimer.enabled;
  focusToggleEl.textContent = focusTimer.running ? 'Pausar' : 'Reanudar';
  focusHintEl.textContent = !focusTimer.enabled
    ? 'Los bloques de trabajo y descanso se alternan automáticamente.'
    : focusTimer.running
      ? 'Los cambios de duración se aplican al siguiente bloque.'
      : 'En pausa. Al guardar, el bloque actual toma la nueva duración.';
}

function renderFocus(next: FocusTimerState, now: number): void {
  const enabledChanged = focusTimer.enabled !== next.enabled;
  focusTimer = next;
  focusEl.hidden = !next.enabled;
  updateBottomBarVisibility();
  if (enabledChanged) {
    renderTabBar();
    fitVisible();
  }
  if (!next.enabled) {
    if (focusPopoverOpen) updateFocusActions();
    return;
  }
  const seconds = Math.max(0, Math.ceil((next.running && next.endsAt !== null ? next.endsAt - now : next.remainingMs) / 1000));
  const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const phase = next.phase === 'work' ? 'Trabajo' : 'Descanso';
  focusEl.classList.toggle('break', next.phase === 'break');
  focusEl.classList.toggle('paused', !next.running);
  focusPhaseEl.textContent = next.running ? phase : `${phase} en pausa`;
  focusTimeEl.textContent = time;
  focusStatusEl.setAttribute('aria-label', `${phase}${next.running ? '' : ' en pausa'}, ${time} restantes. Abrir temporizador`);
  focusPauseEl.innerHTML = next.running ? ICONS.pause : ICONS.play;
  focusPauseEl.setAttribute('aria-label', next.running ? 'Pausar temporizador' : 'Reanudar temporizador');
  focusPauseEl.title = focusPauseEl.getAttribute('aria-label') ?? '';
  if (focusPopoverOpen) updateFocusActions();
}

focusFormEl.addEventListener('submit', ev => {
  ev.preventDefault();
  if (!focusFormEl.reportValidity()) return;
  if (!focusTimer.enabled) {
    try { prepareAudio(); } catch { /* El temporizador puede funcionar sin audio. */ }
  }
  const workMinutes = Number(focusWorkEl.value);
  const breakMinutes = Number(focusBreakEl.value);
  const sound = validFocusSound(focusSoundEl.value) ? focusSoundEl.value : focusTimer.sound;
  post({ type: 'focusTimer', action: focusTimer.enabled ? 'configure' : 'start', workMinutes, breakMinutes, sound });
  setFocusPopover(false);
});
focusStatusEl.addEventListener('click', () => setFocusPopover(!focusPopoverOpen, 'bottom'));
function toggleFocusPlayback(): void {
  if (!focusTimer.running) {
    try { prepareAudio(); } catch { /* El temporizador puede funcionar sin audio. */ }
  }
  post({ type: 'focusTimer', action: focusTimer.running ? 'pause' : 'resume' });
}
focusPauseEl.addEventListener('click', toggleFocusPlayback);
focusToggleEl.addEventListener('click', toggleFocusPlayback);
focusSkipEl.addEventListener('click', () => post({ type: 'focusTimer', action: 'skip' }));
focusPreviewEl.addEventListener('click', () => {
  const sound = validFocusSound(focusSoundEl.value) ? focusSoundEl.value : focusTimer.sound;
  playFocusChime('work', sound);
});
focusStopEl.addEventListener('click', () => {
  post({ type: 'focusTimer', action: 'stop' });
  setFocusPopover(false);
});

// ---------------------------------------------------------------- barra de uso

let showUsage = true;
let usageSnapshot: UsageSnapshot | null = null;
let openUsageId: UsageItem['id'] | null = null;

function severity(percent: number): string {
  if (percent >= 0.85) return 'crit';
  if (percent >= 0.6) return 'warn';
  return 'ok';
}

function renderUsage(snapshot: UsageSnapshot | null): void {
  usageSnapshot = snapshot;
  if (!showUsage) {
    openUsageId = null;
    renderUsagePopover();
    usageEl.hidden = true;
    usageEl.replaceChildren();
    updateBottomBarVisibility();
    fitVisible();
    return;
  }
  // Reservar el espacio desde el inicio evita que la primera lectura cambie
  // la altura de la terminal mientras el agente está dibujando su interfaz.
  const items: UsageItem[] = (['claude', 'codex'] as const).map(id =>
    snapshot?.items.find(item => item.id === id) ?? {
      id, label: id === 'claude' ? 'Claude' : 'Codex', windows: [],
    },
  );
  usageEl.hidden = false;
  updateBottomBarVisibility();
  const focused = document.activeElement as HTMLElement | null;
  const focusedProvider = usageEl.contains(focused) ? focused?.closest<HTMLElement>('.usage-item')?.dataset.provider : undefined;
  const focusedRefresh = focused?.classList.contains('usage-refresh') && usageEl.contains(focused);
  const spacer = document.createElement('span');
  spacer.className = 'usage-spacer';
  usageEl.replaceChildren(...items.map(renderUsageItem), spacer, renderUsageRefresh(snapshot?.updatedAt));
  if (focusedProvider) usageEl.querySelector<HTMLButtonElement>(`[data-provider="${focusedProvider}"]`)?.focus({ preventScroll: true });
  else if (focusedRefresh) usageEl.querySelector<HTMLButtonElement>('.usage-refresh')?.focus({ preventScroll: true });
  renderUsagePopover();
  fitVisible();
}

function renderUsageItem(item: UsageItem): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `usage-item ${item.id}`;
  el.dataset.provider = item.id;
  el.setAttribute('aria-controls', 'usage-popover');
  el.setAttribute('aria-expanded', String(openUsageId === item.id));

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
  provider.append(icon, identity);
  el.append(provider);

  const metrics = document.createElement('span');
  metrics.className = 'usage-metrics';

  for (const w of item.windows.length ? item.windows : [{ label: 'uso', percent: undefined, stale: false }]) {
    const percent = w.percent === undefined ? undefined : Math.round(w.percent * 100);
    const chunk = document.createElement('span');
    chunk.className = `usage-win ${w.percent === undefined ? 'pending' : severity(w.percent)}${w.stale ? ' stale' : ''}`;

    const name = document.createElement('span');
    name.className = 'usage-win-label';
    name.textContent = w.label;

    const bar = document.createElement('span');
    bar.className = 'usage-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `${item.label}, ${w.label}: ${percent === undefined ? 'pendiente de datos' : `${percent}% consumido${w.stale ? ', dato sin actualizar' : ''}`}`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    if (percent !== undefined) bar.setAttribute('aria-valuenow', String(percent));
    else bar.setAttribute('aria-valuetext', 'Pendiente de datos');
    const fill = document.createElement('i');
    fill.style.width = `${percent ?? 0}%`;
    bar.append(fill);

    const value = document.createElement('span');
    value.className = 'usage-pct';
    value.textContent = percent === undefined ? '—' : `${percent}%`;

    chunk.append(name, bar, value);
    metrics.append(chunk);
  }

  const reset = document.createElement('span');
  reset.className = 'usage-reset';
  reset.innerHTML = `${ICONS.timer}<strong class="usage-reset-time"></strong>`;
  metrics.firstElementChild!.append(reset);
  el.append(metrics);

  const status = item.windows.length ? item.detail : item.error ? 'Lectura pendiente' : 'Sin datos de cuota';
  if (status) {
    const detail = document.createElement('span');
    detail.className = 'usage-detail';
    detail.classList.add('status');
    if (!item.windows.length) detail.classList.add('pending');
    detail.textContent = status;
    metrics.append(detail);
  }

  updateUsageReset(el, item);
  el.addEventListener('click', () => {
    if (focusPopoverOpen) setFocusPopover(false);
    openUsageId = openUsageId === item.id ? null : item.id;
    renderUsagePopover();
  });
  return el;
}

function updateUsageReset(el: HTMLButtonElement, item: UsageItem): void {
  const reset = el.querySelector<HTMLElement>('.usage-reset')!;
  const window = preferredUsageReset(item.windows);
  const duration = formatReset(window?.resetsAt);
  const period = window?.label === '5h' ? '5h' : 'semanal';
  const targetWindow = window
    ?? item.windows.find(w => w.label === '5h')
    ?? item.windows.find(w => w.label === '7d' || w.label === 'semana');
  const chunks = el.querySelectorAll<HTMLElement>('.usage-win');
  const target = chunks[Math.max(0, targetWindow ? item.windows.indexOf(targetWindow) : 0)];
  if (reset.parentElement !== target) {
    reset.parentElement?.classList.remove('has-reset');
    target.append(reset);
  }
  target.classList.add('has-reset');
  reset.classList.toggle('pending', !window);
  reset.dataset.window = window ? period : '';
  reset.querySelector('.usage-reset-time')!.textContent = duration ?? '—';
  reset.title = window ? `Reinicio ${period} en ${duration} · ${new Date(window.resetsAt! * 1000).toLocaleString()}` : 'Reinicio pendiente: sin un horario actualizado.';
  const summary = item.windows.map(w => `${w.label} ${w.percent === undefined ? 'pendiente' : `${Math.round(w.percent * 100)}%`}`).join(', ');
  const resetSummary = window ? `Reinicio ${period} en ${duration}` : 'Reinicio pendiente';
  el.setAttribute('aria-label', `${item.label}: ${summary || 'sin datos de cuota'}. ${resetSummary}. Ver detalle`);
  el.title = usageTooltip(item);
}

function refreshUsageResets(): void {
  if (!showUsage || document.hidden || usageEl.hidden) return;
  for (const el of usageEl.querySelectorAll<HTMLButtonElement>('.usage-item')) {
    const item = usageSnapshot?.items.find(item => item.id === el.dataset.provider);
    if (item) updateUsageReset(el, item);
  }
}

// Update the countdown in place without recreating cards, moving focus or polling providers.
window.setInterval(refreshUsageResets, 30_000);
document.addEventListener('visibilitychange', refreshUsageResets);

function renderUsagePopover(): void {
  const item = usageSnapshot?.items.find(value => value.id === openUsageId);
  const focusedRefresh = usagePopoverEl.contains(document.activeElement);
  usagePopoverEl.hidden = !item || !showUsage;
  usagePopoverEl.replaceChildren();
  for (const button of usageEl.querySelectorAll<HTMLButtonElement>('.usage-item')) {
    button.setAttribute('aria-expanded', String(button.dataset.provider === openUsageId));
  }
  if (!item || !showUsage) return;

  const trigger = usageEl.querySelector<HTMLElement>(`[data-provider="${item.id}"]`);
  const app = document.getElementById('app') as HTMLElement;
  if (trigger) usagePopoverEl.style.left = `${Math.max(8, Math.min(trigger.offsetLeft, app.clientWidth - 328))}px`;

  const header = document.createElement('div');
  header.className = 'usage-popover-header';
  const heading = document.createElement('strong');
  heading.textContent = item.plan ? `${item.label} · ${item.plan}` : item.label;
  const age = document.createElement('span');
  age.textContent = item.updatedAt
    ? `Dato de ${new Date(item.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'Sin lectura reciente';
  header.append(heading, age);
  usagePopoverEl.append(header);

  for (const window of item.windows) {
    const row = document.createElement('div');
    row.className = `usage-popover-row ${window.percent === undefined ? 'pending' : severity(window.percent)}${window.stale ? ' stale' : ''}`;
    const top = document.createElement('div');
    top.className = 'usage-popover-row-head';
    const name = document.createElement('span');
    name.textContent = window.label === '5h' ? 'Sesión' : window.label === '7d' ? 'Semanal' : window.label;
    const value = document.createElement('strong');
    value.textContent = window.percent === undefined ? 'Pendiente' : `${Math.round(window.percent * 100)}%`;
    top.append(name, value);
    const bar = document.createElement('div');
    bar.className = 'usage-popover-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `${item.label}, ${name.textContent}`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    if (window.percent !== undefined) bar.setAttribute('aria-valuenow', String(Math.round(window.percent * 100)));
    else bar.setAttribute('aria-valuetext', 'Pendiente de datos');
    const fill = document.createElement('i');
    fill.style.width = `${Math.round((window.percent ?? 0) * 100)}%`;
    bar.append(fill);
    row.append(top, bar);
    const reset = formatReset(window.resetsAt);
    if (reset || window.stale) {
      const note = document.createElement('span');
      note.className = 'usage-popover-note';
      note.textContent = window.stale ? 'Sin actualizar' : `Se reinicia en ${reset}`;
      row.append(note);
    }
    usagePopoverEl.append(row);
  }
  if (!item.windows.length || item.detail) {
    const note = document.createElement('div');
    note.className = 'usage-popover-empty';
    note.textContent = item.detail ?? 'Sin datos de cuota';
    usagePopoverEl.append(note);
  }
  const refresh = renderUsageRefresh(usageSnapshot?.updatedAt);
  usagePopoverEl.append(refresh);
  if (focusedRefresh) refresh.focus({ preventScroll: true });
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
    ? `Consultado ${new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
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
    lines.push(`${w.label}: ${w.percent === undefined ? 'pendiente de un dato nuevo' : `${Math.round(w.percent * 100)}%`}${reset ? ` · se reinicia en ${reset} (${when})` : ''}${w.stale ? ' · sin actualizar' : ''}`);
  }
  if (!item.windows.length) lines.push('Porcentaje de cuota no disponible. El conteo local de tokens no equivale al porcentaje del plan.');
  if (item.detail) lines.push(item.detail);
  if (item.error) lines.push(item.error);
  if (item.updatedAt) lines.push(`Dato de ${new Date(item.updatedAt).toLocaleString()}`);
  lines.push('Clic para ver el detalle del consumo.');
  return lines.join('\n');
}

document.addEventListener('mousedown', ev => {
  const target = ev.target as HTMLElement;
  if (focusPopoverOpen && !focusPopoverEl.contains(target) && !focusEl.contains(target) && !target.closest('.tab-focus')) {
    setFocusPopover(false);
  }
  if (fontPopoverOpen && !fontPopoverEl.contains(target) && !target.closest('.tab-font')) setFontPopover(false);
  if (!openUsageId) return;
  if (usagePopoverEl.contains(target) || usageEl.contains(target)) return;
  openUsageId = null;
  renderUsagePopover();
});

// ---------------------------------------------------------------- mensajes del host

async function onInit(msg: Extract<HostMessage, { type: 'init' }>): Promise<void> {
  gitEnabled = msg.showGit;
  await applySettings(msg.settings);
  showUsage = msg.showUsage;
  renderUsage(usageSnapshot);
  renderFocus(msg.focusTimer, Date.now());
  const alive = new Set(msg.alive);
  const exited = new Set(msg.exited);

  if (msg.layout && Array.isArray(msg.layout.tabs)) {
    state.terminalSizes = msg.layout.terminalSizes;
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
    beginBoot();
    return;
  }
  if (!state.tabs.some(t => t.id === state.activeTabId)) state.activeTabId = state.tabs[0].id;

  for (const tab of state.tabs) ensureContent(tab);
  for (const tab of state.tabs) renderTab(tab);
  activateTab(state.activeTabId);
  beginBoot();
  for (const tab of state.tabs) {
    for (const lf of L.leaves(tab.root)) startPane(lf.termId, alive.has(lf.termId));
  }
  persist();
}

let initPromise: Promise<void> = Promise.resolve();
window.addEventListener('message', (ev: MessageEvent<HostMessage>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      initPromise = onInit(msg);
      break;
    case 'git':
      gitView.handleMessage(msg.message);
      break;
    case 'data': {
      const pane = panes.get(msg.termId);
      if (pane) {
        noteOutput(pane, msg.data);
        if (pane.restoring) {
          pane.restorePending.push(msg.data);
        } else {
          writeKeepingView(pane, msg.data,
            !bootDismissed && !bootReady.has(msg.termId) ? () => markBootReady(msg.termId) : undefined);
          schedulePrefill(pane);
        }
      }
      break;
    }
    case 'restore': {
      const pane = panes.get(msg.termId);
      if (pane) {
        pane.prefill = msg.resume === 'claude' ? 'claude --continue' : msg.resume === 'codex' ? 'codex resume --last' : undefined;
        restoreTerminal(pane, msg.snapshot);
      }
      break;
    }
    case 'geometry': {
      const pane = panes.get(msg.termId);
      if (pane) {
        if (msg.geometry.windowsPty) pane.term.options.windowsPty = msg.geometry.windowsPty;
        pane.started = true;
        scheduleFit(pane);
        // Con el pty vivo ya se puede escribir; el respiro deja pintar un prompt rápido.
        if (!bootDismissed && !bootReady.has(msg.termId)) {
          window.setTimeout(() => {
            if (panes.get(msg.termId) === pane && !pane.restoring) markBootReady(msg.termId);
          }, 300);
        }
      }
      break;
    }
    case 'exit':
      closePane(msg.termId, true);
      updateBoot();
      break;
    case 'spawnError': {
      const pane = panes.get(msg.termId);
      pane?.term.write(`\r\n\x1b[31mNo se pudo iniciar el shell: ${msg.message}\x1b[0m\r\n`, () => markBootReady(msg.termId));
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
    case 'focusTimer':
      renderFocus(msg.timer, msg.now);
      if (msg.completedPhase && Date.now() >= msg.now && Date.now() - msg.now < 3_000) {
        playFocusChime(msg.completedPhase, msg.timer.sound);
      }
      break;
    case 'branch':
      setBranch(msg.termId, msg.branch, msg.detached, msg.cwd);
      break;
    case 'command':
      void initPromise.then(() => runCommand(msg.command, msg.arg));
      break;
  }
});

new MutationObserver(applyTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['style', 'class'],
});
new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
window.addEventListener('focus', () => { if (bootDismissed && !gitActive) activePane()?.term.focus(); });

// Git carga por su cuenta: la apertura ya no lo espera.
gitView = mountGitView(gitEl, gitEl.dataset.styleUri ?? '', message => post({ type: 'git', message }), () => {});
const syncGitTheme = (): void => { gitEl.classList.toggle('vscode-light', document.body.classList.contains('vscode-light')); };
syncGitTheme();
new MutationObserver(syncGitTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
post({ type: 'ready' });
