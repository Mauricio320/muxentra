import * as vscode from 'vscode';
import { saveClipboardAttachment } from './clipboardImage';
import { installClaudeUsage } from './claudeUsageSetup';
import { currentAgentHomes } from './environment';
import { GitExplorer } from './gitExplorer';
import { registerGitDocumentProvider } from './gitPanel';
import { log } from './log';
import { MuxentraPanel } from './panel';
import { confirmPaste } from './pasteGuard';
import { registerPanelRecovery } from './panelRecovery';
import { quotePath } from './projectFiles';
import type { MuxentraCommand } from './protocol';
import { PtyClient } from './ptyClient';

const FORWARDED: MuxentraCommand[] = [
  'newTab',
  'closeTab',
  'renameTab',
  'renamePane',
  'tabColor',
  'nextTab',
  'prevTab',
  'splitRight',
  'splitDown',
  'closePane',
  'focusNextPane',
  'focusPrevPane',
  'equalize',
  'copy',
];

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(log());
  log().info(`activada v${ctx.extension.packageJSON.version} en ${process.platform}-${process.arch}, VS Code ${vscode.version}`);

  // Los shells viven en un servidor aparte: al desactivar solo se corta la conexión.
  const ptys = new PtyClient(ctx);
  ctx.subscriptions.push({ dispose: () => { MuxentraPanel.suspend(); ptys.dispose(); } });
  const git = new GitExplorer(vscode.workspace.getConfiguration('git').get<string>('path') || 'git');
  registerGitDocumentProvider(ctx, git);
  const openMuxentra = (): void => {
    MuxentraPanel.createOrShow(ctx, ptys, git);
  };

  for (const viewType of [MuxentraPanel.viewType, MuxentraPanel.legacyViewType]) {
    ctx.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(viewType, {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
          MuxentraPanel.revive(panel, ctx, ptys, git);
        },
      }),
    );
  }
  registerPanelRecovery(ctx, () => MuxentraPanel.isOpen(), (column, preserveFocus) => {
    MuxentraPanel.createOrShow(ctx, ptys, git, false, { viewColumn: column, preserveFocus });
  });
  // Migra las pestañas Git de versiones anteriores al panel unificado.
  ctx.subscriptions.push(vscode.window.registerWebviewPanelSerializer('muxentraGit', {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
      panel.dispose();
      setTimeout(() => {
        if (!MuxentraPanel.isOpen()) MuxentraPanel.createOrShow(ctx, ptys, git);
      }, 700);
    },
  }));

  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    ctx.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('muxentra.open', openMuxentra);
  register('muxentra.openGit', () => MuxentraPanel.createOrShow(ctx, ptys, git, true));

  register('muxentra.connectClaudeUsage', () => {
    try {
      installClaudeUsage(ctx.extensionPath, currentAgentHomes().claude);
      void vscode.window.showInformationMessage('Muxentra: uso de Claude conectado. Se actualizará cuando Claude reciba su próxima respuesta.');
    } catch (err) {
      void vscode.window.showErrorMessage(`Muxentra: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  for (const command of FORWARDED) {
    register(`muxentra.${command}`, () => {
      if (!MuxentraPanel.send(command)) openMuxentra();
    });
  }

  register('muxentra.focusAttention', () => {
    if (MuxentraPanel.focusAttention()) return;
    void vscode.window.showInformationMessage('Muxentra: ninguna terminal está esperando.');
  });

  // Deja en el proyecto la imagen (o el archivo) del portapapeles y pega su ruta.
  const pasteAttachment = async (quietIfNone: boolean): Promise<void> => {
    try {
      const saved = await saveClipboardAttachment();
      if (!saved) {
        if (!quietIfNone) void vscode.window.showInformationMessage('Muxentra: no hay ninguna imagen ni ningún archivo en el portapapeles.');
        return;
      }
      log().info(`${saved.kind === 'image' ? 'imagen pegada en' : 'archivo referenciado en'} ${saved.relative}`);
      if (!MuxentraPanel.send('paste', `${quotePath(saved.relative)} `)) {
        void vscode.window.showInformationMessage(`Muxentra: ${saved.relative}`);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Muxentra: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Ctrl+V pega texto si lo hay; si el portapapeles solo trae una imagen (una
  // captura, "Copiar imagen" del navegador) o un archivo copiado en el
  // explorador, lo deja en el proyecto y pega su ruta.
  register('muxentra.paste', async () => {
    const text = await vscode.env.clipboard.readText();
    if (!text) {
      await pasteAttachment(true);
      return;
    }
    if (!(await confirmPaste(text))) return;
    MuxentraPanel.send('paste', text);
  });

  register('muxentra.pasteImage', () => pasteAttachment(false));

  register('muxentra.killAll', async () => {
    const answer = await vscode.window.showWarningMessage(
      'Se cerrarán todas las terminales de Muxentra, incluidas las de otras ventanas. ¿Continuar?',
      { modal: true },
      'Cerrar todas',
    );
    if (answer !== 'Cerrar todas') return;
    try {
      await ptys.killAll();
    } catch (err) {
      void vscode.window.showErrorMessage(`Muxentra: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function deactivate(): void {
  // La desconexión se hace a través de ctx.subscriptions; las terminales siguen vivas.
}
