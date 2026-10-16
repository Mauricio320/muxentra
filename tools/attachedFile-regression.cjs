// npm run test:attached
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');

/** Carga un .ts del proyecto resolviendo a mano sus imports relativos. */
function loader(mocks) {
  const cache = new Map();
  const load = file => {
    const full = path.resolve(file);
    if (cache.has(full)) return cache.get(full);
    const loaded = new Module(full);
    loaded.paths = module.paths;
    cache.set(full, loaded.exports);
    loaded.require = name => {
      if (name in mocks) return mocks[name];
      if (name.startsWith('.')) return load(path.join(path.dirname(full), `${name}.ts`));
      return require(name);
    };
    loaded._compile(transformSync(fs.readFileSync(full, 'utf8'), { loader: 'ts', format: 'cjs' }).code, full);
    cache.set(full, loaded.exports);
    return loaded.exports;
  };
  return load;
}

const BACKSLASH = String.fromCharCode(92);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muxentra-attach-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'muxentra-outside-'));
const gitDir = path.join(root, '.git');
fs.mkdirSync(gitDir, { recursive: true });

const config = { filePasteDir: undefined, filePasteMaxMB: undefined };
const load = loader({
  vscode: { workspace: { getConfiguration: () => ({ get: key => config[key] }) } },
  './ptyClient': { workingDirectory: () => root },
  './log': { log: () => ({ warn() {}, info() {}, debug() {} }) },
  './git': { gitCommonDir: () => gitDir },
});
const { attachBytes, attachLimitBytes, attachPath, safeFileName } = load('src/attachedFile.ts');
const { quotePath, safeDirName } = load('src/projectFiles.ts');

function nameChecks() {
  assert.equal(safeFileName('contrato.ts'), 'contrato.ts');
  assert.equal(safeFileName(`C:${BACKSLASH}Users${BACKSLASH}ana${BACKSLASH}pedido.contract.ts`), 'pedido.contract.ts');
  assert.equal(safeFileName('/home/ana/pedido.json'), 'pedido.json');
  // Un nombre con caracteres que Windows no acepta no puede crear el archivo.
  assert.equal(safeFileName('cont<ra>to:"|?*.ts'), 'contrato.ts');
  // Windows recorta en silencio los puntos y espacios del final.
  assert.equal(safeFileName('contrato.ts. .'), 'contrato.ts');
  assert.equal(safeFileName('con.txt'), '_con.txt');
  assert.equal(safeFileName('..'), 'archivo');
  assert.equal(safeFileName(''), 'archivo');
  const long = safeFileName(`${'x'.repeat(400)}.ts`);
  assert.ok(long.length <= 120 && long.endsWith('.ts'));
  console.log('PASS: el nombre que llega del navegador se deja en algo que el disco acepta');
}

function pathChecks() {
  const inside = path.join(root, 'src', 'contrato.ts');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, 'export type Pedido = { id: string };');

  // Lo que ya vive en el proyecto se referencia donde está, sin copiarlo.
  const referenced = attachPath(inside);
  assert.equal(referenced.relative, 'src/contrato.ts');
  assert.equal(referenced.absolute, inside);
  assert.ok(!fs.existsSync(path.join(root, '.muxentra-files')));

  // Lo de fuera se copia al proyecto, que es lo que el agente puede leer.
  const foreign = path.join(outside, 'contrato externo.ts');
  fs.writeFileSync(foreign, 'export type Externo = 1;');
  const copied = attachPath(foreign);
  assert.equal(copied.relative, '.muxentra-files/contrato externo.ts');
  assert.equal(fs.readFileSync(copied.absolute, 'utf8'), 'export type Externo = 1;');

  assert.throws(() => attachPath(path.join(outside, 'no-existe.ts')), /no está en disco/);
  assert.throws(() => attachPath(outside), /es una carpeta/);
  console.log('PASS: dentro del proyecto se referencia y fuera se copia');
}

function bytesChecks() {
  const first = attachBytes('pedido.json', Buffer.from('{"id":1}'));
  assert.equal(first.relative, '.muxentra-files/pedido.json');

  // Soltar dos veces lo mismo no deja un pedido-2.json al lado.
  const again = attachBytes('pedido.json', Buffer.from('{"id":1}'));
  assert.equal(again.absolute, first.absolute);

  // Mismo nombre y otro contenido sí es otro archivo.
  const other = attachBytes('pedido.json', Buffer.from('{"id":2}'));
  assert.equal(other.relative, '.muxentra-files/pedido-2.json');
  assert.equal(fs.readFileSync(first.absolute, 'utf8'), '{"id":1}');

  // La carpeta de trabajo no debe llegar al repositorio.
  const exclude = fs.readFileSync(path.join(gitDir, 'info', 'exclude'), 'utf8');
  assert.ok(exclude.split(/\r?\n/).includes('.muxentra-files/'));
  console.log('PASS: el contenido soltado se guarda sin duplicar y queda fuera de git');
}

function configChecks() {
  assert.equal(attachLimitBytes(), 10 * 1024 * 1024);
  config.filePasteMaxMB = 25;
  assert.equal(attachLimitBytes(), 25 * 1024 * 1024);
  config.filePasteMaxMB = undefined;

  // Una carpeta de fuera del workspace borraría archivos ajenos al podar.
  assert.equal(safeDirName('../fuera', root, '.muxentra-files'), '.muxentra-files');
  assert.equal(safeDirName(path.join(root, 'absoluta'), root, '.muxentra-files'), '.muxentra-files');
  assert.equal(safeDirName('tmp/contratos', root, '.muxentra-files'), 'tmp/contratos');

  config.filePasteDir = 'tmp/contratos';
  const saved = attachBytes('otro.ts', Buffer.from('1'));
  assert.equal(saved.relative, 'tmp/contratos/otro.ts');
  config.filePasteDir = undefined;

  // Sin comillas el shell parte la ruta en dos argumentos.
  assert.equal(quotePath('src/contrato.ts'), 'src/contrato.ts');
  assert.equal(quotePath('.muxentra-files/contrato externo.ts'), '".muxentra-files/contrato externo.ts"');
  console.log('PASS: la configuración manda y las rutas con espacios van entre comillas');
}

try {
  nameChecks();
  pathChecks();
  bytesChecks();
  configChecks();
  console.log('OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
