import type { XUser } from '@/types';

interface StoredState {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  me?: XUser;
  xaiApiKey?: string;
}

export async function loadStorage(): Promise<StoredState> {
  return chrome.storage.local.get([
    'accessToken', 'refreshToken', 'expiresAt', 'clientId', 'me', 'xaiApiKey',
  ]) as Promise<StoredState>;
}

export async function saveStorage(partial: Partial<StoredState>): Promise<void> {
  await chrome.storage.local.set(partial);
}

export async function clearStorage(): Promise<void> {
  await chrome.storage.local.clear();
}
