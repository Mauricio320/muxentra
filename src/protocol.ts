// Tipos compartidos entre el extension host y el webview.

export type SplitDir = 'row' | 'col';

export interface LeafNode {
  kind: 'leaf';
  id: string;
  termId: string;
  /** Nombre puesto a mano; gana sobre el título que reporta el shell. */
  name?: string;
}

export interface SplitNode {
  kind: 'split';
  id: string;
  dir: SplitDir;
  children: LayoutNode[];
  /** Fracciones (suman 1) con el tamaño de cada hijo. */
  sizes: number[];
}

export type LayoutNode = LeafNode | SplitNode;

export interface TabState {
  id: string;
  name: string;
  root: LayoutNode;
  activeTermId: string;
  /** Clave de color de la paleta (ver TAB_COLORS en el webview). */
  color?: string;
}

export interface WorkspaceLayout {
  tabs: TabState[];
  activeTabId: string;
  nextTabNumber: number;
}

export interface TermSettings {
  fontFamily: string;
  fontSize: number;
  letterSpacing: number;
  lineHeight: number;
  fontWeight: TerminalFontWeight;
  fontWeightBold: TerminalFontWeight;
  scrollback: number;
  cursorBlink: boolean;
  platform: string;
  windowsBuildNumber: number;
  /** Seguimiento del estado de cada terminal (trabajando, terminó, pide atención). */
  agentStatus: boolean;
  /** Segundos de silencio tras los que una terminal ocupada se da por terminada. */
  quietSeconds: number;
  /** Sonido corto cuando una terminal pide atención. */
  attentionSound: boolean;
}

export type TerminalFontWeight =
  | 'normal'
  | 'bold'
  | '100'
  | '200'
  | '300'
  | '400'
  | '500'
  | '600'
  | '700'
  | '800'
  | '900';

// ---------------------------------------------------------------- uso de agentes

export interface UsageWindow {
  /** Etiqueta corta de la ventana: "5h", "7d", "semana". */
  label: string;
  /** 0 a 1. */
  percent: number;
  /** Epoch en segundos en que se reinicia la ventana. */
  resetsAt?: number;
}

export interface UsageItem {
  id: 'claude' | 'codex';
  label: string;
  windows: UsageWindow[];
  /** Texto extra cuando no hay porcentajes (p. ej. tokens de las últimas 5 h). */
  detail?: string;
  /** Plan detectado, si el origen lo reporta. */
  plan?: string;
  /** Marca de tiempo (ms) del dato de origen. */
  updatedAt?: number;
  /** Explicación de por qué no hay datos. */
  error?: string;
}

export interface UsageSnapshot {
  items: UsageItem[];
  updatedAt: number;
}

// ---------------------------------------------------------------- estado de cada terminal

/**
 * Estado de trabajo de una terminal, deducido de lo que escribe en pantalla:
 * - `busy`: está produciendo salida de forma sostenida (un agente pensando, un build).
 * - `done`: estaba ocupada y se quedó en silencio: terminó y nadie la está mirando.
 * - `attention`: pidió algo explícitamente (campana o secuencia de notificación).
 * - `idle`: sin novedades, o el usuario ya la vio.
 */
export type PaneActivity = 'idle' | 'busy' | 'done' | 'attention';

export type MuxentraCommand =
  | 'newTab'
  | 'closeTab'
  | 'renameTab'
  | 'renamePane'
  | 'nextTab'
  | 'prevTab'
  | 'splitRight'
  | 'splitDown'
  | 'closePane'
  | 'focusNextPane'
  | 'focusPrevPane'
  | 'equalize'
  | 'tabColor'
  | 'copy'
  | 'paste'
  | 'refit'
  /** Va a la terminal cuyo id llega en `arg`; sin arg, a la primera que pide atención. */
  | 'focusTerm';

/** Mensajes que envía el webview al extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'spawn'; termId: string; cols: number; rows: number }
  | { type: 'attach'; termId: string; cols: number; rows: number }
  | { type: 'input'; termId: string; data: string }
  | { type: 'resize'; termId: string; cols: number; rows: number }
  | { type: 'kill'; termId: string }
  | { type: 'layout'; layout: WorkspaceLayout }
  | { type: 'copy'; text: string }
  | { type: 'refreshUsage' }
  /** Directorio que reportó el shell (OSC 7, OSC 9;9 o el título). */
  | { type: 'cwd'; termId: string; cwd: string }
  /** Cambió el estado de una terminal. `label` es su nombre visible. */
  | { type: 'activity'; termId: string; state: PaneActivity; label: string; message?: string };

/** Mensajes que envía el extension host al webview. */
export type HostMessage =
  | {
      type: 'init';
      layout: WorkspaceLayout | null;
      settings: TermSettings;
      /** Terminales cuyo proceso sigue vivo (reconexión tras cerrar el panel). */
      alive: string[];
      /** Terminales cuyo proceso terminó mientras el panel estaba cerrado. */
      exited: string[];
      showUsage: boolean;
    }
  | { type: 'data'; termId: string; data: string }
  | { type: 'exit'; termId: string; code: number }
  | { type: 'spawnError'; termId: string; message: string }
  /** Se perdió el servidor de terminales: todas las terminales deben reiniciar su shell. */
  | { type: 'serverLost' }
  | { type: 'settings'; settings: TermSettings }
  | { type: 'usage'; usage: UsageSnapshot | null; showUsage: boolean }
  /** Rama de la terminal; branch null cuando el directorio no está en un repositorio. */
  | { type: 'branch'; termId: string; branch: string | null; detached: boolean; cwd: string | null }
  | { type: 'command'; command: MuxentraCommand; arg?: string };
