export interface XUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
  verified?: boolean;
  description?: string;
  created_at?: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
    listed_count: number;
  };
}

export interface ScoreResult {
  score: number;
  reasons: string[];
  source: 'local' | 'grok';
}

export interface RateInfo {
  remaining: number | null;
  reset: number | null;
}

export interface AppState {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  clientId: string | null;
  me: XUser | null;
  xaiApiKey: string | null;
  following: XUser[];
  filtered: XUser[];
  selectedIds: Set<string>;
  scores: Record<string, ScoreResult>;
  rateInfo: RateInfo;
  dryRun: boolean;
  isProcessing: boolean;
  isPaused: boolean;
  shouldAbort: boolean;
  analysisRunAt: number | null;
}
