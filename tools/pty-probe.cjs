// Sonda: arranca un programa en un pty real, espera, cambia el tamaño y cuenta
// qué secuencias emite en cada fase. Sirve para medir cómo reacciona una TUI
// (Codex, Claude Code…) a un resize sin adivinar. Responde consultas de terminal
// y envía Ctrl+C al terminar; no envía prompts ni acepta diálogos.
//
//   node tools/pty-probe.cjs <programa> [args...]
//   node tools/pty-probe.cjs codex resume --last
//   node tools/pty-probe.cjs cmd.exe /c claude
//
// Variables: PROBE_CWD (carpeta de trabajo), PROBE_WAIT_MS (espera inicial,
// 10000), PROBE_TEXT (regex de un texto de la transcripción para distinguir
// una reescritura real de simples frames de animación).
// PROBE_CONPTY_DLL=1 compara el backend moderno. PROBE_SCREEN=1 imprime solo
// fases de menos de 1000 caracteres para diagnosticar errores de arranque.

const path = require('path');
const pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));
const { Terminal } = require('@xterm/xterm');
const os = require('os');

const [, , file, ...args] = process.argv;
if (!file) {
  console.error('uso: node tools/pty-probe.cjs <programa> [args...]');
  process.exit(1);
}
const cwd = process.env.PROBE_CWD || process.cwd();
const wait = Number(process.env.PROBE_WAIT_MS || 10000);
const text = process.env.PROBE_TEXT ? new RegExp(process.env.PROBE_TEXT, 'g') : undefined;

const count = (s, re) => (s.match(re) || []).length;
const metrics = s => ({
  bytes: s.length,
  newlines: count(s, /\n/g),
  textoTranscripcion: text ? count(s, text) : undefined,
  ED2_borraPantalla: count(s, /\x1b\[2J/g),
  ED3_borraHistorial: count(s, /\x1b\[3J/g),
  eraseLine_K: count(s, /\x1b\[[0-2]?K/g),
  cursorUp_A: count(s, /\x1b\[\d*A/g),
  cursorPos_H: count(s, /\x1b\[(?:\d*;?\d*)?H/g),
  cursorPos_f: count(s, /\x1b\[(?:\d*;?\d*)?f/g),
  scrollRegion_DECSTBM: count(s, /\x1b\[\d*;?\d*r/g),
  sync2026: count(s, /\x1b\[\?2026[hl]/g),
  altScreen_1049h: count(s, /\x1b\[\?1049h/g),
  mouse_1000_1002_1006: count(s, /\x1b\[\?100[026]h/g),
});

const useConptyDll = process.env.PROBE_CONPTY_DLL === '1';
const terminal = new Terminal({
  cols: 120, rows: 40, scrollback: 20000, allowProposedApi: true,
  windowsPty: process.platform === 'win32'
    ? { backend: 'conpty', buildNumber: useConptyDll ? 22621 : Number(os.release().split('.')[2]) }
    : undefined,
});
const p = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd,
  env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, useConptyDll });
let exited = false;
p.onExit(() => { exited = true; });
// Responder a DSR/DA como lo hace el webview. Sin emulador, ConPTY puede esperar
// segundos al arrancar y la sonda confunde salida pendiente con un repintado.
terminal.onData(data => p.write(data));
let out = '';
p.onData(d => { out += d; terminal.write(d); });
const renderedMetrics = () => {
  const buffer = terminal.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true));
  return { bufferLines: buffer.length, baseY: buffer.baseY, renderedMatches: text ? count(lines.join('\n'), text) : undefined };
};
const phase = (label, ms, next) => setTimeout(() => {
  console.log(label, JSON.stringify({ useConptyDll, ...metrics(out), ...renderedMetrics() }));
  if (process.env.PROBE_SCREEN === '1' && out.length < 1000) console.log(JSON.stringify(out));
  out = '';
  next();
}, ms);

phase(`arranque (120x40, ${wait} ms)`, wait, () => {
  terminal.resize(120, 30); p.resize(120, 30);
  phase('tras bajar a 30 filas (3 s)', 3000, () => {
    phase('en reposo (3 s)', 3000, () => {
      terminal.resize(100, 30); p.resize(100, 30);
      phase('tras estrechar a 100 columnas (3 s)', 3000, () => {
        // Ctrl+C cierra estos procesos de diagnóstico sin recorrer otros shells.
        p.write('\x03');
        setTimeout(() => {
          if (!exited) { try { p.kill(); } catch { /* ya terminó */ } }
          terminal.dispose();
          setTimeout(() => process.exit(0), 500);
        }, 500);
      });
    });
  });
});
