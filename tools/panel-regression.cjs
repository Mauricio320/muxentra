const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { transformSync } = require('esbuild');

function load(file, mocks) {
  const loaded = new Module(__filename);
  loaded.paths = module.paths;
  loaded.require = name => name in mocks ? mocks[name] : require(name);
  loaded._compile(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, file);
  return loaded.exports;
}

const repos = ['one', 'two'].map(root => ({ root, label: root, branch: 'main', detached: false }));
const hash = 'a'.repeat(40);
const log = { log: () => ({ warn() {} }) };
const context = { workspaceState: { get: () => undefined, update: async () => {} } };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function snapshot(root, ref = '') {
  return {
    repository: repos.find(repo => repo.root === root), repositories: repos,
    selectedRef: ref, branches: [{ fullRef: 'refs/heads/feature' }],
    commits: [{ hash }], changes: [], worktrees: [], gitlabAvatarsAvailable: false,
  };
}

async function gitChecks() {
  let workspaceChanged;
  const { GitController } = load('src/gitPanel.ts', {
    vscode: { workspace: {
      workspaceFolders: [],
      onDidChangeWorkspaceFolders: callback => { workspaceChanged = callback; },
    } },
    './gitExplorer': { discoverGitRepositories: () => repos },
    './gitlabAvatars': { GitlabAvatarLookup: class {} }, './log': log,
  });
  const requests = [], details = [], messages = [];
  const controller = new GitController(context, {
    snapshot: (_repos, root, ref) => {
      const request = { root, ref, ...deferred() };
      requests.push(request);
      return request.promise;
    },
    commit: (root, hash) => {
      const request = { root, hash, ...deferred() };
      details.push(request);
      return request.promise;
    },
  }, message => messages.push(message), () => false);
  try {
    const first = controller.refresh();
    assert.ok(Array.from({ length: 20 }, () => controller.refresh()).every(promise => promise === first));
    assert.equal(requests.length, 1, 'simultaneous refreshes share one query');
    requests[0].resolve(snapshot('one'));
    await first;
    const commit = controller.onMessage({ type: 'commit', hash });
    const duplicate = controller.onMessage({ type: 'commit', hash });
    assert.equal(details.length, 1, 'concurrent commit clicks share the detail query');
    details[0].resolve({ hash, files: [] });
    await Promise.all([commit, duplicate]);
    const refreshed = controller.refresh();
    requests[1].resolve(snapshot('one'));
    await refreshed;
    assert.equal(details.length, 1, 'periodic refresh reuses immutable commit detail');
    const stale = controller.refresh();
    const switched = controller.onMessage({ type: 'repo', root: 'two' });
    assert.equal(requests.length, 4, 'new repository starts its own request');
    requests[3].resolve(snapshot('two'));
    await switched;
    requests[2].resolve(snapshot('one'));
    await stale;
    assert.equal(messages.filter(m => m.type === 'snapshot').at(-1).snapshot.repository.root, 'two');
    const otherDetail = controller.onMessage({ type: 'commit', hash });
    assert.equal(details.length, 2, 'detail cache is scoped to repository');
    details[1].reject(new Error('temporary failure'));
    await otherDetail;
    const retryDetail = controller.onMessage({ type: 'commit', hash });
    assert.equal(details.length, 3, 'failed detail reads can be retried');
    details[2].resolve({ hash, files: [] });
    await retryDetail;
    const beforeFolders = controller.refresh();
    workspaceChanged();
    assert.equal(requests.length, 6, 'workspace changes invalidate in-flight discovery');
    const afterFolders = controller.refresh();
    requests[5].resolve(snapshot('two'));
    requests[4].resolve(snapshot('two'));
    await Promise.all([beforeFolders, afterFolders]);
    const pending = controller.refresh();
    controller.dispose();
    const count = messages.length;
    requests.at(-1).resolve(snapshot('two'));
    await pending;
    await controller.refresh();
    assert.equal(messages.length, count, 'disposed panels receive no pending snapshots');
    assert.equal(requests.length, 7, 'disposed panels start no new queries');
  } finally { controller.dispose(); }
  console.log('PASS: Git refresh deduplication, repository races, commit cache, retry and disposal');
}

function branchChecks() {
  let enabled = true;
  let branch = 'main';
  const reads = [], messages = [];
  const { MuxentraPanel } = load('src/panel.ts', {
    vscode: { workspace: { getConfiguration: () => ({ get: () => enabled }) } },
    './git': {
      normalizeCwd: cwd => cwd,
      readGitInfo: cwd => { reads.push(cwd); return cwd === '/empty' ? undefined : { branch, detached: false }; },
    },
    './gitPanel': {}, './brand': {}, './ptyClient': {}, './usage': {}, './environment': {}, './log': log,
    './claudeProfileSwitch': {},
    './attachedFile': { attachLimitBytes: () => 10 * 1024 * 1024 }, './pasteGuard': {}, './projectFiles': {},
  });
  const panel = Object.create(MuxentraPanel.prototype);
  Object.assign(panel, {
    cwds: new Map([['a', '/repo'], ['b', '/repo'], ['c', '/empty'], ['d', '/empty']]),
    branches: new Map(), post: message => messages.push(message),
  });
  panel.refreshBranches(false);
  assert.deepEqual(reads, ['/repo', '/empty'], 'one read per directory, including non-repositories');
  assert.equal(messages.length, 4);
  panel.refreshBranches(false);
  assert.equal(messages.length, 4, 'unchanged branches do not send more messages');
  branch = 'feature';
  panel.refreshBranches(false);
  assert.deepEqual(messages.slice(4).map(m => [m.termId, m.branch]), [['a', 'feature'], ['b', 'feature']]);
  panel.setCwd('a', '/new');
  assert.equal(messages.at(-1).cwd, '/new');
  assert.equal(messages.at(-1).branch, 'feature');
  enabled = false;
  const count = reads.length;
  panel.refreshBranches(true);
  panel.setCwd('a', '/disabled');
  assert.equal(reads.length, count, 'disabled branch display does no disk reads');
  console.log('PASS: shared directory reads, fresh branch changes, cwd updates and disabled polling');
}

(async () => { await gitChecks(); branchChecks(); })().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
