import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  assertHash,
  assertRelativeFile,
  discoverGitRepositories,
  GitExplorer,
  type GitCommitDetail,
  type GitRepository,
  type GitSnapshot,
} from './gitExplorer';
import { log } from './log';
import { GitlabAvatarLookup } from './gitlabAvatars';

export type GitViewMessage =
  | { type: 'ready' | 'refresh' }
  | { type: 'repo'; root: string }
  | { type: 'ref'; ref: string }
  | { type: 'commit'; hash: string }
  | { type: 'commitDiff'; hash: string; file: string }
  | { type: 'workingDiff'; file: string }
  | { type: 'loadGitlabAvatars' };

export type GitHostMessage =
  | { type: 'loading' }
  | { type: 'snapshot'; snapshot: GitSnapshot }
  | { type: 'detail'; detail: GitCommitDetail }
  | { type: 'empty' }
  | { type: 'avatars'; avatars: Record<string, string> }
  | { type: 'avatarStatus'; status: 'idle' | 'loading' | 'ready' | 'unavailable' }
  | { type: 'error'; message: string };

const DOCUMENT_SCHEME = 'muxentra-git';
const SELECTED_REPO_KEY = 'muxentra.git.selectedRepository';

function workspaceRoots(): string[] {
  return vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath) ?? [];
}

function gitUri(root: string, hash: string | undefined, file: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: DOCUMENT_SCHEME,
    path: `/${path.basename(file)}`,
    query: JSON.stringify({ root, hash, file }),
  });
}

export class GitDocumentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly git: GitExplorer) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const request = JSON.parse(uri.query) as { root?: string; hash?: string; file?: string };
    if (typeof request.root !== 'string' || typeof request.file !== 'string') throw new Error('Documento Git inválido.');
    const available = discoverGitRepositories(workspaceRoots());
    if (!available.some(repo => repo.root === request.root)) throw new Error('El repositorio no está abierto.');
    assertRelativeFile(request.root, request.file);
    if (request.hash === undefined) return '';
    assertHash(request.hash);
    return this.git.fileAt(request.root, request.hash, request.file);
  }
}

export function registerGitDocumentProvider(ctx: vscode.ExtensionContext, git: GitExplorer): void {
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DOCUMENT_SCHEME, new GitDocumentProvider(git)));
}

/** Datos y acciones de Git compartidos por la pestaña interna de Muxentra. */
export class GitController {

  private readonly disposables: vscode.Disposable[] = [];
  private readonly refreshTimer: NodeJS.Timeout;
  private readonly gitlabAvatars = new GitlabAvatarLookup();
  private readonly avatarResults = new Map<string, Record<string, string>>();
  private readonly avatarQueried = new Map<string, Set<string>>();
  private readonly avatarLoading = new Set<string>();
  private avatarDeliveredRoot = '';
  private repositories: GitRepository[] = [];
  private snapshot?: GitSnapshot;
  private selectedRoot: string;
  private selectedRef = '';
  private selectedCommit = '';
  private requestId = 0;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly git: GitExplorer,
    private readonly post: (message: GitHostMessage) => void,
    private readonly isVisible: () => boolean,
  ) {
    this.selectedRoot = ctx.workspaceState.get<string>(SELECTED_REPO_KEY) ?? '';
    vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh(), undefined, this.disposables);
    this.refreshTimer = setInterval(() => { if (this.isVisible()) void this.refresh(); }, 15_000);
  }

  async onMessage(message: GitViewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.avatarDeliveredRoot = '';
          await this.refresh();
          break;
        case 'refresh':
          await this.refresh();
          break;
        case 'repo':
          if (!this.repositories.some(repo => repo.root === message.root)) return;
          this.selectedRoot = message.root;
          this.avatarDeliveredRoot = '';
          this.selectedRef = '';
          this.selectedCommit = '';
          void this.ctx.workspaceState.update(SELECTED_REPO_KEY, message.root);
          await this.refresh();
          break;
        case 'ref':
          if (message.ref && !this.snapshot?.branches.some(branch => branch.fullRef === message.ref)) return;
          this.selectedRef = message.ref;
          this.selectedCommit = '';
          await this.refresh();
          break;
        case 'commit':
          if (!this.snapshot?.commits.some(commit => commit.hash === message.hash)) return;
          this.selectedCommit = message.hash;
          await this.loadDetail(message.hash);
          break;
        case 'commitDiff':
          await this.openCommitDiff(message.hash, message.file);
          break;
        case 'workingDiff':
          await this.openWorkingDiff(message.file);
          break;
        case 'loadGitlabAvatars':
          await this.requestGitlabAvatars();
          break;
      }
    } catch (error) {
      this.report(error);
    }
  }

  async refresh(): Promise<void> {
    const request = ++this.requestId;
    this.repositories = discoverGitRepositories(workspaceRoots());
    if (!this.repositories.length) {
      this.snapshot = undefined;
      this.post({ type: 'empty' });
      return;
    }
    if (!this.repositories.some(repo => repo.root === this.selectedRoot)) this.selectedRoot = this.repositories[0].root;
    this.post({ type: 'loading' });
    try {
      const snapshot = await this.git.snapshot(this.repositories, this.selectedRoot, this.selectedRef);
      if (request !== this.requestId) return;
      this.snapshot = snapshot;
      this.selectedRef = snapshot.selectedRef;
      this.post({ type: 'snapshot', snapshot });
      if (snapshot.gitlabAvatarsAvailable && this.ctx.workspaceState.get<boolean>(this.avatarConsentKey(snapshot.repository.root), false)) {
        void this.loadGitlabAvatars(snapshot);
      }
      if (this.selectedCommit && snapshot.commits.some(commit => commit.hash === this.selectedCommit)) {
        await this.loadDetail(this.selectedCommit);
      } else {
        this.selectedCommit = '';
      }
    } catch (error) {
      if (request === this.requestId) this.report(error);
    }
  }

  private async loadDetail(hash: string): Promise<void> {
    const root = this.selectedRoot;
    const detail = await this.git.commit(root, hash);
    if (root === this.selectedRoot && hash === this.selectedCommit) this.post({ type: 'detail', detail });
  }

  private avatarConsentKey(root: string): string {
    return `muxentra.gitlabAvatars.${crypto.createHash('sha256').update(root.toLowerCase()).digest('hex')}`;
  }

  private async requestGitlabAvatars(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot?.gitlabAvatarsAvailable) return;
    const root = snapshot.repository.root;
    const key = this.avatarConsentKey(root);
    if (!this.ctx.workspaceState.get<boolean>(key, false)) {
      const answer = await vscode.window.showInformationMessage(
        'Buscar fotos de autores en GitLab',
        { modal: true, detail: 'Muxentra enviará a gitlab.com los nombres y correos de los autores de este repositorio. Esta preferencia se guardará solo para este repositorio.' },
        'Buscar fotos',
      );
      if (answer !== 'Buscar fotos') {
        if (this.selectedRoot === root) this.post({ type: 'avatarStatus', status: 'idle' });
        return;
      }
      await this.ctx.workspaceState.update(key, true);
    }
    if (this.selectedRoot !== root) return;
    await this.loadGitlabAvatars(snapshot, true);
  }

  private async loadGitlabAvatars(snapshot: GitSnapshot, force = false): Promise<void> {
    const root = snapshot.repository.root;
    const cached = this.avatarResults.get(root);
    const queried = this.avatarQueried.get(root) ?? new Set<string>();
    const distinct = new Map<string, string>();
    for (const commit of snapshot.commits) {
      const email = commit.email.trim().toLowerCase();
      if (!email || (!force && queried.has(email))) continue;
      if (!distinct.has(email) && distinct.size >= 24) continue;
      if (commit.author.length > (distinct.get(email)?.length ?? 0)) distinct.set(email, commit.author);
    }
    const pending = [...distinct].map(([email, name]) => ({ email, name }));
    if (cached && !pending.length) {
      if (this.selectedRoot === root && this.avatarDeliveredRoot !== root) {
        this.post({ type: 'avatars', avatars: cached });
        this.post({ type: 'avatarStatus', status: Object.keys(cached).length ? 'ready' : 'unavailable' });
        this.avatarDeliveredRoot = root;
      }
      return;
    }
    if (this.avatarLoading.has(root)) return;
    this.avatarLoading.add(root);
    this.post({ type: 'avatarStatus', status: 'loading' });
    try {
      const avatars = { ...cached, ...await this.gitlabAvatars.find(pending) };
      this.avatarResults.set(root, avatars);
      for (const author of pending) queried.add(author.email.trim().toLowerCase());
      this.avatarQueried.set(root, queried);
      if (this.selectedRoot === root) {
        this.post({ type: 'avatars', avatars });
        this.post({ type: 'avatarStatus', status: Object.keys(avatars).length ? 'ready' : 'unavailable' });
        this.avatarDeliveredRoot = root;
      }
    } finally {
      this.avatarLoading.delete(root);
    }
  }

  private async openCommitDiff(hash: string, file: string): Promise<void> {
    if (!this.snapshot?.commits.some(commit => commit.hash === hash)) return;
    const detail = await this.git.commit(this.selectedRoot, hash);
    const changed = detail.files.find(item => item.path === file);
    if (!changed) return;
    const previous = detail.parents[0];
    const left = gitUri(this.selectedRoot, changed.status.startsWith('A') ? undefined : previous, changed.previousPath ?? file);
    const right = gitUri(this.selectedRoot, changed.status.startsWith('D') ? undefined : hash, file);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${file} · ${hash.slice(0, 8)}`, { preview: true });
  }

  private async openWorkingDiff(file: string): Promise<void> {
    const change = this.snapshot?.changes.find(item => item.path === file);
    if (!change) return;
    const root = this.selectedRoot;
    const head = await this.git.head(root);
    const left = gitUri(root, change.untracked || change.status[0] === 'A' || !head ? undefined : head, change.previousPath ?? file);
    const workingFile = assertRelativeFile(root, file);
    const right = fs.existsSync(workingFile) ? vscode.Uri.file(workingFile) : gitUri(root, undefined, file);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${file} · cambios locales`, { preview: true });
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    log().warn(`Git: ${message}`);
    this.post({ type: 'error', message });
  }

  dispose(): void {
    ++this.requestId;
    clearInterval(this.refreshTimer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

}
