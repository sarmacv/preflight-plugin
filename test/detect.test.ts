import { describe, expect, it } from 'vitest';
import { classify, pickModels, type ModelInfo } from '../src/ai/detect';

const m = (id: string, family = id, maxInputTokens = 128000): ModelInfo => ({
  id, family, vendor: 'copilot', name: id, version: '1', maxInputTokens,
});

describe('classify', () => {
  it('maps Claude, Codex and everything else to Copilot', () => {
    expect(classify(m('claude-sonnet-4.5'))).toBe('claude');
    expect(classify(m('gpt-5-codex'))).toBe('codex');
    expect(classify(m('gpt-4.1'))).toBe('copilot');
    expect(classify(m('x', 'Claude-Opus'))).toBe('claude');
  });
});

describe('pickModels', () => {
  it('picks one model per provider and leaves missing providers undefined', () => {
    const picked = pickModels([m('gpt-4o'), m('gpt-5'), m('claude-sonnet-4', 'claude-sonnet-4', 200000)]);
    expect(picked.copilot?.id).toBe('gpt-5');
    expect(picked.claude?.id).toBe('claude-sonnet-4');
    expect(picked.codex).toBeUndefined();
  });

  it('prefers the auto router for Copilot', () => {
    expect(pickModels([m('gpt-5'), m('copilot-auto', 'auto')]).copilot?.id).toBe('copilot-auto');
  });

  it('prefers the larger context window within a family', () => {
    const picked = pickModels([m('claude-a', 'claude', 100000), m('claude-b', 'claude', 200000)]);
    expect(picked.claude?.id).toBe('claude-b');
  });
});

describe('rankModels', () => {
  it('orders every model of a provider best first, for fallback', async () => {
    const { rankModels } = await import('../src/ai/detect');
    const ranked = rankModels([m('gpt-4.1'), m('gpt-5.6-luna', 'gpt-5.6-luna', 400000), m('gpt-5-mini'), m('claude-x')], 'copilot');
    expect(ranked.map((x) => x.id)).toEqual(['gpt-5.6-luna', 'gpt-5-mini', 'gpt-4.1']);
  });

  it('recognises models that extensions may not call', async () => {
    const { isModelUnavailable } = await import('../src/ai/detect');
    expect(isModelUnavailable(undefined, 'Model gpt-5.6-luna is only available to VS Code core.')).toBe(true);
    expect(isModelUnavailable('NoPermissions', 'x')).toBe(true);
    expect(isModelUnavailable(undefined, 'Request timed out')).toBe(false);
  });
});
