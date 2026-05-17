import type { XUser, RateInfo, ScoreResult } from '@/types';
import { saveStorage } from './storage';

const API_BASE = 'https://api.x.com/2';
export const REQUIRED_SCOPES = 'users.read follows.read follows.write offline.access';

export const MIN_UNFOLLOW_DELAY_MS = 18_000;
export const MAX_UNFOLLOWS_PER_SESSION = 180;
export const LARGE_ACTION_THRESHOLD = 30;

// --------------- Token state (module-level, shared within the tab) ---------------

export interface TokenState {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  clientId: string | null;
}

let tokens: TokenState = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
  clientId: null,
};

export function setTokens(t: Partial<TokenState>) {
  Object.assign(tokens, t);
}

export function getTokens(): TokenState {
  return { ...tokens };
}

// --------------- OAuth PKCE ---------------

function generateCodeVerifier(): string {
  const array = new Uint8Array(48);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function getRedirectUri(): string {
  return chrome.identity.getRedirectURL('x-unfollow-oauth');
}

export async function launchOAuth(clientId: string): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const redirectUri = getRedirectUri();
  const stateParam = crypto.randomUUID();

  await chrome.storage.session.set({ pkceVerifier: verifier, pkceState: stateParam });

  const authUrl = new URL('https://api.x.com/2/oauth2/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', REQUIRED_SCOPES);
  authUrl.searchParams.set('state', stateParam);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const redirectUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  const url = new URL(redirectUrl!);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  if (!code) throw new Error('No authorization code returned');
  if (returnedState !== stateParam) throw new Error('State mismatch — possible CSRF');

  await exchangeCodeForToken(code, verifier, clientId);
}

async function exchangeCodeForToken(code: string, verifier: string, clientId: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
    client_id: clientId,
    code_verifier: verifier,
  });

  const resp = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Token exchange failed: ${resp.status} ${txt}`);
  }

  const json = await resp.json();
  const expiresAt = Date.now() + json.expires_in * 1000 - 30_000;

  setTokens({ accessToken: json.access_token, refreshToken: json.refresh_token ?? null, expiresAt, clientId });
  await saveStorage({ accessToken: json.access_token, refreshToken: json.refresh_token ?? null, expiresAt, clientId });
}

// --------------- Token refresh ---------------

async function refreshIfNeeded(): Promise<void> {
  if (!tokens.refreshToken || !tokens.expiresAt || Date.now() < tokens.expiresAt) return;
  if (!tokens.clientId) throw new Error('Missing Client ID for token refresh');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId,
  });

  const resp = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    await chrome.storage.local.remove(['accessToken', 'refreshToken', 'expiresAt']);
    throw new Error('Session expired. Please reconnect.');
  }

  const json = await resp.json();
  const expiresAt = Date.now() + json.expires_in * 1000 - 30_000;
  const newTokens = {
    accessToken: json.access_token as string,
    refreshToken: (json.refresh_token as string | undefined) ?? tokens.refreshToken!,
    expiresAt,
  };

  setTokens(newTokens);
  await saveStorage(newTokens);
}

// --------------- Core request ---------------

export type RateInfoCallback = (info: RateInfo) => void;

export async function apiRequest(
  path: string,
  opts: RequestInit = {},
  onRateInfo?: RateInfoCallback,
  _retryCount = 0,
): Promise<Response> {
  await refreshIfNeeded();
  if (!tokens.accessToken) throw new Error('Not authenticated');

  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const resp = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  });

  const remaining = resp.headers.get('x-rate-limit-remaining');
  const reset = resp.headers.get('x-rate-limit-reset');
  if (remaining !== null && onRateInfo) {
    onRateInfo({
      remaining: parseInt(remaining, 10),
      reset: reset ? parseInt(reset, 10) : null,
    });
  }

  if (resp.status === 429) {
    if (_retryCount >= 2) throw new Error('Rate limited repeatedly. Wait a few minutes.');
    const resetMs = reset ? parseInt(reset, 10) * 1000 : 0;
    const waitMs = Math.max(0, resetMs - Date.now() + 1500) || 60_000;
    await sleep(waitMs);
    return apiRequest(path, opts, onRateInfo, _retryCount + 1);
  }

  if (resp.status === 401) {
    await chrome.storage.local.remove(['accessToken', 'refreshToken']);
    throw new Error('Authentication expired. Please reconnect in Settings.');
  }

  if (!resp.ok) {
    const problem = await resp.json().catch(() => ({})) as Record<string, string>;
    throw new Error(problem.detail ?? problem.title ?? `HTTP ${resp.status}`);
  }

  return resp;
}

// --------------- API methods ---------------

export async function fetchMe(onRateInfo?: RateInfoCallback): Promise<XUser> {
  const resp = await apiRequest(
    '/users/me?user.fields=id,username,name,profile_image_url,verified',
    {},
    onRateInfo,
  );
  const json = await resp.json() as { data: XUser };
  await saveStorage({ me: json.data });
  return json.data;
}

export async function fetchFollowingPage(
  userId: string,
  paginationToken: string | null,
  onRateInfo?: RateInfoCallback,
): Promise<{ data: XUser[]; meta?: { next_token?: string } }> {
  let path =
    `/users/${userId}/following?max_results=1000` +
    `&user.fields=id,username,name,profile_image_url,verified,description,public_metrics,created_at`;
  if (paginationToken) path += `&pagination_token=${encodeURIComponent(paginationToken)}`;
  const resp = await apiRequest(path, {}, onRateInfo);
  return resp.json();
}

export async function unfollowUser(
  sourceId: string,
  targetId: string,
  dryRun: boolean,
  onRateInfo?: RateInfoCallback,
): Promise<void> {
  if (dryRun) return;
  await apiRequest(`/users/${sourceId}/following/${targetId}`, { method: 'DELETE' }, onRateInfo);
}

// --------------- Grok analysis ---------------

export async function analyzeWithGrok(
  accounts: XUser[],
  xaiApiKey: string,
): Promise<Record<string, ScoreResult>> {
  const simplified = accounts.map(u => ({
    id: u.id,
    name: u.name,
    username: u.username,
    bio: (u.description ?? '').slice(0, 180),
    followers: u.public_metrics?.followers_count ?? 0,
    tweets: u.public_metrics?.tweet_count ?? 0,
    verified: !!u.verified,
  }));

  const system = `You are a feed quality curator helping a user decide which X accounts to keep following.
Score how valuable each account is to have in a feed focused on quality content.
Return a JSON array (nothing else) where each element has:
- id (string, must match exactly)
- score: integer 0-100 (higher = more worth keeping)
- reason: one short sentence
Active original content = high. Inactive/spammy/low-signal = low.`;

  const userMsg =
    `Score these ${simplified.length} accounts:\n\n` +
    simplified
      .map(a => `ID:${a.id} | @${a.username} (${a.name}) | ${a.followers} followers, ${a.tweets} posts | verified:${a.verified}\nBio: ${a.bio}`)
      .join('\n\n');

  const resp = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${xaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-3-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`xAI error: ${resp.status} ${err}`);
  }

  const data = await resp.json() as { choices: { message: { content: string } }[] };
  const text = data.choices?.[0]?.message?.content ?? '';

  let parsed: { id: string; score: number; reason: string }[];
  try {
    const match = text.match(/\[[\s\S]*\]/);
    parsed = match ? JSON.parse(match[0]) : [];
  } catch {
    throw new Error('Grok returned unparseable output. Try again.');
  }

  const results: Record<string, ScoreResult> = {};
  for (const item of parsed) {
    if (item?.id) {
      results[item.id] = {
        score: Math.max(0, Math.min(100, parseInt(String(item.score), 10) || 50)),
        reasons: [item.reason ?? 'Grok analysis'],
        source: 'grok',
      };
    }
  }
  return results;
}

// --------------- Utilities ---------------

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
