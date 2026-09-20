import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/** Canal "Muxentra" en la vista Output, para diagnosticar problemas. */
export function log(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Muxentra', { log: true });
  }
  return channel;
}
