/**
 * tests/test-scoring.js
 *
 * Unit tests for the local scoring logic.
 * Run with:  node tests/test-scoring.js
 *
 * These tests also serve as an audit of the abuse-prevention characteristics
 * of the heuristic (i.e. does it reliably down-score obvious spam?).
 */

const computeLocalScore = require('../lib/scoring.js');

function assert(condition, message) {
  if (!condition) {
    console.error('❌ FAIL:', message);
    process.exitCode = 1;
  } else {
    console.log('✅', message);
  }
}

function makeUser(overrides = {}) {
  return {
    id: '123',
    name: 'Test User',
    username: 'testuser',
    description: '',
    verified: false,
    created_at: '2020-01-01T00:00:00.000Z',
    public_metrics: {
      followers_count: 120,
      following_count: 180,
      tweet_count: 340,
      listed_count: 2
    },
    ...overrides
  };
}

console.log('\n=== Local Scoring Tests ===\n');

// === Spam / Low-value patterns (should score low) ===
const spam1 = makeUser({
  username: 'crypto_king88',
  description: 'Crypto gains | DM for promo | Follow for follow | link in bio',
  public_metrics: { followers_count: 23, following_count: 4200, tweet_count: 12 }
});
const r1 = computeLocalScore(spam1);
assert(r1.score < 35, 'Crypto spam with f4f language scores very low');
assert(r1.reasons.some(r => r.includes('low-signal keywords')), 'Mentions spam keywords in reasons');

const spam2 = makeUser({
  username: 'onlyfans_leaks',
  description: '18+ onlyfans leaks daily 🔥 link in bio',
  public_metrics: { followers_count: 8, following_count: 1200, tweet_count: 0 }
});
const r2 = computeLocalScore(spam2);
assert(r2.score < 20, 'Zero-tweet + adult spam scores extremely low');

const f4f = makeUser({
  username: 'followtrain',
  description: 'I follow back everyone! Mutuals welcome',
  public_metrics: { followers_count: 19, following_count: 9800, tweet_count: 4 }
});
const r3 = computeLocalScore(f4f);
assert(r3.score < 30, 'Classic follow-train accounts are heavily penalized');

// === Good / high-value accounts (should score higher) ===
const goodDesigner = makeUser({
  username: 'jessicadesign',
  name: 'Jessica Chen',
  description: 'Product designer @Vercel. Typography nerd. Shipping design systems.',
  verified: true,
  public_metrics: { followers_count: 12400, following_count: 420, tweet_count: 2100 }
});
const r4 = computeLocalScore(goodDesigner);
assert(r4.score > 75, 'Active verified designer with relevant bio scores high');

const engineer = makeUser({
  username: 'shipitdaily',
  description: 'Engineer building AI tools. Previously @OpenAI. I post about craft and systems.',
  public_metrics: { followers_count: 3400, following_count: 180, tweet_count: 980 }
});
const r5 = computeLocalScore(engineer);
assert(r5.score > 68, 'Active engineer who ships scores well');

// === Edge cases ===
const zeroTweetsOld = makeUser({
  username: 'ghost2011',
  created_at: '2011-03-01T00:00:00.000Z',
  public_metrics: { followers_count: 1400, following_count: 90, tweet_count: 0 }
});
const r6 = computeLocalScore(zeroTweetsOld);
assert(r6.score < 40, 'Long-dead account with zero tweets is downranked');

const neutral = makeUser({
  username: 'normalperson42',
  description: 'I like coffee and hiking',
  public_metrics: { followers_count: 87, following_count: 210, tweet_count: 45 }
});
const r7 = computeLocalScore(neutral);
assert(r7.score >= 45 && r7.score <= 70, 'Completely neutral accounts land in the middle band');

// === Invariant / safety checks ===
assert(typeof computeLocalScore({}) === 'object', 'Always returns an object');
assert(computeLocalScore(null).score <= 40, 'Null input is treated conservatively');
assert(computeLocalScore({ description: 'something' }).score >= 5, 'Never goes below floor of 5');

console.log('\n=== All tests completed ===\n');
if (process.exitCode) {
  console.error('Some tests failed.');
  process.exit(1);
} else {
  console.log('All tests passed.');
}
