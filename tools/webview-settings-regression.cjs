const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual webview functions without starting a VS Code session.
const source = fs.readFileSync('src/webview/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set(['applySettings', 'updateBottomBarVisibility', 'fontLoadKey', 'fontLoad', 'terminalSettingKeys']);
const selected = ast.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.has(d.name.getText(ast)))),
).map(node => node.getText(ast)).join('\n');
assert.equal(selected.includes('async function applySettings'), true);
const initial = {
  fontFamily: 'monospace', fontSize: 14, fontWeight: 'normal', fontWeightBold: 'bold',
  letterSpacing: 0, lineHeight: 1, scrollback: 20000, cursorBlink: true,
  agentStatus: true, notificationsEnabled: true,
};
const options = { ...initial };
let assignments = 0, fits = 0, toolbarRenders = 0, loads = 0;
const pendingFonts = new Map();
const term = {
  get options() { return options; },
  set options(value) { assignments++; Object.assign(options, value); },
};
const cleared = [];
const pane = { term, activity: 'busy', quietTimer: 5 };
const context = vm.createContext({
  settings: { ...initial }, panes: new Map([['one', pane]]),
  document: { fonts: {
    ready: Promise.resolve(),
    load: key => {
      loads++;
      if (key.endsWith('monospace')) return Promise.resolve();
      return new Promise(resolve => pendingFonts.set(key, resolve));
    },
  } },
  window: { clearTimeout: timer => cleared.push(timer) },
  renderTabBar: () => toolbarRenders++, fitVisible: () => fits++,
  setActivity: (pane, state) => { pane.activity = state; },
  bottomBarEl: { hidden: true }, gitActive: false, showUsage: true,
});
vm.runInContext(ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);

(async () => {
  await context.applySettings({ ...initial });
  await context.applySettings({ ...initial });
  assert.equal(loads, 1, 'same font is loaded once');
  assert.equal(assignments, 0, 'identical options never reconfigure terminals');
  assert.equal(fits, 0);
  await context.applySettings({ ...initial, notificationsEnabled: false });
  assert.equal(toolbarRenders, 1);
  assert.equal(loads, 1);
  assert.equal(assignments, 0, 'notification toggle does not touch renderer options');
  await context.applySettings({ ...initial, cursorBlink: false });
  assert.equal(assignments, 1);
  assert.equal(options.cursorBlink, false);
  assert.equal(fits, 0, 'cursor blink changes need no resize');
  const earlier = context.applySettings({ ...initial, fontFamily: 'Earlier' });
  const latest = context.applySettings({ ...initial, fontFamily: 'Latest', fontSize: 18 });
  await Promise.resolve();
  pendingFonts.get('normal 18px Latest')();
  await latest;
  pendingFonts.get('normal 14px Earlier')();
  await earlier;
  assert.equal(options.fontFamily, 'Latest', 'a slow earlier font cannot overwrite current settings');
  assert.equal(options.fontSize, 18);
  assert.equal(fits, 1);
  await context.applySettings({ ...initial, fontFamily: 'Latest', fontSize: 18, agentStatus: false });
  assert.deepEqual(cleared, [5]);
  assert.equal(pane.activity, 'idle');
  assert.equal(fits, 1, 'disabling status does not resize terminals');
  context.updateBottomBarVisibility();
  assert.equal(context.bottomBarEl.hidden, false);
  assert.equal(fits, 2);
  for (let i = 0; i < 20; i++) context.updateBottomBarVisibility();
  assert.equal(fits, 2, 'usage refreshes with stable visibility do not refit');
  context.gitActive = true;
  context.updateBottomBarVisibility();
  assert.equal(context.bottomBarEl.hidden, true);
  assert.equal(fits, 3);
  console.log('PASS: unchanged settings, font load races, notifications, activity cleanup and usage geometry');
})().catch(error => { console.error(error); process.exitCode = 1; });
