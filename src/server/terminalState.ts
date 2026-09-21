import { Terminal, type ITerminalAddon } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { TerminalGeometry, TerminalSnapshot } from '../protocol';

export function scrollbackSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(100, Math.min(100000, Math.floor(value)))
    : 20000;
}

/** Estado VT, no registro de bytes: los repintados reemplazan sus celdas. */
export class TerminalState {
  readonly terminal: Terminal;
  private readonly serializer = new SerializeAddon();
  private pending = Promise.resolve();
  private sequence = '';
  private parserState: 'ground' | 'escape' | 'csi' | 'osc' | 'string' | 'stringEscape' = 'ground';
  private disposed = false;
  private margins: Record<'normal' | 'alternate', [number, number]>;
  private cursorVisible = true;
  private mouseEncoding = 0;

  constructor(readonly geometry: TerminalGeometry, scrollback: unknown) {
    this.margins = { normal: [1, geometry.rows], alternate: [1, geometry.rows] };
    this.terminal = new Terminal({
      ...geometry, scrollback: scrollbackSize(scrollback), allowProposedApi: true,
    });
    // El addon usa la API compartida con headless, aunque su .d.ts nombra la
    // Terminal del navegador (que también incluye métodos de DOM).
    this.terminal.loadAddon(this.serializer as unknown as ITerminalAddon);
    // SerializeAddon 0.14 no incluye DECSTBM, DECTCEM ni el formato del ratón.
    // Usar handlers públicos que observan y dejan actuar al parser de xterm.
    this.terminal.parser.registerCsiHandler({ final: 'r' }, params => {
      const top = Number(params[0]) || 1;
      const bottom = Math.min(Number(params[1]) || this.geometry.rows, this.geometry.rows);
      if (bottom > top) this.margins[this.terminal.buffer.active.type] = [top, bottom];
      return false;
    });
    for (const final of ['h', 'l']) {
      this.terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
        for (const mode of params) {
          if (mode === 25) this.cursorVisible = final === 'h';
          if (mode === 1006 || mode === 1016) this.mouseEncoding = final === 'h' ? mode : 0;
          if ([47, 1047, 1049].includes(Number(mode)) && final === 'h' && this.terminal.buffer.active.type === 'normal') {
            this.margins.alternate = [1, this.geometry.rows];
          }
        }
        return false;
      });
    }
    this.terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
      this.margins[this.terminal.buffer.active.type] = [1, this.geometry.rows];
      this.cursorVisible = true;
      return false;
    });
    this.terminal.parser.registerEscHandler({ final: 'c' }, () => {
      this.margins = { normal: [1, this.geometry.rows], alternate: [1, this.geometry.rows] };
      this.cursorVisible = true;
      this.mouseEncoding = 0;
      return false;
    });
  }

  /** Ordena salida, snapshot y resize en una sola cola, incluido el parser async. */
  run(action: () => void | Promise<void>): Promise<void> {
    const next = this.pending.then(() => { if (!this.disposed) return action(); });
    this.pending = next.catch(() => {});
    return next;
  }

  write(data: string): Promise<void> {
    this.trackSequence(data);
    return new Promise(resolve => this.terminal.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    if (cols === this.geometry.cols && rows === this.geometry.rows) return;
    this.terminal.resize(cols, rows);
    for (const buffer of ['normal', 'alternate'] as const) {
      this.margins[buffer] = [rows !== this.geometry.rows ? 1 : this.margins[buffer][0], rows];
    }
    this.geometry.cols = cols;
    this.geometry.rows = rows;
  }

  configure(scrollback: unknown): void {
    this.terminal.options.scrollback = scrollbackSize(scrollback);
  }

  snapshot(): TerminalSnapshot {
    // SerializeAddon restaura celdas y modos, no una secuencia VT incompleta.
    // Repetir solo ese prefijo permite completar un CSI/OSC cortado entre chunks.
    let data = this.serializer.serialize();
    const region = (buffer: 'normal' | 'alternate'): string => {
      const [top, bottom] = this.margins[buffer];
      return top === 1 && bottom === this.geometry.rows ? '' : `\x1b7\x1b[${top};${bottom}r\x1b8`;
    };
    const altStart = data.indexOf('\x1b[?1049h');
    if (altStart >= 0) data = data.slice(0, altStart) + region('normal') + data.slice(altStart) + region('alternate');
    else data += region('normal');
    if (!this.cursorVisible) data += '\x1b[?25l';
    if (this.mouseEncoding) data += `\x1b[?${this.mouseEncoding}h`;
    return { ...this.geometry, data: data + this.sequence };
  }

  dispose(): void {
    this.disposed = true;
    this.terminal.dispose();
  }

  private trackSequence(data: string): void {
    for (const char of data) {
      const code = char.charCodeAt(0);
      if (code === 0x18 || code === 0x1a || code === 0x9c) {
        this.parserState = 'ground';
        this.sequence = '';
        continue;
      }
      if (this.parserState === 'osc' || this.parserState === 'string') {
        this.sequence += char;
        if (char === '\x1b') {
          this.parserState = 'stringEscape';
        } else if (char === '\x07' && this.parserState === 'osc') {
          this.parserState = 'ground';
          this.sequence = '';
        }
        continue;
      }
      if (this.parserState === 'stringEscape') {
        if (char === '\\') {
          this.parserState = 'ground';
          this.sequence = '';
          continue;
        }
        // ESC termina la cadena y empieza una secuencia nueva.
        this.parserState = 'escape';
        this.sequence = '\x1b';
      }
      if (char === '\x1b' || code === 0x9b || code === 0x9d || code === 0x90 || code === 0x9f || code === 0x9e || code === 0x98) {
        this.sequence = char;
        this.parserState = char === '\x1b' ? 'escape' : code === 0x9b ? 'csi' : code === 0x9d ? 'osc' : 'string';
        continue;
      }
      if (this.parserState === 'ground') continue;
      this.sequence += char;
      if (this.parserState === 'escape' && char === '[') this.parserState = 'csi';
      else if (this.parserState === 'escape' && char === ']') this.parserState = 'osc';
      else if (this.parserState === 'escape' && ['P', '_', '^', 'X'].includes(char)) this.parserState = 'string';
      else if ((this.parserState === 'escape' && code >= 0x30 && code <= 0x7e) ||
               (this.parserState === 'csi' && code >= 0x40 && code <= 0x7e)) {
        this.parserState = 'ground';
        this.sequence = '';
      }
    }
  }
}
