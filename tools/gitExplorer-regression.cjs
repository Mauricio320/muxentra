const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const Module = require('node:module');

const compiled = buildSync({
  entryPoints: ['src/gitExplorer.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const loaded = new Module(__filename);
loaded.paths = module.paths;
loaded._compile(compiled, __filename);
const { GitExplorer, discoverGitRepositories, assertRelativeFile, avatarUrlForEmail } = loaded.exports;

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'muxentra-git-regression-'));
const repo = path.join(fixture, 'repo');
const worktree = path.join(fixture, 'worktree');
fs.mkdirSync(repo);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();

(async () => {
  try {
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Muxentra Test');
    git(repo, 'config', 'user.email', 'muxentra@example.test');
    fs.writeFileSync(path.join(repo, 'sample.txt'), 'first\n');
    git(repo, 'add', 'sample.txt');
    git(repo, 'commit', '-m', 'Initial commit');
    const initial = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'branch', 'feature');
    git(repo, 'worktree', 'add', worktree, 'feature');
    fs.writeFileSync(path.join(worktree, 'sample.txt'), 'first\nsecond\n');
    git(worktree, 'add', 'sample.txt');
    git(worktree, 'commit', '-m', 'Feature change');
    const feature = git(worktree, 'rev-parse', 'HEAD');
    git(worktree, 'mv', 'sample.txt', 'renamed.txt');
    git(worktree, 'commit', '-m', 'Rename sample');
    const renamed = git(worktree, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'sample.txt'), 'first\nlocal\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');

    const repositories = discoverGitRepositories([fixture]);
    assert.deepEqual(repositories.map(item => item.root).sort(), [repo, worktree].sort());
    const explorer = new GitExplorer();
    const snapshot = await explorer.snapshot(repositories, repo);
    assert.equal(snapshot.repository.branch, 'main');
    assert.equal(snapshot.worktrees.length, 2);
    assert.equal(snapshot.commits.length, 3);
    assert.equal(snapshot.gitlabAvatarsAvailable, false);
    assert.equal(snapshot.commits[0].email, 'muxentra@example.test');
    assert.equal(snapshot.commits[0].avatarUrl, avatarUrlForEmail('muxentra@example.test'));
    assert.ok(snapshot.branches.some(item => item.name === 'feature'));
    assert.ok(snapshot.changes.some(item => item.path === 'sample.txt'));
    assert.ok(snapshot.changes.some(item => item.path === 'new.txt' && item.untracked));

    const detail = await explorer.commit(repo, feature);
    assert.equal(detail.subject, 'Feature change');
    assert.equal(detail.avatarUrl, avatarUrlForEmail('muxentra@example.test'));
    assert.deepEqual(detail.parents, [initial]);
    assert.deepEqual(detail.files.map(item => item.path), ['sample.txt']);
    const renameDetail = await explorer.commit(repo, renamed);
    assert.deepEqual(renameDetail.files.map(item => [item.previousPath, item.path]), [['sample.txt', 'renamed.txt']]);
    assert.equal(await explorer.fileAt(repo, feature, 'sample.txt'), 'first\nsecond\n');
    assert.throws(() => assertRelativeFile(repo, '../outside.txt'));
    git(repo, 'remote', 'add', 'origin', 'git@gitlab.com:example/private-repo.git');
    assert.equal((await explorer.snapshot(repositories, repo)).gitlabAvatarsAvailable, true);
    assert.equal(avatarUrlForEmail('123+Octocat@users.noreply.github.com'), 'https://github.com/octocat.png?size=64');
    assert.equal(avatarUrlForEmail('invalid'), undefined);
    const filtered = await explorer.snapshot(repositories, repo, 'refs/heads/main');
    assert.equal(filtered.commits.length, 1);
    console.log('PASS: repos, worktrees, branches, dirty files, commits, filters and revision content');
  } finally {
    const target = fs.realpathSync(fixture);
    assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('muxentra-git-regression-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
