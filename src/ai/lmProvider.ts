import * as vscode from 'vscode';
import type { Skill } from '../skills/types';
import { isModelUnavailable, type ProviderId } from './detect';
import { modelCandidates } from './providers';
import { evaluationPrompt, fixPrompt, parseEvaluation, parseFix } from './prompts';
import { AiError, type Evaluation, type EvaluationContext, type FixProposal, type ModelProvider } from './provider';

const LABELS: Record<ProviderId, string> = { copilot: 'Copilot', claude: 'Claude', codex: 'Codex' };
const JUSTIFICATION = 'Preflight evaluates repository checks and drafts fixes you review before any PR is opened.';

/**
 * Drives a Copilot-served model (default, Claude or Codex family) through the VS Code Language Model API.
 * Copilot lists some models extensions aren't allowed to call, so it falls back to the next model in the
 * family and remembers the one that works for the rest of the scan.
 */
export class LmProvider implements ModelProvider {
  private index = 0;
  private readonly rejected: string[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly models: vscode.LanguageModelChat[],
    private readonly log: (msg: string) => void = () => {},
  ) {}

  private get model(): vscode.LanguageModelChat | undefined {
    return this.models[this.index];
  }

  get label(): string {
    return this.model ? `${LABELS[this.id]} (${this.model.name})` : LABELS[this.id];
  }

  /** Roughly 3 characters per token, keeping a quarter of the window for the prompt frame and reply. */
  private charBudget(model: vscode.LanguageModelChat): number {
    return Math.max(20_000, Math.floor(model.maxInputTokens * 3 * 0.75));
  }

  async evaluate(skill: Skill, ctx: EvaluationContext, signal?: AbortSignal): Promise<Evaluation> {
    return this.askAndParse((m) => evaluationPrompt(skill, ctx, this.charBudget(m)), parseEvaluation, 'AI review', signal);
  }

  async generateFix(skill: Skill, ctx: EvaluationContext, signal?: AbortSignal): Promise<FixProposal> {
    return this.askAndParse((m) => fixPrompt(skill, ctx, this.charBudget(m)), parseFix, 'AI fix', signal);
  }

  /** Asks, and if the reply can't be parsed asks once more saying what was wrong, before giving up. */
  private async askAndParse<T>(prompt: (m: vscode.LanguageModelChat) => string, parser: (text: string) => T, what: string, signal?: AbortSignal): Promise<T> {
    let problem = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      let reply: string;
      try {
        reply = await this.ask(
          (m) =>
            attempt === 1
              ? prompt(m)
              : `${prompt(m)}\n\nYour previous answer could not be used (${problem}). Answer again, following the required format exactly.`,
          signal,
        );
      } catch (err) {
        // A failed request (network, rate limit) is retried once; "no usable model" and cancellation are not.
        const noModel = err instanceof AiError && /isn't available/.test(err.message);
        if (signal?.aborted || noModel || attempt === 2) throw err;
        problem = (err as Error).message;
        this.log(`${this.label}: request failed on attempt ${attempt} (${problem}); retrying`);
        continue;
      }
      try {
        return parser(reply);
      } catch (err) {
        problem = (err as Error).message;
        this.log(`${this.label}: unusable reply on attempt ${attempt} (${problem}): ${reply.slice(0, 500)}`);
      }
    }
    throw new AiError(`The ${what} returned an unusable answer twice`, problem);
  }

  private async ask(prompt: (model: vscode.LanguageModelChat) => string, signal?: AbortSignal): Promise<string> {
    while (this.model) {
      const model = this.model;
      try {
        return await this.send(model, prompt(model), signal);
      } catch (err) {
        const code = err instanceof vscode.LanguageModelError ? err.code : undefined;
        const message = (err as Error).message ?? String(err);
        if (signal?.aborted) throw err;
        if (!isModelUnavailable(code, message)) {
          this.log(`${this.label} request failed: ${message}`);
          throw new AiError('The AI request failed', message);
        }
        // Checks run in parallel; only the first to hit a refusal moves on, so a good model isn't skipped.
        if (this.model === model) {
          this.log(`Model ${model.id} can't be used by extensions (${message}); trying the next ${LABELS[this.id]} model`);
          this.rejected.push(model.name);
          this.index++;
        }
      }
    }
    this.log(`No usable ${LABELS[this.id]} model (tried ${this.rejected.join(', ') || 'none'})`);
    throw new AiError("AI review isn't available right now.", `tried ${this.rejected.join(', ')}`);
  }

  private async send(model: vscode.LanguageModelChat, prompt: string, signal?: AbortSignal): Promise<string> {
    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], { justification: JUSTIFICATION }, cts.token);
      let text = '';
      for await (const chunk of res.text) text += chunk;
      return text;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  }
}

export async function createProvider(id: ProviderId, log?: (msg: string) => void): Promise<LmProvider | undefined> {
  const models = await modelCandidates(id);
  return models.length ? new LmProvider(id, models, log) : undefined;
}
