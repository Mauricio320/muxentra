// Tipos compartidos entre el extension host y el webview.
import type { GitHostMessage, GitViewMessage } from './gitPanel';

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
  terminalSizes?: Record<string, { cols: number; rows: number }>;
}

export interface TerminalGeometry {
  cols: number;
  rows: number;
  /** Capacidad del backend real, que puede ser distinto del ConPTY del SO. */
  windowsPty?: { backend: 'conpty'; buildNumber: number };
}

export interface TerminalSnapshot extends TerminalGeometry {
  data: string;
}

/** Agente que corría en una terminal cuando se guardó su historial en disco. */
export type ResumeAgent = 'claude' | 'codex';

export interface ProfileSwitchStatus {
  state: 'waiting' | 'switching' | 'ready' | 'error';
  message: string;
  blockInput?: boolean;
}

export interface TermSettings {
  /** Fuente efectiva: la propia de Muxentra si está puesta, si no la heredada. */
  fontFamily: string;
  fontSize: number;
  letterSpacing: number;
  lineHeight: number;
  fontWeight: TerminalFontWeight;
  fontWeightBold: TerminalFontWeight;
  scrollback: number;
  /** Usar ConPTY moderno en Windows para preservar las secuencias de las TUI. */
  rebuildAwareScrollback: boolean;
  cursorBlink: boolean;
  platform: string;
  windowsBuildNumber: number;
  /** Seguimiento del estado de cada terminal (trabajando, terminó, pide atención). */
  agentStatus: boolean;
  /** Segundos de silencio tras los que una terminal ocupada se da por terminada. */
  quietSeconds: number;
  /** Sonido corto cuando una terminal pide atención. */
  attentionSound: boolean;
  /** Los avisos de VS Code están habilitados para el panel. */
  notificationsEnabled: boolean;
  /** Saludo de apertura al abrir el panel; apagado, el espacio aparece directo. */
  openingAnimation: boolean;
  /** Tamaño máximo, en bytes, de un archivo soltado sobre una terminal. */
  filePasteMaxBytes: number;
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
  /** 0 a 1; ausente cuando aún no hay un porcentaje para esta ventana. */
  percent?: number;
  /** Epoch en segundos en que se reinicia la ventana. */
  resetsAt?: number;
  /** Dato antiguo o ventana reiniciada: no representa una medición actual. */
  stale?: boolean;
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
  | 'openGit'
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

/**
 * Algo que el usuario soltó sobre una terminal. Arrastrar desde el explorador
 * de VS Code trae el URI del archivo; arrastrar desde el explorador del sistema
 * solo deja su contenido, porque el webview no ve rutas del disco.
 */
export type DropItem =
  | { kind: 'uri'; uri: string }
  | { kind: 'file'; name: string; base64: string }
  /** Pasa del límite de tamaño: no se manda el contenido, solo el aviso. */
  | { kind: 'tooBig'; name: string; size: number }
  /** El webview no pudo leerlo (una carpeta, por ejemplo). */
  | { kind: 'failed'; name: string };

/** Mensajes que envía el webview al extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'git'; message: GitViewMessage }
  | { type: 'gitVisibility'; visible: boolean }
  | { type: 'spawn'; termId: string; cols: number; rows: number }
  | { type: 'attach'; termId: string; cols: number; rows: number }
  | { type: 'input'; termId: string; data: string }
  | { type: 'resize'; termId: string; cols: number; rows: number }
  | { type: 'kill'; termId: string }
  | { type: 'layout'; layout: WorkspaceLayout }
  | { type: 'copy'; text: string }
  /** Enlace que el usuario abrió con Ctrl/Cmd + clic en una terminal. */
  | { type: 'openLink'; url: string }
  | { type: 'refreshUsage' }
  /** Archivos soltados sobre una terminal; el host devuelve sus rutas con `insert`. */
  | { type: 'drop'; termId: string; items: DropItem[] }
  /** Texto soltado sobre una terminal (una selección arrastrada desde el editor). */
  | { type: 'dropText'; termId: string; text: string }
  /** Activa o silencia los avisos de Muxentra desde la barra del panel. */
  | { type: 'setNotifications'; enabled: boolean }
  /** Directorio que reportó el shell (OSC 7, OSC 9;9 o el título). */
  | { type: 'cwd'; termId: string; cwd: string }
  /**
   * Cambió el estado de una terminal. `label` es su nombre visible y `silent`
   * marca los cambios que el usuario ya está viendo: se pintan igual, pero no
   * cuentan como espera ni generan aviso.
   */
  | { type: 'activity'; termId: string; state: PaneActivity; label: string; message?: string; silent?: boolean };

/** Mensajes que envía el extension host al webview. */
export type HostMessage =
  | { type: 'profileSwitch'; termId: string; status: ProfileSwitchStatus }
  | {
      type: 'init';
      layout: WorkspaceLayout | null;
      settings: TermSettings;
      /** Terminales cuyo proceso sigue vivo (reconexión tras cerrar el panel). */
      alive: string[];
      /** Terminales cuyo proceso terminó mientras el panel estaba cerrado. */
      exited: string[];
      showUsage: boolean;
      showGit: boolean;
    }
  | { type: 'data'; termId: string; data: string }
  /** `resume` llega cuando el historial viene del disco y un agente estaba corriendo. */
  | { type: 'restore'; termId: string; snapshot: TerminalSnapshot; resume?: ResumeAgent }
  | { type: 'geometry'; termId: string; geometry: TerminalGeometry }
  | { type: 'exit'; termId: string; code: number }
  | { type: 'spawnError'; termId: string; message: string }
  /** Se perdió el servidor de terminales: todas las terminales deben reiniciar su shell. */
  | { type: 'serverLost' }
  | { type: 'settings'; settings: TermSettings }
  | { type: 'usage'; usage: UsageSnapshot | null; showUsage: boolean }
  /** Rama de la terminal; branch null cuando el directorio no está en un repositorio. */
  | { type: 'branch'; termId: string; branch: string | null; detached: boolean; cwd: string | null }
  | { type: 'command'; command: MuxentraCommand; arg?: string }
  /** Escribe `text` en una terminal concreta, aunque el foco se haya movido. */
  | { type: 'insert'; termId: string; text: string }
  | { type: 'git'; message: GitHostMessage };
