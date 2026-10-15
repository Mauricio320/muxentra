const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const code = ts.transpileModule(fs.readFileSync('src/panelRecovery.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(type = 'mainThreadWebview-muxentra') {
  const timers = new Map(), closed = [], reopened = [], subscriptions = [];
  let sequence = 0, changed, open = false, closing = async () => true;
  class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
  const group = { viewColumn: 2, isActive: true, tabs: [] };
  const tab = { input: new TabInputWebview(type), isActive: true, group };
  group.tabs.push(tab);
  const vscode = { TabInputWebview, window: { tabGroups: {
    all: [group],
    onDidChangeTabs: callback => { changed = callback; return { dispose() { changed = () => {}; } }; },
    close: async (target, preserveFocus) => {
      closed.push([target, preserveFocus]);
      const result = await closing();
      if (result) group.tabs = group.tabs.filter(item => item !== target);
      changed();
      return result;
    },
  } } };
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: name => name === 'vscode' ? vscode : { log: () => ({ info() {}, warn() {} }) },
    setTimeout: callback => { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  exports.registerPanelRecovery({ subscriptions }, () => open, (...args) => { reopened.push(args); open = true; });
  return {
    tab, group, closed, reopened, timers,
    setOpen: value => { open = value; },
    setClosing: fn => { closing = fn; },
    changed: () => changed(),
    dispose: () => subscriptions.forEach(item => item.dispose()),
    tick: async () => {
      const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback());
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

(async () => {
  for (const type of ['muxentra', 'mainThreadWebview-muxentra', 'orcaTerminals', 'mainThreadWebview-orcaTerminals']) {
    const test = fixture(type);
    await test.tick();
    assert.equal(test.closed[0][0], test.tab);
    assert.equal(test.closed[0][1], true);
    assert.deepEqual(test.reopened, [[2, false]], 'recreate orphan in its original group');
    test.changed(); await test.tick();
    assert.equal(test.reopened.length, 1, 'one recovery, no duplicate panels');
  }
  const normal = fixture(); normal.setOpen(true); await normal.tick();
  assert.equal(normal.closed.length, 0, 'normal serializer has priority');
  const hidden = fixture(); hidden.tab.isActive = false; await hidden.tick();
  assert.equal(hidden.closed.length, 0, 'do not open hidden panels');
  hidden.tab.isActive = true; hidden.group.isActive = false; hidden.changed(); await hidden.tick();
  assert.deepEqual(hidden.reopened, [[2, true]], 'visible inactive group preserves focus');
  const unrelated = fixture('mainThreadWebview-other'); await unrelated.tick();
  assert.equal(unrelated.closed.length, 0, 'never close another extension');
  const removed = fixture(); removed.group.tabs = []; await removed.tick();
  assert.equal(removed.closed.length, 0, 'respect a tab the user closed');
  const cancelled = fixture(); cancelled.setClosing(async () => false); await cancelled.tick();
  assert.equal(cancelled.reopened.length, 0, 'a refused close never creates a duplicate');
  const failed = fixture(); failed.setClosing(async () => { throw new Error('closed host'); }); await failed.tick();
  assert.equal(failed.reopened.length, 0, 'failed recovery is handled');
  const disposed = fixture(); disposed.dispose(); await disposed.tick();
  assert.equal(disposed.closed.length, 0, 'dispose cancels scheduled recovery');
  const inFlight = fixture(); inFlight.setClosing(async () => { inFlight.dispose(); return true; }); await inFlight.tick();
  assert.equal(inFlight.reopened.length, 0, 'a disposed host cannot reopen a panel');
  const revived = fixture(); revived.setClosing(async () => { revived.setOpen(true); return true; }); await revived.tick();
  assert.equal(revived.reopened.length, 0, 'concurrent revival cannot create a duplicate');
  console.log('PASS: orphan recovery, serializer priority, focus, hidden panels, cancellation and restart races');
})().catch(error => { console.error(error); process.exitCode = 1; });
