import type { GitBranch, GitChange, GitCommit, GitCommitDetail, GitSnapshot } from '../gitExplorer';
import type { GitHostMessage, GitViewMessage } from '../gitPanel';
import { brandMark } from '../brand';

export function mountGitView(host: HTMLElement, styleHref: string, send: (message: GitViewMessage) => void, onReady: () => void): { handleMessage: (message: GitHostMessage) => void } {
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = styleHref;
  let stylesheetReady = false;
  let dataReady = false;
  const finishLoading = (): void => { if (stylesheetReady && dataReady) onReady(); };
  style.addEventListener('load', () => { stylesheetReady = true; finishLoading(); }, { once: true });
  style.addEventListener('error', () => { stylesheetReady = true; finishLoading(); }, { once: true });
  const app = document.createElement('div');
  app.id = 'app';
  root.append(style, app);
  const vscode = { postMessage: send };
  const icons = {
    branch: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><circle cx="15" cy="8" r="2"/><path d="M5 6v8m0-3c0-3 10-1 10-5"/></svg>',
    refresh: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 7A7 7 0 1 0 17 11m-.5-7v4h-4"/></svg>',
    search: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>',
    close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>',
    file: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3V17.5H5z"/><path d="M12 2.5v3h3"/></svg>',
    worktree: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="5" r="1.7"/><circle cx="16" cy="5" r="1.7"/><circle cx="10" cy="15" r="1.7"/><path d="M4 6.7v2c0 2 6 1 6 4.6m6-6.6v2c0 2-6 1-6 4.6"/></svg>',
    people: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6" r="3"/><path d="M3.5 17v-1.5a6.5 6.5 0 0 1 13 0V17z"/></svg>',
  };

  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="brand-mark">${brandMark('git')}</span><span><strong>Muxentra <span class="brand-section">/ Git</span></strong><small>Tu código, en perspectiva.</small></span></div>
      <div class="top-actions">
        <label class="repo-control"><span>Repositorio</span><select id="repo-select" aria-label="Repositorio"></select></label>
        <button id="load-avatars" class="avatar-button icon-button" type="button" title="Buscar fotos en GitLab con nombres y correos de autores (requiere confirmación)" aria-label="Buscar fotos de autores en GitLab" hidden>${icons.people}<span>Fotos</span></button>
        <button id="refresh" class="icon-button" type="button" title="Actualizar Git" aria-label="Actualizar Git">${icons.refresh}</button>
      </div>
    </header>
    <div id="alert" class="alert" role="alert" hidden></div>
    <div id="empty" class="empty-state" hidden><span class="empty-mark">${icons.branch}</span><h1>No hay repositorios Git</h1><p>Abre una carpeta con Git en este workspace para ver sus ramas, commits y cambios.</p></div>
    <main id="workspace" hidden>
      <section class="overview" aria-label="Resumen del repositorio">
        <div class="overview-main"><span class="eyebrow">REPOSITORIO ACTIVO</span><strong id="repo-name"></strong><span id="repo-path" class="repo-path"></span></div>
        <div class="overview-stats"><div><span>RAMA</span><strong id="current-branch"></strong></div><div><span>CAMBIOS</span><strong id="change-count"></strong></div><div><span>WORKTREES</span><strong id="worktree-count"></strong></div></div>
      </section>
      <div id="workspace-grid" class="workspace-grid">
        <aside id="rail" class="rail" aria-label="Explorador Git">
          <section class="rail-section"><div class="section-title"><span>Cambios locales</span><span id="changes-badge" class="count"></span></div><div id="changes-list" class="rail-list"></div></section>
          <section class="rail-section"><div class="section-title"><span>Ramas</span><span id="branches-badge" class="count"></span></div><div id="branches-list" class="rail-list"></div></section>
          <section class="rail-section worktrees-section"><div class="section-title"><span>Worktrees</span><span id="worktrees-badge" class="count"></span></div><div id="worktrees-list" class="rail-list"></div></section>
        </aside>
        <button id="rail-backdrop" class="rail-backdrop" type="button" aria-label="Cerrar explorador Git"></button>
        <section class="history" aria-label="Historial de commits">
          <div class="history-header"><div class="history-heading"><button id="toggle-rail" class="icon-button" type="button" aria-label="Abrir ramas y cambios" aria-controls="rail" aria-expanded="false">${icons.branch}</button><div><span class="eyebrow">HISTORIAL</span><h1 id="history-title">Todas las ramas</h1></div></div><label class="search">${icons.search}<input id="search" type="search" placeholder="Buscar mensaje, autor o SHA" aria-label="Buscar commits"></label></div>
          <div class="history-columns"><span>COMMITS</span><span id="history-count"></span></div>
          <div id="commits-list" class="commits-list"></div>
          <div id="history-footer" class="history-footer"></div>
        </section>
        <aside id="detail" class="detail" aria-label="Detalle del commit" hidden>
          <div class="detail-header"><span class="eyebrow">DETALLE DEL COMMIT</span><button id="close-detail" class="icon-button" type="button" aria-label="Cerrar detalle">${icons.close}</button></div>
          <div id="detail-content" class="detail-content"></div>
        </aside>
      </div>
    </main>`;

  const get = <T extends HTMLElement>(id: string): T => root.getElementById(id) as T;
  const repoSelect = get<HTMLSelectElement>('repo-select');
  const refreshButton = get<HTMLButtonElement>('refresh');
  const avatarButton = get<HTMLButtonElement>('load-avatars');
  const search = get<HTMLInputElement>('search');
  const commitsList = get<HTMLElement>('commits-list');
  const detailEl = get<HTMLElement>('detail');
  const detailContent = get<HTMLElement>('detail-content');
  const workspaceGrid = get<HTMLElement>('workspace-grid');
  let snapshot: GitSnapshot | undefined;
  let detail: GitCommitDetail | undefined;
  let selectedHash = '';
  let avatarStatus: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle';
  const gitlabAvatars = new Map<string, string>();

  function setAvatarStatus(status: typeof avatarStatus): void {
    avatarStatus = status;
    avatarButton.disabled = status === 'loading';
    avatarButton.classList.toggle('loading', status === 'loading');
    avatarButton.querySelector('span')!.textContent = status === 'loading' ? 'Buscando…' : status === 'ready' ? 'Fotos ✓' : status === 'unavailable' ? 'Reintentar' : 'Fotos';
    avatarButton.title = status === 'unavailable'
      ? 'No se encontraron fotos públicas en GitLab. Reintentar la búsqueda.'
      : status === 'ready'
        ? 'Se encontraron fotos en GitLab. Buscar de nuevo las que falten.'
      : 'Buscar fotos en GitLab con nombres y correos de autores (requiere confirmación)';
  }

  function textElement(tag: string, className: string, value: string): HTMLElement {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
  }

  function makeButton(className: string, title: string, content: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = title;
    button.textContent = content;
    return button;
  }

  function shortDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  }

  function authorAvatar(name: string, url?: string, large = false): HTMLElement {
    const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toLocaleUpperCase() || '?';
    const tone = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5;
    const avatar = textElement('span', `avatar tone-${tone}${large ? ' avatar-large' : ''}`, initials);
    avatar.setAttribute('aria-hidden', 'true');
    if (url && /^https:\/\/(?:www\.gravatar\.com|gravatar\.com|github\.com|gitlab\.com)\//.test(url)) {
      const photo = document.createElement('img');
      photo.alt = '';
      photo.loading = large ? 'eager' : 'lazy';
      photo.decoding = 'async';
      photo.referrerPolicy = 'no-referrer';
      photo.addEventListener('load', () => avatar.classList.add('has-image'));
      photo.addEventListener('error', () => photo.remove());
      photo.src = url;
      avatar.append(photo);
    }
    return avatar;
  }

  function refClass(ref: string): string {
    if (ref.includes('HEAD')) return 'ref-pill head-ref';
    if (ref.startsWith('tag:')) return 'ref-pill tag-ref';
    if (ref.startsWith('origin/')) return 'ref-pill remote-ref';
    return 'ref-pill';
  }

  function renderSnapshot(next: GitSnapshot): void {
    const railScroll = get<HTMLElement>('rail').scrollTop;
    const historyScroll = commitsList.scrollTop;
    const previousRef = snapshot?.selectedRef;
    snapshot = next;
    get<HTMLElement>('empty').hidden = true;
    get<HTMLElement>('workspace').hidden = false;
    const previousRoot = repoSelect.value;
    repoSelect.replaceChildren();
    for (const repo of next.repositories) {
      const option = document.createElement('option');
      option.value = repo.root;
      option.textContent = repo.label;
      repoSelect.append(option);
    }
    repoSelect.value = next.repository.root;
    if ((previousRoot && previousRoot !== next.repository.root) || (previousRef !== undefined && previousRef !== next.selectedRef)) {
      selectedHash = '';
      detail = undefined;
      if (previousRoot !== next.repository.root) search.value = '';
    }
    if (previousRoot && previousRoot !== next.repository.root) {
      gitlabAvatars.clear();
      setAvatarStatus('idle');
    }
    avatarButton.hidden = !next.gitlabAvatarsAvailable;
    get<HTMLElement>('repo-name').textContent = next.repository.label;
    get<HTMLElement>('repo-path').textContent = next.repository.root;
    get<HTMLElement>('current-branch').textContent = next.repository.detached ? `HEAD · ${next.repository.branch}` : next.repository.branch;
    get<HTMLElement>('change-count').textContent = String(next.changes.length);
    get<HTMLElement>('worktree-count').textContent = String(next.worktrees.length);
    get<HTMLElement>('changes-badge').textContent = String(next.changes.length);
    get<HTMLElement>('branches-badge').textContent = String(next.branches.length);
    get<HTMLElement>('worktrees-badge').textContent = String(next.worktrees.length);
    renderChanges(next.changes);
    renderBranches(next.branches, next.selectedRef);
    renderWorktrees(next);
    const ref = next.branches.find(branch => branch.fullRef === next.selectedRef);
    get<HTMLElement>('history-title').textContent = ref?.name ?? 'Todas las ramas';
    if (selectedHash && !next.commits.some(commit => commit.hash === selectedHash)) {
      selectedHash = '';
      detail = undefined;
      renderDetail();
    }
    renderCommits();
    commitsList.scrollTop = historyScroll;
    const rail = get<HTMLElement>('rail');
    rail.scrollTop = railScroll;
  }

  function renderChanges(changes: GitChange[]): void {
    const list = get<HTMLElement>('changes-list');
    list.replaceChildren();
    if (!changes.length) {
      list.append(textElement('p', 'rail-empty', 'Árbol de trabajo limpio'));
      return;
    }
    for (const change of changes.slice(0, 70)) {
      const code = change.untracked ? '?' : change.status.includes('D') ? '−' : change.status.includes('A') ? '+' : change.status.includes('R') ? '↗' : 'M';
      const button = makeButton('rail-item change-item', `Comparar cambios de ${change.path}`, '');
      button.append(textElement('span', `status-code ${change.untracked ? 'new' : change.status.includes('D') ? 'removed' : ''}`, code));
      button.append(textElement('span', 'item-text', change.path));
      if (change.staged) button.append(textElement('span', 'staged-dot', '●'));
      button.addEventListener('click', () => vscode.postMessage({ type: 'workingDiff', file: change.path }));
      list.append(button);
    }
    if (changes.length > 70) list.append(textElement('p', 'rail-empty', `+ ${changes.length - 70} cambios más`));
  }

  function renderBranches(branches: GitBranch[], selectedRef: string): void {
    const list = get<HTMLElement>('branches-list');
    list.replaceChildren();
    const all = makeButton(`rail-item branch-item ${selectedRef ? '' : 'selected'}`, 'Ver todas las ramas', 'Todas las ramas');
    all.insertAdjacentHTML('afterbegin', icons.branch);
    all.addEventListener('click', () => { closeRail(); vscode.postMessage({ type: 'ref', ref: '' }); });
    list.append(all);
    for (const branch of branches.filter(item => !item.remote).slice(0, 60)) addBranch(branch, list, selectedRef);
    const remotes = branches.filter(item => item.remote);
    if (remotes.length) list.append(textElement('div', 'rail-subtitle', 'REMOTAS'));
    for (const branch of remotes.slice(0, 35)) addBranch(branch, list, selectedRef);
  }

  function addBranch(branch: GitBranch, list: HTMLElement, selectedRef: string): void {
    const button = makeButton(`rail-item branch-item ${branch.fullRef === selectedRef ? 'selected' : ''}`, `Ver historial de ${branch.name}`, '');
    button.insertAdjacentHTML('afterbegin', icons.branch);
    button.append(textElement('span', 'item-text', branch.name));
    if (branch.current) button.append(textElement('span', 'current-pill', 'ACTUAL'));
    button.addEventListener('click', () => { closeRail(); vscode.postMessage({ type: 'ref', ref: branch.fullRef }); });
    list.append(button);
  }

  function renderWorktrees(current: GitSnapshot): void {
    const list = get<HTMLElement>('worktrees-list');
    list.replaceChildren();
    if (!current.worktrees.length) {
      list.append(textElement('p', 'rail-empty', 'Sin worktrees'));
      return;
    }
    for (const worktree of current.worktrees) {
      const card = document.createElement('div');
      card.className = `worktree-card ${worktree.path === current.repository.root ? 'active' : ''}`;
      card.innerHTML = icons.worktree;
      const text = document.createElement('div');
      text.append(textElement('strong', '', worktree.branch), textElement('span', '', worktree.path));
      card.append(text);
      list.append(card);
    }
  }

  interface GraphRow { lane: number; before: string[]; after: string[]; parents: string[] }

  function graphRows(commits: GitCommit[]): GraphRow[] {
    let active: string[] = [];
    return commits.map(commit => {
      let lane = active.indexOf(commit.hash);
      if (lane < 0) { lane = active.length; active.push(commit.hash); }
      const before = [...active];
      const after = active.filter(hash => hash !== commit.hash);
      for (const [index, parent] of commit.parents.entries()) {
        if (!after.includes(parent)) after.splice(Math.min(lane + index, after.length), 0, parent);
      }
      active = after;
      return { lane, before, after, parents: commit.parents };
    });
  }

  function laneColor(lane: number): string {
    return ['#27b8d5', '#658dff', '#b06ae5', '#e7ad53', '#62c9a2', '#e886ac', '#91adf2'][lane % 7];
  }

  const relativeTime = new Intl.RelativeTimeFormat('es', { numeric: 'always', style: 'short' });

  function commitAge(value: string): string {
    const elapsed = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(elapsed) || elapsed < 0) return shortDate(value);
    for (const [unit, duration] of [
      ['year', 365 * 86400000], ['month', 30 * 86400000], ['week', 7 * 86400000],
      ['day', 86400000], ['hour', 3600000], ['minute', 60000],
    ] as const) {
      if (elapsed >= duration) return relativeTime.format(-Math.floor(elapsed / duration), unit);
    }
    return 'ahora';
  }

  function graphSvg(row: GraphRow, commit: GitCommit, width: number): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const height = 34;
    const center = height / 2;
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('aria-hidden', 'true');
    const x = (lane: number): number => 15 + lane * 19;
    const addPath = (d: string, color: string, strokeWidth = 2): void => {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', String(strokeWidth));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
    };
    for (const [from, hash] of row.before.entries()) {
      if (from === row.lane) {
        addPath(`M ${x(from)} 0 V ${center}`, laneColor(from));
        continue;
      }
      const to = row.after.indexOf(hash);
      if (to >= 0) addPath(to === from
        ? `M ${x(from)} 0 V ${height}`
        : `M ${x(from)} 0 V 10 C ${x(from)} 24 ${x(to)} 18 ${x(to)} ${height}`,
      laneColor(from));
    }
    for (const parent of row.parents) {
      const to = row.after.indexOf(parent);
      if (to >= 0) addPath(to === row.lane
        ? `M ${x(row.lane)} ${center} V ${height}`
        : `M ${x(row.lane)} ${center} C ${x(row.lane)} 29 ${x(to)} 23 ${x(to)} ${height}`,
      laneColor(to));
    }
    const nodeX = x(row.lane);
    const color = laneColor(row.lane);
    const decorated = commit.parents.length > 1 || commit.refs.some(ref => ref.startsWith('tag:') || ref.includes('HEAD'));
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', String(nodeX));
    circle.setAttribute('cy', String(center));
    circle.setAttribute('r', decorated ? '8' : '4.5');
    circle.setAttribute('fill', decorated ? 'var(--vscode-editor-background)' : color);
    circle.setAttribute('stroke', decorated ? color : 'var(--vscode-editor-background)');
    circle.setAttribute('stroke-width', decorated ? '1.8' : '1.4');
    svg.append(circle);
    if (commit.parents.length > 1) {
      addPath(`M ${nodeX - 3} ${center - 4} V ${center + 4} M ${nodeX - 3} ${center - 1} C ${nodeX - 3} ${center + 2} ${nodeX + 3} ${center} ${nodeX + 3} ${center - 2}`, color, 1.35);
      for (const [cx, cy] of [[nodeX - 3, center - 4], [nodeX - 3, center + 4], [nodeX + 3, center - 2]]) {
        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('cx', String(cx));
        dot.setAttribute('cy', String(cy));
        dot.setAttribute('r', '1.25');
        dot.setAttribute('fill', color);
        svg.append(dot);
      }
    } else if (commit.refs.some(ref => ref.startsWith('tag:'))) {
      addPath(`M ${nodeX - 4} ${center - 1} L ${nodeX - 1} ${center - 4} L ${nodeX + 4} ${center + 1} L ${nodeX + 1} ${center + 4} Z`, color, 1.3);
    } else if (decorated) {
      const inner = document.createElementNS(ns, 'circle');
      inner.setAttribute('cx', String(nodeX));
      inner.setAttribute('cy', String(center));
      inner.setAttribute('r', '3');
      inner.setAttribute('fill', color);
      svg.append(inner);
    }
    return svg;
  }

  function renderCommits(): void {
    const current = snapshot;
    if (!current) return;
    const query = search.value.trim().toLocaleLowerCase();
    const commits = query ? current.commits.filter(commit => [commit.subject, commit.author, commit.hash, ...commit.refs].some(value => value.toLocaleLowerCase().includes(query))) : current.commits;
    get<HTMLElement>('history-count').textContent = `${commits.length} ${commits.length === 1 ? 'resultado' : 'resultados'}`;
    const graph = graphRows(commits);
    const graphWidth = Math.min(150, Math.max(88, 23 + Math.max(0, ...graph.map(row => Math.max(row.before.length, row.after.length))) * 19));
    commitsList.replaceChildren();
    if (!commits.length) {
      commitsList.append(textElement('p', 'no-commits', query ? 'No hay commits que coincidan con la búsqueda.' : 'Esta rama todavía no tiene commits.'));
    }
    for (const [index, commit] of commits.entries()) {
      const button = makeButton(`commit-row ${selectedHash === commit.hash ? 'selected' : ''}`, `Ver commit ${commit.shortHash}: ${commit.subject}`, '');
      button.style.setProperty('--commit-lane-color', laneColor(graph[index].lane));
      button.setAttribute('aria-label', `${commit.subject || 'Sin asunto'}, ${commit.author}, ${shortDate(commit.date)}, ${commit.shortHash}`);
      const lead = document.createElement('div');
      lead.className = 'commit-lead';
      const graphCell = document.createElement('span');
      graphCell.className = 'commit-graph';
      graphCell.style.width = `${graphWidth}px`;
      graphCell.append(graphSvg(graph[index], commit, graphWidth));
      lead.append(graphCell);
      const avatar = authorAvatar(commit.author, gitlabAvatars.get(commit.email.toLowerCase()) ?? commit.avatarUrl);
      avatar.title = commit.author;
      lead.append(avatar);
      const text = document.createElement('div');
      text.className = 'commit-copy';
      const subject = textElement('strong', 'commit-subject', commit.subject || '(sin asunto)');
      text.append(subject);
      if (commit.refs.length) {
        const refs = document.createElement('span');
        refs.className = 'commit-refs';
        for (const ref of commit.refs.slice(0, 2)) refs.append(textElement('span', refClass(ref), ref));
        text.append(refs);
      }
      lead.append(text);
      const side = document.createElement('span');
      side.className = 'commit-side';
      side.append(textElement('span', 'commit-author', commit.author));
      const age = textElement('span', 'commit-age', commitAge(commit.date));
      age.title = shortDate(commit.date);
      side.append(age);
      button.append(lead, side);
      button.addEventListener('click', () => {
        commitsList.querySelector('.commit-row.selected')?.classList.remove('selected');
        button.classList.add('selected');
        selectedHash = commit.hash;
        detail = undefined;
        renderDetail();
        vscode.postMessage({ type: 'commit', hash: commit.hash });
      });
      commitsList.append(button);
    }
    get<HTMLElement>('history-footer').textContent = query
      ? `${commits.length} de ${current.commits.length} commits cargados`
      : `${current.commits.length} commits recientes · actualizado automáticamente`;
  }

  function renderDetail(): void {
    detailEl.hidden = !selectedHash;
    detailContent.replaceChildren();
    if (!selectedHash) return;
    if (!detail || detail.hash !== selectedHash) {
      detailContent.append(textElement('p', 'detail-loading', 'Cargando detalle…'));
      return;
    }
    detailContent.append(textElement('span', 'detail-hash', detail.hash.slice(0, 12)));
    detailContent.append(textElement('h2', 'detail-subject', detail.subject));
    const meta = document.createElement('div');
    meta.className = 'detail-meta';
    meta.append(authorAvatar(detail.author, gitlabAvatars.get(detail.email.toLowerCase()) ?? detail.avatarUrl, true));
    const identity = document.createElement('div');
    identity.className = 'detail-identity';
    identity.append(textElement('strong', '', detail.author), textElement('span', '', `${shortDate(detail.date)} · ${detail.email}`));
    meta.append(identity);
    detailContent.append(meta);
    const body = detail.body.slice(detail.subject.length).trim();
    if (body) detailContent.append(textElement('p', 'detail-body', body));
    detailContent.append(textElement('h3', 'files-title', `Archivos · ${detail.files.length}`));
    if (!detail.files.length) detailContent.append(textElement('p', 'rail-empty', 'Este commit no muestra archivos modificados.'));
    for (const file of detail.files) {
      const code = file.status.startsWith('A') ? '+' : file.status.startsWith('D') ? '−' : file.status.startsWith('R') ? '↗' : 'M';
      const button = makeButton('file-item', `Comparar ${file.path}`, '');
      button.append(textElement('span', `status-code ${code === '+' ? 'new' : code === '−' ? 'removed' : ''}`, code));
      button.append(textElement('span', 'item-text', file.path));
      button.insertAdjacentHTML('beforeend', icons.file);
      button.addEventListener('click', () => vscode.postMessage({ type: 'commitDiff', hash: selectedHash, file: file.path }));
      detailContent.append(button);
    }
  }

  function closeRail(): void {
    workspaceGrid.classList.remove('show-rail');
    get<HTMLButtonElement>('toggle-rail').setAttribute('aria-expanded', 'false');
  }

  repoSelect.addEventListener('change', () => { closeRail(); vscode.postMessage({ type: 'repo', root: repoSelect.value }); });
  refreshButton.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  avatarButton.addEventListener('click', () => {
    setAvatarStatus('loading');
    vscode.postMessage({ type: 'loadGitlabAvatars' });
  });
  search.addEventListener('input', () => renderCommits());
  get<HTMLButtonElement>('toggle-rail').addEventListener('click', () => {
    const open = workspaceGrid.classList.toggle('show-rail');
    get<HTMLButtonElement>('toggle-rail').setAttribute('aria-expanded', String(open));
  });
  get<HTMLButtonElement>('rail-backdrop').addEventListener('click', closeRail);
  get<HTMLButtonElement>('close-detail').addEventListener('click', () => {
    selectedHash = '';
    detail = undefined;
    renderDetail();
    commitsList.querySelector('.commit-row.selected')?.classList.remove('selected');
  });
  window.addEventListener('keydown', event => {
    if (host.hidden) return;
    if (event.key === 'Escape' && workspaceGrid.classList.contains('show-rail')) {
      closeRail();
      return;
    }
    if (event.key === 'Escape' && selectedHash) {
      selectedHash = '';
      detail = undefined;
      renderDetail();
      commitsList.querySelector('.commit-row.selected')?.classList.remove('selected');
    }
  });
  function handleMessage(message: GitHostMessage): void {
    switch (message.type) {
      case 'loading':
        refreshButton.classList.add('loading');
        refreshButton.disabled = true;
        break;
      case 'snapshot':
        refreshButton.classList.remove('loading');
        refreshButton.disabled = false;
        get<HTMLElement>('alert').hidden = true;
        if (message.snapshot) renderSnapshot(message.snapshot);
        dataReady = true;
        finishLoading();
        break;
      case 'detail':
        if (message.detail?.hash === selectedHash) {
          detail = message.detail;
          renderDetail();
        }
        break;
      case 'avatars':
        for (const [email, url] of Object.entries(message.avatars ?? {})) gitlabAvatars.set(email.toLowerCase(), url);
        if (snapshot) {
          const scroll = commitsList.scrollTop;
          renderCommits();
          commitsList.scrollTop = scroll;
          if (selectedHash) renderDetail();
        }
        break;
      case 'avatarStatus':
        if (message.status) setAvatarStatus(message.status);
        break;
      case 'empty':
        snapshot = undefined;
        selectedHash = '';
        detail = undefined;
        refreshButton.classList.remove('loading');
        refreshButton.disabled = false;
        get<HTMLElement>('workspace').hidden = true;
        get<HTMLElement>('empty').hidden = false;
        get<HTMLElement>('empty').querySelector('h1')!.textContent = 'No hay repositorios Git';
        get<HTMLElement>('empty').querySelector('p')!.textContent = 'Abre una carpeta con Git en este workspace para ver sus ramas, commits y cambios.';
        dataReady = true;
        finishLoading();
        break;
      case 'error':
        refreshButton.classList.remove('loading');
        refreshButton.disabled = false;
        get<HTMLElement>('alert').textContent = message.message ?? 'No se pudo cargar Git.';
        get<HTMLElement>('alert').hidden = false;
        if (!snapshot) {
          get<HTMLElement>('empty').hidden = false;
          get<HTMLElement>('empty').querySelector('h1')!.textContent = 'No se pudo cargar Git';
          get<HTMLElement>('empty').querySelector('p')!.textContent = 'Comprueba que Git esté instalado y disponible para VS Code.';
        }
        dataReady = true;
        finishLoading();
        break;
    }
  }
  vscode.postMessage({ type: 'ready' });
  return { handleMessage };
}
