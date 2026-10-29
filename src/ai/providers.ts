import * as vscode from 'vscode';
import { pickModels, PROVIDERS, rankModels, type ModelInfo, type ProviderId } from './detect';

export function toInfo(m: vscode.LanguageModelChat): ModelInfo {
  return { id: m.id, vendor: m.vendor, family: m.family, name: m.name, version: m.version, maxInputTokens: m.maxInputTokens };
}

/** Providers that currently have a Copilot-served model behind them. */
export async function availableProviders(): Promise<ProviderId[]> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  const picked = pickModels(models.map(toInfo));
  return PROVIDERS.filter((p) => picked[p] !== undefined);
}

/** The provider's models, best first. */
export async function modelCandidates(provider: ProviderId): Promise<vscode.LanguageModelChat[]> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  const byId = new Map(models.map((m) => [m.id, m]));
  return rankModels(models.map(toInfo), provider).map((m) => byId.get(m.id)!);
}
