// Spike: prove which providers can be driven from inside the extension via vscode.lm.
import * as vscode from 'vscode';
import { classify, pickModels, PROVIDERS, type ProviderId } from '../ai/detect';
import { toInfo } from '../ai/providers';

interface ProbeResult {
  provider: ProviderId;
  model?: string;
  ok: boolean;
  latencyMs?: number;
  reply?: string;
  error?: string;
}

const PROMPT = 'Reply with exactly the word PREFLIGHT_OK and nothing else.';

async function probe(model: vscode.LanguageModelChat, token: vscode.CancellationToken): Promise<Omit<ProbeResult, 'provider'>> {
  const started = Date.now();
  try {
    const res = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(PROMPT)],
      { justification: 'Preflight checks which AI providers are available for repo scans.' },
      token,
    );
    let text = '';
    for await (const chunk of res.text) text += chunk;
    return { model: model.id, ok: text.includes('PREFLIGHT_OK'), latencyMs: Date.now() - started, reply: text.trim().slice(0, 80) };
  } catch (err) {
    const e = err as Error & { code?: string };
    return { model: model.id, ok: false, latencyMs: Date.now() - started, error: e.code ? `${e.code}: ${e.message}` : e.message };
  }
}

export async function probeModels(output: vscode.OutputChannel): Promise<void> {
  output.clear();
  output.show(true);

  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Preflight: probing models', cancellable: true },
    async (_progress, token) => {
      const all = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      output.appendLine(`vscode.lm copilot models (${all.length}):`);
      for (const m of all) {
        output.appendLine(`  ${classify(toInfo(m)).padEnd(7)} ${m.id}  family=${m.family}  max=${m.maxInputTokens}`);
      }

      const byId = new Map(all.map((m) => [m.id, m]));
      const picked = pickModels(all.map(toInfo));
      const out: ProbeResult[] = [];
      for (const provider of PROVIDERS) {
        const info = picked[provider];
        if (!info) {
          out.push({ provider, ok: false, error: 'No model of this family is offered by Copilot for this account.' });
          continue;
        }
        out.push({ provider, ...(await probe(byId.get(info.id)!, token)) });
      }
      return out;
    },
  );

  output.appendLine('');
  output.appendLine('Probe results:');
  for (const r of results) {
    const status = r.ok ? 'OK  ' : 'FAIL';
    output.appendLine(`  ${status} ${r.provider.padEnd(7)} ${r.model ?? '-'}  ${r.latencyMs ?? '-'}ms  ${r.error ?? r.reply ?? ''}`);
  }

  const report = JSON.stringify({ vscode: vscode.version, results }, null, 2);
  const summary = results.map((r) => `${r.provider} ${r.ok ? '✓' : '✗'}`).join('  ');
  const choice = await vscode.window.showInformationMessage(`Preflight probe: ${summary}`, 'Copy report');
  if (choice === 'Copy report') await vscode.env.clipboard.writeText(report);
}
