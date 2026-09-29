// npm run test:terminal (requires permission to create local PTY named pipes).
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { buildSync } = require('esbuild');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const compiled = buildSync({
  stdin: { contents: "export * from './src/server/terminalState'; export * from './src/serverProtocol';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const compiledModule = new Module(__filename);
compiledModule.paths = module.paths;
compiledModule._compile(compiled, __filename);
const { TerminalState, proofFor, PROTOCOL_VERSION } = compiledModule.exports;
const write = (term, data) => new Promise(resolve => term.write(data, resolve));
const lines = term => Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i).translateToString(true));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function restore(snapshot) {
  const terminal = new Terminal({ ...snapshot, scrollback: 20000, allowProposedApi: true });
  await write(terminal, snapshot.data);
  return terminal;
}

async function modelChecks() {
  const state = new TerminalState({ cols: 120, rows: 40 }, 20000);
  const history = Array.from({ length: 15000 }, (_, i) => `ROW-${i.toString().padStart(5, '0')} ${'x'.repeat(85)}\r\n`).join('');
  assert.ok(history.length > 1024 * 1024);
  await state.run(() => state.write(history));
  let replay = await restore(state.snapshot());
  assert.deepEqual(lines(replay), lines(state.terminal));
  assert.equal(lines(replay).filter(line => line.startsWith('ROW-')).length, 15000);
  replay.dispose();
  console.log('PASS: >1 MB and 15000 distinct lines survive replay');

  await state.run(async () => {
    state.resize(100, 30);
    await state.write(Array.from({ length: 300 }, (_, i) => `BUILD-${i}\r\n`).join(''));
  });
  assert.equal(lines(state.terminal).filter(line => line.startsWith('ROW-')).length, 15000);
  assert.equal(lines(state.terminal).filter(line => line.startsWith('BUILD-')).length, 300);
  console.log('PASS: large ordinary output after resize never clears history');

  await state.run(() => state.write('\x1b[?1049h\x1b[2J\x1b[HClaude screen\x1b[?2004h\x1b[?1000h'));
  replay = await restore(state.snapshot());
  assert.equal(replay.buffer.active.type, 'alternate');
  assert.deepEqual(lines(replay), lines(state.terminal));
  assert.equal(replay.modes.bracketedPasteMode, true);
  await write(replay, '\x1b[?1049l');
  await state.run(() => state.write('\x1b[?1049l'));
  assert.deepEqual(lines(replay), lines(state.terminal));
  replay.dispose();
  console.log('PASS: alternate screen, modes and normal scrollback survive replay');

  await state.run(() => state.write('\x1b[2;20r\x1b[20;1H\x1b[?25l\x1b[?1006h'));
  const regionSnapshot = state.snapshot();
  replay = await restore(regionSnapshot);
  await state.run(() => state.write('\r\nREGION-SCROLL'));
  await write(replay, '\r\nREGION-SCROLL');
  assert.deepEqual(lines(replay), lines(state.terminal));
  assert.ok(regionSnapshot.data.includes('\x1b[?1006h'));
  assert.ok(regionSnapshot.data.includes('\x1b[?25l'));
  replay.dispose();
  await state.run(() => state.write('\x1b[r\x1b[?25h\x1b[?1006l'));
  console.log('PASS: TUI scroll region continues correctly after replay');

  for (const [prefix, suffix] of [['\x1b[31', 'mRED'], ['\x1b]0;test', '\x07TITLE-END'], ['\x1b', '[32mGREEN']]) {
    await state.run(() => state.write(prefix));
    replay = await restore(state.snapshot());
    await write(replay, suffix);
    await state.run(() => state.write(suffix));
    assert.deepEqual(lines(replay), lines(state.terminal));
    const source = state.terminal.buffer.active;
    const target = replay.buffer.active;
    assert.equal(target.getLine(target.baseY + target.cursorY).getCell(target.cursorX - 1).getFgColor(),
      source.getLine(source.baseY + source.cursorY).getCell(source.cursorX - 1).getFgColor());
    replay.dispose();
  }
  console.log('PASS: escape sequences split across reconnect remain intact');

  let snapshot;
  const before = state.run(() => state.write('\x1b[30;1H\r\nBEFORE\r\n'));
  const barrier = state.run(() => { snapshot = state.snapshot(); });
  const after = state.run(() => state.write('AFTER\r\n'));
  await Promise.all([before, barrier, after]);
  replay = await restore(snapshot);
  assert.ok(lines(replay).includes('BEFORE'));
  assert.ok(!lines(replay).includes('AFTER'));
  await write(replay, 'AFTER\r\n');
  assert.deepEqual(lines(replay), lines(state.terminal));
  replay.dispose();
  state.dispose();
  console.log('PASS: snapshot barrier neither loses nor duplicates concurrent output');
}

async function serverChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxentra-regression-'));
  const tokenFile = path.join(dir, 'token');
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token);
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\muxentra-test-${crypto.randomUUID()}` : path.join(dir, 'sock');
  const logFile = path.join(dir, 'server.log');
  const child = spawn(process.execPath, ['dist/server.js', pipe, tokenFile, logFile], { windowsHide: true, stdio: 'ignore' });
  let socket;
  const messages = [];
  const waitFor = async predicate => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index !== -1) return messages.splice(index, 1)[0];
      await delay(20);
    }
    throw new Error(`Server message timeout: ${JSON.stringify(messages.filter(m => m.t !== 'data'))}; output bytes: ${messages.reduce((n, m) => n + (m.data?.length ?? 0), 0)}\n${fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''}`);
  };
  const send = msg => socket.write(JSON.stringify(msg) + '\n');
  const view = new Terminal({ cols: 120, rows: 40, scrollback: 20000, allowProposedApi: true });
  try {
    for (let i = 0; i < 60 && !socket; i++) {
      socket = await new Promise(resolve => {
        const s = net.createConnection(pipe);
        s.once('connect', () => resolve(s));
        s.once('error', () => { s.destroy(); resolve(undefined); });
      });
      if (!socket) await delay(50);
    }
    assert.ok(socket, 'isolated server started');
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        messages.push(message);
        if (message.t === 'spawned' && message.geometry?.windowsPty) view.options.windowsPty = message.geometry.windowsPty;
        if (message.t === 'data') view.write(message.data);
      }
    });
    view.onData(data => send({ t: 'input', id: 'fixture', data }));
    const nonce = crypto.randomBytes(16).toString('hex');
    send({ t: 'hello', version: PROTOCOL_VERSION, nonce, stateReplay: true });
    const challenge = await waitFor(m => m.t === 'challenge');
    assert.equal(challenge.proof, proofFor(token, 'server', nonce, challenge.nonce));
    send({ t: 'auth', proof: proofFor(token, 'client', nonce, challenge.nonce) });
    assert.equal((await waitFor(m => m.t === 'welcome')).stateReplay, true);
    send({ t: 'spawn', id: 'fixture', file: process.execPath, args: [path.resolve('tools/fixtures/static-output.cjs')],
      cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' }, cols: 120, rows: 40, scrollback: 20000, useConptyDll: true });
    await waitFor(m => m.t === 'data' && m.data.includes('PTY-ROW-999'));
    for (let i = 0; i < 3; i++) {
      send({ t: 'attach', id: 'fixture', cols: 80, rows: 24 });
      const attached = await waitFor(m => m.t === 'attached');
      assert.equal(attached.snapshot.cols, 120);
      assert.equal(attached.snapshot.rows, 40);
      const replay = await restore(attached.snapshot);
      assert.equal(lines(replay).filter(line => line.startsWith('PTY-ROW-')).length, 1000);
      replay.dispose();
    }
    console.log('PASS: real PTY reconnect x3 preserves geometry and 1000 unique lines');
    send({ t: 'resize', id: 'fixture', cols: 100, rows: 30 });
    send({ t: 'attach', id: 'fixture', cols: 80, rows: 24 });
    const resized = await waitFor(m => m.t === 'attached');
    assert.equal(resized.snapshot.cols, 100);
    assert.equal(resized.snapshot.rows, 30);
    send({ t: 'configure', id: 'fixture', scrollback: 500 });
    send({ t: 'attach', id: 'fixture', cols: 80, rows: 24 });
    const trimmed = await waitFor(m => m.t === 'attached');
    const replay = await restore(trimmed.snapshot);
    assert.ok(replay.buffer.active.length <= 530);
    replay.dispose();
    console.log('PASS: explicit resize and configured history limit apply in order');
  } finally {
    if (socket && !socket.destroyed) {
      send({ t: 'input', id: 'fixture', data: '\x03' });
      await delay(400);
      send({ t: 'shutdown' });
      socket.end();
    }
    await delay(500);
    child.kill();
    view.dispose();
    const target = fs.realpathSync(dir);
    assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('muxentra-regression-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}

/** Cliente mínimo contra un servidor ya lanzado: saludo incluido. */
async function openClient(pipe, token) {
  let socket;
  for (let i = 0; i < 60 && !socket; i++) {
    socket = await new Promise(resolve => {
      const s = net.createConnection(pipe);
      s.once('connect', () => resolve(s));
      s.once('error', () => { s.destroy(); resolve(undefined); });
    });
    if (!socket) await delay(50);
  }
  assert.ok(socket, 'server reachable');
  const messages = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      messages.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const send = msg => socket.write(JSON.stringify(msg) + '\n');
  const waitUntil = async predicate => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      await delay(20);
    }
    throw new Error(`Server message timeout: ${JSON.stringify(messages.filter(m => m.t !== 'data'))}`);
  };
  const nonce = crypto.randomBytes(16).toString('hex');
  send({ t: 'hello', version: PROTOCOL_VERSION, nonce, stateReplay: true });
  const challenge = await waitUntil(m => m.t === 'challenge');
  assert.equal(challenge.proof, proofFor(token, 'server', nonce, challenge.nonce));
  send({ t: 'auth', proof: proofFor(token, 'client', nonce, challenge.nonce) });
  assert.equal((await waitUntil(m => m.t === 'welcome')).ok, true);
  return { socket, send, waitUntil, messages };
}

const waitForFile = async (file, present) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) === present) return;
    await delay(50);
  }
  throw new Error(`${file} should ${present ? 'exist' : 'be gone'}`);
};

/** El servidor muere de golpe (apagado del PC) y otro nuevo devuelve el historial. */
async function reviveChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxentra-regression-'));
  const tokenFile = path.join(dir, 'token');
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token);
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\muxentra-test-${crypto.randomUUID()}` : path.join(dir, 'sock');
  const logFile = path.join(dir, 'server.log');
  const start = () => spawn(process.execPath, ['dist/server.js', pipe, tokenFile, logFile], { windowsHide: true, stdio: 'ignore' });
  const fixture = { file: process.execPath, args: [path.resolve('tools/fixtures/static-output.cjs')], cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' }, cols: 120, rows: 40, scrollback: 20000, useConptyDll: true };
  const sessions = path.join(dir, 'sessions');
  let child = start();
  let client;
  try {
    client = await openClient(pipe, token);
    client.send({ t: 'spawn', id: 'revive', ...fixture });
    client.send({ t: 'spawn', id: 'dropme', ...fixture });
    await client.waitUntil(m => m.t === 'data' && m.id === 'revive' && m.data.includes('PTY-ROW-999'));
    await client.waitUntil(m => m.t === 'data' && m.id === 'dropme' && m.data.includes('PTY-ROW-999'));
    client.send({ t: 'input', id: 'revive', data: 'claude --model sonnet\r' });
    await delay(100);
    client.socket.end();
    await waitForFile(path.join(sessions, 'revive.json'), true);
    await waitForFile(path.join(sessions, 'dropme.json'), true);
    const saved = JSON.parse(fs.readFileSync(path.join(sessions, 'revive.json'), 'utf8'));
    assert.equal(saved.resume, 'claude');
    assert.ok(!saved.data.includes('\x1b[?1049h'));
    console.log('PASS: history and running agent reach disk when the client disconnects');

    client = await openClient(pipe, token);
    client.send({ t: 'kill', id: 'dropme' });
    await waitForFile(path.join(sessions, 'dropme.json'), false);
    client.socket.end();
    console.log('PASS: closing a terminal on purpose drops its saved history');

    const died = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await died;
    child = start();
    client = await openClient(pipe, token);
    client.send({ t: 'spawn', id: 'revive', ...fixture, cols: 80, rows: 24 });
    const spawned = await client.waitUntil(m => m.t === 'spawned' && m.id === 'revive');
    assert.ok(spawned.snapshot, 'revived spawn carries the saved history');
    assert.equal(spawned.resume, 'claude');
    assert.equal(spawned.snapshot.cols, 120);
    assert.equal(spawned.snapshot.rows, 40);
    assert.ok(spawned.snapshot.data.includes('sesión anterior'));
    assert.ok(!fs.existsSync(path.join(sessions, 'revive.json')));
    const replay = await restore(spawned.snapshot);
    assert.equal(lines(replay).filter(line => line.startsWith('PTY-ROW-')).length, 1000);
    await client.waitUntil(m => m.t === 'data' && m.id === 'revive' && m.data.includes('PTY-ROW-999'));
    for (const m of client.messages) if (m.t === 'data' && m.id === 'revive') await write(replay, m.data);
    assert.equal(lines(replay).filter(line => line.startsWith('PTY-ROW-')).length, 2000);
    replay.dispose();
    console.log('PASS: a fresh server replays the saved history ahead of the new shell and names the agent to resume');
  } finally {
    if (client && !client.socket.destroyed) {
      client.send({ t: 'input', id: 'revive', data: '\x03' });
      await delay(400);
      client.send({ t: 'shutdown' });
      client.socket.end();
    }
    await delay(500);
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await modelChecks();
  await serverChecks();
  await reviveChecks();
})().catch(error => { console.error(error); process.exitCode = 1; });
