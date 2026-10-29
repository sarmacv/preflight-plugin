import type { ProviderId } from '../../shared/protocol';

export const PROVIDER_META: Record<ProviderId, { label: string; icon: string }> = {
  copilot: { label: 'Copilot', icon: 'copilot' },
  claude: { label: 'Claude', icon: 'claude' },
  codex: { label: 'Codex', icon: 'openai' },
};

export const ALL_PROVIDERS: ProviderId[] = ['copilot', 'claude', 'codex'];
