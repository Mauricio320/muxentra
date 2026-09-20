// Sonda: arranca un programa en un pty real, espera, cambia el tamaño y cuenta
// qué secuencias emite en cada fase. Sirve para medir cómo reacciona una TUI
// (Codex, Claude Code…) a un resize sin adivinar. No manda ninguna entrada.
//
//   node tools/pty-probe.cjs <programa> [args...]
//   node tools/pty-probe.cjs codex resume --last
//   node tools/pty-probe.cjs cmd.exe /c claude
//
// Variables: PROBE_CWD (carpeta de trabajo), PROBE_WAIT_MS (espera inicial,
// 10000), PROBE_TEXT (regex de un texto de la transcripción para distinguir
// una reescritura real de simples frames de animación).

const path = require('path');
const pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));

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
  cursorPos_H: count(s, /\x1b\[\d+;\d+H/g),
  scrollRegion_DECSTBM: count(s, /\x1b\[\d*;?\d*r/g),
  sync2026: count(s, /\x1b\[\?2026[hl]/g),
  altScreen_1049h: count(s, /\x1b\[\?1049h/g),
  mouse_1000_1002_1006: count(s, /\x1b\[\?100[026]h/g),
});

const p = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd, env: { ...process.env } });
let out = '';
p.onData(d => { out += d; });
const phase = (label, ms, next) => setTimeout(() => {
  console.log(label, JSON.stringify(metrics(out)));
  out = '';
  next();
}, ms);

phase(`arranque (120x40, ${wait} ms)`, wait, () => {
  p.resize(120, 30);
  phase('tras bajar a 30 filas (3 s)', 3000, () => {
    phase('en reposo (3 s)', 3000, () => {
      p.resize(100, 30);
      phase('tras estrechar a 100 columnas (3 s)', 3000, () => {
        try { p.kill(); } catch { /* ya terminó */ }
      });
    });
  });
});
