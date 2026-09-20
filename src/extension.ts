import * as vscode from 'vscode';
import { saveClipboardImage } from './clipboardImage';
import { log } from './log';
import { MuxentraPanel } from './panel';
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
  ctx.subscriptions.push({ dispose: () => ptys.dispose() });

  for (const viewType of [MuxentraPanel.viewType, MuxentraPanel.legacyViewType]) {
    ctx.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(viewType, {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
          MuxentraPanel.revive(panel, ctx, ptys);
        },
      }),
    );
  }

  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    ctx.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('muxentra.open', () => MuxentraPanel.createOrShow(ctx, ptys));

  for (const command of FORWARDED) {
    register(`muxentra.${command}`, () => {
      if (!MuxentraPanel.send(command)) MuxentraPanel.createOrShow(ctx, ptys);
    });
  }

  register('muxentra.focusAttention', () => {
    if (MuxentraPanel.focusAttention()) return;
    void vscode.window.showInformationMessage('Muxentra: ninguna terminal está esperando.');
  });

  register('muxentra.paste', async () => {
    const text = await vscode.env.clipboard.readText();
    if (!text) return;
    if (!(await confirmPaste(text))) return;
    MuxentraPanel.send('paste', text);
  });

  // Guarda la imagen del portapapeles en el proyecto y pega su ruta en la terminal.
  register('muxentra.pasteImage', async () => {
    try {
      const saved = await saveClipboardImage();
      if (!saved) {
        void vscode.window.showInformationMessage('Muxentra: no hay ninguna imagen en el portapapeles.');
        return;
      }
      log().info(`imagen pegada en ${saved.relative}`);
      if (!MuxentraPanel.send('paste', `${saved.relative} `)) {
        void vscode.window.showInformationMessage(`Muxentra: imagen guardada en ${saved.relative}`);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Muxentra: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

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

/**
 * Un texto de varias líneas se ejecuta solo al pegarlo, porque cada salto de
 * línea hace de Enter. Lo que hay en el portapapeles puede venir de una página
 * web que muestre un comando y copie otro, así que se enseña antes de soltarlo
 * en el shell. Es el mismo aviso que da la terminal de VS Code.
 */
async function confirmPaste(text: string): Promise<boolean> {
  if (!vscode.workspace.getConfiguration('muxentra').get<boolean>('multiLinePasteWarning', true)) return true;
  const lines = text.replace(/\s+$/, '').split(/\r\n|\r|\n/);
  if (lines.length < 2) return true;
  const answer = await vscode.window.showWarningMessage(
    `Vas a pegar ${lines.length} líneas en la terminal y se ejecutarán de inmediato.`,
    { modal: true, detail: preview(lines) },
    'Pegar',
  );
  return answer === 'Pegar';
}

function preview(lines: string[]): string {
  const shown = lines.slice(0, 6).map(line => (line.length > 100 ? `${line.slice(0, 100)}…` : line));
  const rest = lines.length - shown.length;
  if (rest > 0) shown.push(`… y ${rest} ${rest === 1 ? 'línea más' : 'líneas más'}`);
  return shown.join('\n');
}

export function deactivate(): void {
  // La desconexión se hace a través de ctx.subscriptions; las terminales siguen vivas.
}
