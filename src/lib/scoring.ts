import type { XUser, ScoreResult } from '@/types';

export function computeLocalScore(user: XUser | null | undefined): ScoreResult {
  if (!user || typeof user !== 'object') {
    return { score: 5, reasons: ['invalid user data'], source: 'local' };
  }

  const bio = (user.description || '').toLowerCase();
  const followers = user.public_metrics?.followers_count ?? 0;
  const following = user.public_metrics?.following_count ?? 0;
  const tweets = user.public_metrics?.tweet_count ?? 0;
  const createdAt = user.created_at ? new Date(user.created_at) : null;
  const ageYears = createdAt
    ? (Date.now() - createdAt.getTime()) / (1000 * 3600 * 24 * 365)
    : 0;

  let score = 62;
  const reasons: string[] = [];

  // Strong negative signals
  if (tweets === 0) {
    score -= 38;
    reasons.push('zero tweets — completely inactive');
  } else if (tweets < 30 && ageYears > 4) {
    score -= 22;
    reasons.push('very low activity for account age');
  }

  if (followers < 40 && following > 900) {
    score -= 28;
    reasons.push('low followers + follows hundreds/thousands (likely f4f/spam)');
  }
  if (followers < 15) {
    score -= 14;
    reasons.push('extremely low follower count');
  }
  if (following > followers * 4 && followers < 600) {
    score -= 16;
    reasons.push('heavily one-sided following ratio');
  }

  const spamSignals = [
    'crypto', 'web3', 'nft', 'onlyfans', 'dm for', 'link in bio',
    'i follow back', 'mutual', 'follow for follow', 'gain followers', 'promo', 'giveaway',
  ];
  const matchedSpam = spamSignals.filter(s => bio.includes(s));
  if (matchedSpam.length) {
    score -= Math.min(32, 9 * matchedSpam.length);
    reasons.push('bio contains low-signal keywords: ' + matchedSpam.slice(0, 2).join(', '));
  }

  if (bio.includes('entrepreneur') && followers < 200 && !user.verified) {
    score -= 12;
    reasons.push('generic "entrepreneur" with low engagement');
  }

  // Positive signals
  if (user.verified) {
    score += 9;
    reasons.push('verified account');
  }
  if (bio.includes('designer') || bio.includes('design') || bio.includes('typography') || bio.includes('craft')) {
    score += 14;
    reasons.push('design/craft focus');
  }
  if (bio.includes('engineer') || bio.includes('building') || bio.includes('founder') || bio.includes('shipping')) {
    score += 11;
    reasons.push('engineering / shipping signal');
  }
  if (bio.includes('ai') || bio.includes('ml') || bio.includes('research')) {
    score += 8;
  }
  if (tweets > 800) {
    score += 7;
    reasons.push('high activity');
  }
  if (followers > 8000) {
    score += 6;
  }
  if (ageYears > 8 && tweets > 300) {
    score += 5;
    reasons.push('long-time thoughtful account');
  }

  return {
    score: Math.max(5, Math.min(100, Math.round(score))),
    reasons: reasons.length ? reasons : ['neutral account'],
    source: 'local',
  };
}
