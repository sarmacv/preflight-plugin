// Classifies Copilot-served language models into the three Preflight providers.
// Kept free of the vscode import so it can be unit tested.

export type ProviderId = 'copilot' | 'claude' | 'codex';

export const PROVIDERS: readonly ProviderId[] = ['copilot', 'claude', 'codex'];

export interface ModelInfo {
  id: string;
  vendor: string;
  family: string;
  name: string;
  version: string;
  maxInputTokens: number;
}

export function classify(model: ModelInfo): ProviderId {
  const key = `${model.family} ${model.id}`.toLowerCase();
  if (key.includes('claude')) return 'claude';
  if (key.includes('codex')) return 'codex';
  return 'copilot';
}

// Copilot's own default: prefer an "auto" router, then the GPT line, then anything.
const COPILOT_PREFERENCE = [/auto/i, /gpt-5/i, /gpt-4\.1/i, /gpt/i];

function rank(model: ModelInfo, provider: ProviderId): number {
  if (provider !== 'copilot') return 0;
  const hit = COPILOT_PREFERENCE.findIndex((re) => re.test(model.family) || re.test(model.id));
  return hit === -1 ? COPILOT_PREFERENCE.length : hit;
}

/**
 * Every model for a provider, best first. Copilot lists some models that only VS Code itself may
 * call, so callers fall back down this list when a model refuses an extension request.
 */
export function rankModels(models: readonly ModelInfo[], provider: ProviderId): ModelInfo[] {
  return models
    .filter((m) => classify(m) === provider)
    .sort((a, b) => rank(a, provider) - rank(b, provider) || b.maxInputTokens - a.maxInputTokens || b.id.localeCompare(a.id));
}

export function pickModels(models: readonly ModelInfo[]): Record<ProviderId, ModelInfo | undefined> {
  return {
    copilot: rankModels(models, 'copilot')[0],
    claude: rankModels(models, 'claude')[0],
    codex: rankModels(models, 'codex')[0],
  };
}

/** Errors meaning "this model can't be used by an extension", as opposed to a bad request. */
export function isModelUnavailable(code: string | undefined, message: string): boolean {
  return code === 'NoPermissions' || code === 'NotFound' || /only available to|not available|not supported|model_not_supported|unsupported model|access denied/i.test(message);
}
