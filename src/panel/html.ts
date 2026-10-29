import * as vscode from 'vscode';

export function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p));
  const n = nonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https://avatars.githubusercontent.com data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${n}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('dist', 'webview', 'codicon.css')}">
<link rel="stylesheet" href="${asset('dist', 'webview', 'main.css')}">
<title>Preflight</title>
</head>
<body>
<div id="app" data-logo="${asset('media', 'logo.svg')}"></div>
<script nonce="${n}" src="${asset('dist', 'webview', 'main.js')}"></script>
</body>
</html>`;
}
