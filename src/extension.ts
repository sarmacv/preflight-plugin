import * as vscode from 'vscode';
import { PreflightPanel, promptSonarToken, SONAR_TOKEN_KEY } from './panel/panel';
import { probeModels } from './spike/probeModels';
import { readSettings } from './settings';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Preflight');
  const open = () => PreflightPanel.show(context, output);

  // VS Code requires an activity-bar icon to open a sidebar view. Preflight lives in an editor tab, so the
  // view is only a launcher: when it is shown, open the tab and close the sidebar again, so clicking the
  // icon goes straight to Preflight.
  const launch = () => {
    open();
    void vscode.commands.executeCommand('workbench.action.closeSidebar');
  };
  const launcher = vscode.window.createTreeView('preflight.launcher', {
    treeDataProvider: { getTreeItem: (e: vscode.TreeItem) => e, getChildren: () => [] },
  });

  context.subscriptions.push(
    output,
    launcher,
    launcher.onDidChangeVisibility((e) => e.visible && launch()),
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

  if (launcher.visible) launch();
}

export function deactivate(): void {}
