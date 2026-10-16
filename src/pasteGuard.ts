// Aviso antes de soltar en el shell un texto que se ejecutaría solo.

import * as vscode from 'vscode';

/**
 * Un texto de varias líneas se ejecuta solo al pegarlo, porque cada salto de
 * línea hace de Enter. Lo que hay en el portapapeles puede venir de una página
 * web que muestre un comando y copie otro, así que se enseña antes de soltarlo
 * en el shell. Es el mismo aviso que da la terminal de VS Code.
 */
export async function confirmPaste(text: string): Promise<boolean> {
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
