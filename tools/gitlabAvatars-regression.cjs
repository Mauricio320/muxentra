const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const Module = require('node:module');

const compiled = buildSync({
  entryPoints: ['src/gitlabAvatars.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const loaded = new Module(__filename);
loaded.paths = module.paths;
loaded._compile(compiled, __filename);
const { GitlabAvatarLookup, isGitlabRemote } = loaded.exports;

assert.equal(isGitlabRemote('git@gitlab.com:team/repo.git'), true);
assert.equal(isGitlabRemote('https://gitlab.com/team/repo.git'), true);
assert.equal(isGitlabRemote('https://gitlab.com.evil.example/repo'), false);

const calls = [];
const response = data => ({ ok: true, json: async () => data });
const fetcher = async raw => {
  const url = new URL(raw);
  calls.push(`${url.pathname}?${url.searchParams.get('email') ?? url.searchParams.get('search')}`);
  const query = url.searchParams.get('email') ?? url.searchParams.get('search');
  if (url.pathname.endsWith('/avatar')) {
    if (query === 'mauricio@example.test') return response({ avatar_url: 'https://gitlab.com/uploads/-/system/user/avatar/1/photo.png' });
    return response({ avatar_url: 'https://gravatar.com/avatar/abc?d=identicon' });
  }
  if (query?.includes('@')) return response([]);
  if (query === 'Eduardo Galvez Monardez') return response([
    { name: 'Eduardo Galvez Monardez', avatar_url: 'https://gitlab.com/uploads/-/system/user/avatar/2/photo.png' },
    { name: 'Eduardo Other', avatar_url: 'https://gitlab.com/uploads/-/system/user/avatar/3/photo.png' },
  ]);
  if (query === 'Ana Maria') return response([
    { name: 'Ana Maria', avatar_url: 'https://gitlab.com/uploads/-/system/user/avatar/4/photo.png' },
    { name: 'Ana Maria', avatar_url: 'https://gitlab.com/uploads/-/system/user/avatar/5/photo.png' },
  ]);
  return response([]);
};

(async () => {
  const lookup = new GitlabAvatarLookup(fetcher);
  const authors = [
    { email: 'mauricio@example.test', name: 'Mauricio Triana' },
    { email: 'eduardo@example.test', name: 'Eduardo' },
    { email: 'eduardo@example.test', name: 'Eduardo Galvez Monardez' },
    { email: 'ana@example.test', name: 'Ana Maria' },
  ];
  const found = await lookup.find(authors);
  assert.deepEqual(found, {
    'mauricio@example.test': 'https://gitlab.com/uploads/-/system/user/avatar/1/photo.png',
    'eduardo@example.test': 'https://gitlab.com/uploads/-/system/user/avatar/2/photo.png',
  });
  assert.ok(calls.some(call => call.endsWith('?Eduardo Galvez Monardez')));
  assert.ok(!calls.some(call => call.endsWith('?Eduardo')));
  const count = calls.length;
  await lookup.find(authors.slice(0, 1));
  assert.equal(calls.length, count, 'Las fotos encontradas se reutilizan sin volver a consultar GitLab');
  console.log('PASS: GitLab remote detection, exact author match, ambiguity guard and avatar cache');
})().catch(error => { console.error(error); process.exitCode = 1; });
