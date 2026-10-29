import type { HostMessage, WebviewMessage } from '../shared/protocol';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage: (m) => console.debug('post', m), getState: () => undefined, setState: () => {} };

export const post = (message: WebviewMessage): void => api.postMessage(message);

export function onHostMessage(handler: (m: HostMessage) => void): void {
  window.addEventListener('message', (e: MessageEvent<HostMessage>) => handler(e.data));
}

export interface PersistedState {
  selection: [string, string][];
  orgFilter: string;
  excluded: string[];
}

export const loadState = (): Partial<PersistedState> => (api.getState() as Partial<PersistedState>) ?? {};
export const saveState = (s: PersistedState): void => api.setState(s);
