import * as vscode from 'vscode';
import { log } from './log';

/** A host-only restart can leave a visible webview without running its serializer again. */
export function registerPanelRecovery(
  ctx: vscode.ExtensionContext,
  isOpen: () => boolean,
  reopen: (column: vscode.ViewColumn, preserveFocus: boolean) => void,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let recovering = false;
  const visibleOrphan = (): vscode.Tab | undefined => vscode.window.tabGroups.all
    .flatMap(group => group.tabs)
    .find(tab => tab.isActive && tab.input instanceof vscode.TabInputWebview &&
      ['muxentra', 'orcaTerminals', 'mainThreadWebview-muxentra', 'mainThreadWebview-orcaTerminals']
        .includes(tab.input.viewType));

  const recover = async (): Promise<void> => {
    timer = undefined;
    if (disposed || recovering || isOpen()) return;
    const tab = visibleOrphan();
    if (!tab) return;
    recovering = true;
    const column = tab.group.viewColumn;
    const preserveFocus = !tab.group.isActive;
    try {
      // Only close the orphaned editor, never its PTYs. The new panel attaches
      // to the same terminal IDs from workspaceState and restores their output.
      const closed = await vscode.window.tabGroups.close(tab, true);
      if (!closed || disposed || isOpen()) return;
      log().info('recuperando panel desconectado tras reiniciar el host de extensiones');
      reopen(column, preserveFocus);
    } catch (err) {
      log().warn(`no se pudo recuperar el panel: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      recovering = false;
    }
  };
  const schedule = (): void => {
    if (disposed || recovering || isOpen()) return;
    if (timer) clearTimeout(timer);
    // Give the normal serializer priority on a full window reload. Hidden
    // panels are checked only once they become visible, without stealing focus.
    timer = setTimeout(() => { void recover(); }, 1500);
  };
  ctx.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(schedule),
    { dispose: () => { disposed = true; if (timer) clearTimeout(timer); } },
  );
  schedule();
}
