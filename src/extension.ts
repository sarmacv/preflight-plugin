import * as vscode from 'vscode';
import { PreflightPanel, promptSonarToken, SONAR_TOKEN_KEY } from './panel/panel';
import { probeModels } from './spike/probeModels';
import { readSettings } from './settings';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Preflight');
  const open = () => PreflightPanel.show(context, output);

  // The activity-bar view is only a launcher: showing it opens the editor-tab panel.
  const launcher = vscode.window.createTreeView('preflight.launcher', {
    treeDataProvider: { getTreeItem: (e: vscode.TreeItem) => e, getChildren: () => [] },
  });

  context.subscriptions.push(
    output,
    launcher,
    launcher.onDidChangeVisibility((e) => e.visible && open()),
    vscode.commands.registerCommand('preflight.open', open),
    vscode.commands.registerCommand('preflight.probeModels', () => probeModels(output)),
    vscode.commands.registerCommand('preflight.setSonarToken', async () => {
      const url = readSettings().sonarUrl;
      if (!url) {
        const choice = await vscode.window.showWarningMessage('Set preflight.sonar.url first.', 'Open Settings');
        if (choice) await vscode.commands.executeCommand('workbench.action.openSettings', 'preflight.sonar.url');
        return;
      }
      if (await promptSonarToken(context, url)) void vscode.window.showInformationMessage('Preflight: Sonar token saved.');
    }),
    vscode.commands.registerCommand('preflight.clearSonarToken', async () => {
      await context.secrets.delete(SONAR_TOKEN_KEY);
      void vscode.window.showInformationMessage('Preflight: Sonar token removed.');
    }),
  );

  if (launcher.visible) open();
}

export function deactivate(): void {}
