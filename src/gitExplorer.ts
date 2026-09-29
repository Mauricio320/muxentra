import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { readGitInfo } from './git';
import { isGitlabRemote } from './gitlabAvatars';

const execFileAsync = promisify(execFile);
const MAX_REPOSITORIES = 80;
const MAX_COMMITS = 180;

export interface GitRepository {
  root: string;
  label: string;
  branch: string;
  detached: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  author: string;
  email: string;
  avatarUrl?: string;
  date: string;
  refs: string[];
}

export interface GitBranch {
  name: string;
  fullRef: string;
  hash: string;
  current: boolean;
  remote: boolean;
}

export interface GitWorktree {
  path: string;
  hash: string;
  branch: string;
}

export interface GitChange {
  path: string;
  previousPath?: string;
  status: string;
  staged: boolean;
  untracked: boolean;
}

export interface GitSnapshot {
  repository: GitRepository;
  repositories: GitRepository[];
  selectedRef: string;
  branches: GitBranch[];
  worktrees: GitWorktree[];
  changes: GitChange[];
  commits: GitCommit[];
  gitlabAvatarsAvailable: boolean;
}

export interface GitCommitFile {
  path: string;
  previousPath?: string;
  status: string;
}

export interface GitCommitDetail {
  hash: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  avatarUrl?: string;
  date: string;
  parents: string[];
  files: GitCommitFile[];
}

/** Reconoce repositorios de las carpetas abiertas y sus hijos inmediatos. */
export function discoverGitRepositories(workspaceRoots: readonly string[]): GitRepository[] {
  const found = new Map<string, GitRepository>();
  const visit = (candidate: string): void => {
    if (found.size >= MAX_REPOSITORIES || !path.isAbsolute(candidate)) return;
    const info = readGitInfo(candidate);
    if (!info) return;
    const key = process.platform === 'win32' ? info.root.toLowerCase() : info.root;
    if (!found.has(key)) found.set(key, {
      root: info.root,
      label: path.basename(info.root),
      branch: info.branch,
      detached: info.detached,
    });
  };
  const children = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !['node_modules', '.git', 'dist'].includes(entry.name))
        .slice(0, 250)
        .map(entry => path.join(dir, entry.name));
    } catch {
      return [];
    }
  };
  for (const root of workspaceRoots) {
    visit(root);
    for (const child of children(root)) {
      if (fs.existsSync(path.join(child, '.git'))) visit(child);
      if (path.basename(child) === '.worktrees') {
        for (const worktree of children(child)) if (fs.existsSync(path.join(worktree, '.git'))) visit(worktree);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export class GitExplorer {
  constructor(private readonly gitPath = 'git') {}

  private async run(root: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
    const { stdout } = await execFileAsync(this.gitPath, ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer,
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  }

  async snapshot(repositories: GitRepository[], root: string, requestedRef = ''): Promise<GitSnapshot> {
    const repository = repositories.find(item => item.root === root);
    if (!repository) throw new Error('El repositorio ya no está disponible en este espacio de trabajo.');
    const [branchesRaw, worktreesRaw, statusRaw, remoteRaw] = await Promise.all([
      this.run(root, ['for-each-ref', '--format=%(refname)%09%(refname:short)%09%(objectname)%09%(HEAD)', 'refs/heads', 'refs/remotes']),
      this.run(root, ['worktree', 'list', '--porcelain']),
      this.run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
      this.run(root, ['remote', 'get-url', 'origin']).catch(() => ''),
    ]);
    const branches = parseBranches(branchesRaw);
    const selectedRef = branches.some(branch => branch.fullRef === requestedRef) ? requestedRef : '';
    const logRaw = await this.run(root, [
      'log', '--topo-order', `-n${MAX_COMMITS}`,
      '--pretty=format:%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%D%x1e',
      selectedRef || '--all',
    ]).catch(err => {
      // Un repositorio nuevo sin commits también debe poder mostrarse.
      if (!branches.length) return '';
      throw err;
    });
    const current = readGitInfo(root);
    return {
      repository: { ...repository, branch: current?.branch ?? repository.branch, detached: current?.detached ?? repository.detached },
      repositories,
      selectedRef,
      branches,
      worktrees: parseWorktrees(worktreesRaw),
      changes: parseStatus(statusRaw),
      commits: parseCommits(logRaw),
      gitlabAvatarsAvailable: isGitlabRemote(remoteRaw.trim()),
    };
  }

  async commit(root: string, hash: string): Promise<GitCommitDetail> {
    assertHash(hash);
    const meta = await this.run(root, ['show', '-s', '--format=%B%x1e%an%x1e%ae%x1e%aI%x1e%P', hash]);
    const [body = '', author = '', email = '', date = '', parentLine = ''] = meta.trimEnd().split('\x1e');
    const parents = parentLine.trim().split(' ').filter(Boolean);
    const filesRaw = parents.length
      ? await this.run(root, ['diff', '--name-status', '--find-renames', '-z', parents[0], hash])
      : await this.run(root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '--find-renames', '-r', '-z', hash]);
    return {
      hash,
      subject: body.split(/\r?\n/, 1)[0] ?? '',
      body: body.slice(0, 12000),
      author,
      email,
      avatarUrl: avatarUrlForEmail(email),
      date,
      parents,
      files: parseCommitFiles(filesRaw),
    };
  }

  async fileAt(root: string, hash: string, file: string): Promise<string> {
    assertHash(hash);
    assertRelativeFile(root, file);
    const data = await this.run(root, ['show', `${hash}:${file}`], 3 * 1024 * 1024);
    return data.includes('\0') ? 'Archivo binario: la vista de texto no está disponible.' : data;
  }

  async head(root: string): Promise<string | undefined> {
    try {
      const hash = (await this.run(root, ['rev-parse', 'HEAD'])).trim();
      return /^[0-9a-f]{40,64}$/i.test(hash) ? hash : undefined;
    } catch {
      return undefined;
    }
  }
}

export function assertHash(hash: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(hash)) throw new Error('Identificador de commit inválido.');
}

export function assertRelativeFile(root: string, file: string): string {
  if (!file || path.isAbsolute(file) || file.includes('\0')) throw new Error('Ruta de archivo inválida.');
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('El archivo está fuera del repositorio.');
  }
  return resolved;
}

export function parseBranches(raw: string): GitBranch[] {
  return raw.split(/\r?\n/).filter(Boolean).map(line => {
    const [fullRef = '', name = '', hash = '', marker = ''] = line.split('\t');
    return { fullRef, name, hash, current: marker === '*', remote: fullRef.startsWith('refs/remotes/') };
  }).filter(branch => branch.fullRef && branch.name && !branch.name.endsWith('/HEAD'));
}

export function parseWorktrees(raw: string): GitWorktree[] {
  return raw.trim().split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/);
    const value = (key: string): string => lines.find(line => line.startsWith(`${key} `))?.slice(key.length + 1) ?? '';
    return { path: value('worktree'), hash: value('HEAD'), branch: value('branch').replace(/^refs\/heads\//, '') || 'HEAD desacoplado' };
  }).filter(worktree => worktree.path);
}

export function parseStatus(raw: string): GitChange[] {
  const fields = raw.split('\0');
  const changes: GitChange[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const xy = field.slice(0, 2);
    const file = field.slice(3);
    const renamed = /[RC]/.test(xy);
    const previousPath = renamed ? fields[++index] : undefined;
    changes.push({ path: file, previousPath, status: xy, staged: xy[0] !== ' ' && xy[0] !== '?', untracked: xy === '??' });
  }
  return changes;
}

export function parseCommits(raw: string): GitCommit[] {
  return raw.split('\x1e').map(record => record.trim()).filter(Boolean).map(record => {
    const [hash = '', shortHash = '', parentsRaw = '', subject = '', author = '', email = '', date = '', refsRaw = ''] = record.split('\x1f');
    return { hash, shortHash, parents: parentsRaw.split(' ').filter(Boolean), subject, author, email, avatarUrl: avatarUrlForEmail(email), date,
      refs: refsRaw.split(', ').map(ref => ref.trim()).filter(Boolean) };
  }).filter(commit => /^[0-9a-f]{40,64}$/i.test(commit.hash));
}

/** Foto pública si el correo identifica una cuenta; la interfaz usa iniciales si falla la imagen. */
export function avatarUrlForEmail(email: string): string | undefined {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return undefined;
  const github = /^(?:\d+\+)?([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)@users\.noreply\.github\.com$/.exec(normalized);
  if (github) return `https://github.com/${github[1]}.png?size=64`;
  const hash = createHash('sha256').update(normalized).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=64&d=404`;
}

export function parseCommitFiles(raw: string): GitCommitFile[] {
  const fields = raw.split('\0');
  const files: GitCommitFile[] = [];
  for (let index = 0; index < fields.length; index++) {
    const status = fields[index];
    if (!status) continue;
    const renamed = /^[RC]\d*$/.test(status);
    const previousPath = renamed ? fields[++index] : undefined;
    const file = fields[++index];
    if (file) files.push({ path: file, previousPath, status });
  }
  return files;
}
