import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster, toast } from 'sonner';
import '../globals.css';

import {
  launchOAuth, fetchMe, fetchFollowingPage, unfollowUser as apiUnfollow,
  analyzeWithGrok, getRedirectUri, setTokens, sleep,
  MIN_UNFOLLOW_DELAY_MS, MAX_UNFOLLOWS_PER_SESSION, LARGE_ACTION_THRESHOLD,
} from '@/lib/api';
import { computeLocalScore } from '@/lib/scoring';
import { loadStorage, saveStorage, clearStorage } from '@/lib/storage';
import type { XUser, ScoreResult, RateInfo } from '@/types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Settings, RefreshCw, Search, Zap, ArrowUpDown, Bot, Download,
  Pause, Play, XCircle, Loader2, ChevronDown,
} from 'lucide-react';

// ─── Constants ────────────────────────────────────────────────────────────────
const RENDER_BATCH = 150;
const AI_WARNING = 'AI/local scores are suggestions only. You are fully responsible for every unfollow.';

// ─── ScoreBadge ───────────────────────────────────────────────────────────────
function ScoreBadge({ score, source, reasons }: ScoreResult) {
  const color =
    score < 35 ? 'danger' :
    score < 62 ? 'warning' :
    'success';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={color as 'danger' | 'warning' | 'success'} className="cursor-help tabular-nums">
          {score}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[220px]">
        <p className="font-medium mb-1">{source === 'grok' ? 'Grok' : 'Local'} score: {score}/100</p>
        <ul className="space-y-0.5">
          {reasons.map((r, i) => <li key={i} className="text-muted-foreground">· {r}</li>)}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

// ─── OnboardingCard ───────────────────────────────────────────────────────────
function OnboardingCard({ onOpenSettings }: { onOpenSettings: () => void }) {
  const uri = getRedirectUri();
  const copyUri = () => {
    navigator.clipboard.writeText(uri).then(() => toast.success('Redirect URI copied'));
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 mb-4">
      <h3 className="font-semibold mb-1">One-time setup required</h3>
      <p className="text-sm text-muted-foreground mb-3">
        This extension uses the official X API. Write access requires a paid X Developer account (Basic plan or above).
      </p>
      <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside mb-3">
        <li>
          Go to{' '}
          <a href="https://developer.x.com" target="_blank" rel="noreferrer" className="text-primary underline">
            developer.x.com
          </a>{' '}
          — create a Project + App
        </li>
        <li>
          Enable <strong className="text-foreground">OAuth 2.0</strong> with scopes:{' '}
          {['users.read', 'follows.read', 'follows.write', 'offline.access'].map(s => (
            <code key={s} className="mx-0.5 rounded bg-secondary px-1 py-0.5 text-xs">{s}</code>
          ))}
        </li>
        <li>Add this Callback URL to your app:</li>
      </ol>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 mb-3">
        <code className="flex-1 text-xs text-muted-foreground break-all">{uri}</code>
        <Button variant="secondary" size="sm" onClick={copyUri}>Copy</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Then click{' '}
        <button onClick={onOpenSettings} className="text-foreground font-medium underline underline-offset-2">
          ⚙ Settings
        </button>{' '}
        → paste your Client ID → <strong className="text-foreground">Connect with X</strong>.
      </p>
    </div>
  );
}

// ─── LogLine ──────────────────────────────────────────────────────────────────
interface LogEntry { ts: string; msg: string; type: 'info' | 'success' | 'error' | 'warning' }

function LogLine({ entry }: { entry: LogEntry }) {
  const color =
    entry.type === 'success' ? 'text-green-400' :
    entry.type === 'error'   ? 'text-red-400' :
    entry.type === 'warning' ? 'text-yellow-400' :
    'text-muted-foreground';
  return (
    <div className={`text-xs py-0.5 font-mono ${color}`}>
      [{entry.ts}] {entry.msg}
    </div>
  );
}

// ─── SettingsDialog ───────────────────────────────────────────────────────────
interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  clientId: string;
  xaiApiKey: string;
  onSave: (clientId: string, xaiApiKey: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
}

function SettingsDialog({ open, onClose, clientId, xaiApiKey, onSave, onDisconnect }: SettingsDialogProps) {
  const [id, setId] = useState(clientId);
  const [key, setKey] = useState(xaiApiKey);
  const uri = getRedirectUri();

  const handleSave = async () => {
    await onSave(id.trim(), key.trim());
    onClose();
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect from X and clear all stored data?')) return;
    await onDisconnect();
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Settings &amp; Connection</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Client ID */}
          <div className="space-y-1.5">
            <Label>X App Client ID</Label>
            <Input
              value={id}
              onChange={e => setId(e.target.value)}
              placeholder="Paste Client ID from developer.x.com"
            />
          </div>

          {/* xAI Key */}
          <div className="space-y-1.5 rounded-lg border border-border bg-background p-3">
            <Label>xAI API Key <span className="text-muted-foreground">(optional — for Grok scoring)</span></Label>
            <Input
              type="password"
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder="xai-… (stored only in this browser)"
              className="font-mono"
            />
            <p className="text-[11px] text-muted-foreground">
              Enables "Analyze with Grok" for smarter suggestions. Your key never leaves this extension.
            </p>
          </div>

          {/* Redirect URI */}
          <div className="space-y-1.5">
            <Label>OAuth Redirect URI</Label>
            <p className="text-[11px] text-muted-foreground">
              Copy this into your X App → User authentication settings → OAuth 2.0 → Callback URLs
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-[11px] text-muted-foreground break-all">
                {uri}
              </code>
              <Button
                variant="secondary" size="sm"
                onClick={() => navigator.clipboard.writeText(uri).then(() => toast.success('Copied'))}
              >
                Copy
              </Button>
            </div>
          </div>

          {/* Warning */}
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-red-300">
            <strong>Required:</strong> Create a Project + App at{' '}
            <a href="https://developer.x.com" target="_blank" rel="noreferrer" className="underline">developer.x.com</a>{' '}
            and enable OAuth 2.0 with scopes{' '}
            <code className="text-xs">users.read follows.read follows.write offline.access</code>.
            Write endpoints require a paid plan.
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={handleDisconnect}>Disconnect</Button>
          <Button onClick={handleSave}>Save &amp; Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── ConfirmDialog ────────────────────────────────────────────────────────────
interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  timeEstimate?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({ open, title, description, timeEstimate, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={v => !v && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm text-muted-foreground">{description}</div>
          </DialogDescription>
        </DialogHeader>

        {timeEstimate && (
          <p className="text-xs text-yellow-400 -mt-2 mb-1">{timeEstimate}</p>
        )}

        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-red-300">
          This uses the official X API. X may apply additional limits for rapid unfollow behavior. Use responsibly.
        </div>

        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Manager (main) ───────────────────────────────────────────────────────────
function Manager() {
  // Auth & settings
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [xaiApiKey, setXaiApiKey] = useState('');
  const [me, setMe] = useState<XUser | null>(null);

  // Data
  const [following, setFollowing] = useState<XUser[]>([]);
  const [scores, setScores] = useState<Record<string, ScoreResult>>({});
  const [rateInfo, setRateInfo] = useState<RateInfo>({ remaining: null, reset: null });

  // UI
  const [filterMode, setFilterMode] = useState<'all' | 'verified' | 'non-verified'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dryRun, setDryRun] = useState(false);
  const [renderLimit, setRenderLimit] = useState(RENDER_BATCH);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [sortByScore, setSortByScore] = useState(false);

  // Processing
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, message: '' });
  const [procEta, setProcEta] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Dialogs
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean; title: string; description: React.ReactNode;
    timeEstimate?: string; onConfirm: () => void;
  }>({ open: false, title: '', description: '', onConfirm: () => {} });

  // Refs for async loop control
  const isPausedRef = useRef(false);
  const shouldAbortRef = useRef(false);
  const pauseResolverRef = useRef<(() => void) | null>(null);
  const [unfollowLock, setUnfollowLock] = useState(false);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // ── Init: load storage ─────────────────────────────────────────────────────
  useEffect(() => {
    loadStorage().then(data => {
      if (data.accessToken) {
        setAccessToken(data.accessToken);
        setTokens({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken ?? null,
          expiresAt: data.expiresAt ?? null,
          clientId: data.clientId ?? null,
        });
      }
      if (data.clientId) setClientId(data.clientId);
      if (data.xaiApiKey) setXaiApiKey(data.xaiApiKey);
      if (data.me) setMe(data.me);
    });
  }, []);

  // Reset render limit when filter changes
  useEffect(() => { setRenderLimit(RENDER_BATCH); }, [searchQuery, filterMode]);

  // ── Logging ────────────────────────────────────────────────────────────────
  const log = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [
      ...prev,
      { ts: new Date().toLocaleTimeString(), msg, type },
    ]);
  }, []);

  const onRateInfo = useCallback((info: RateInfo) => setRateInfo(info), []);

  // ── Connect ────────────────────────────────────────────────────────────────
  const connect = async () => {
    if (!clientId) { setSettingsOpen(true); return; }
    try {
      await launchOAuth(clientId);
      const user = await fetchMe(onRateInfo);
      setMe(user);
      setAccessToken('__set__'); // triggers UI update
      toast.success(`Connected as @${user.username}`);
    } catch (err) {
      toast.error('Connection failed: ' + (err as Error).message);
    }
  };

  // ── Load following ─────────────────────────────────────────────────────────
  const loadFollowing = async () => {
    if (!accessToken) { toast.warning('Connect with X first.'); return; }
    let currentMe = me;
    if (!currentMe) {
      try { currentMe = await fetchMe(onRateInfo); setMe(currentMe); }
      catch (err) { toast.error((err as Error).message); return; }
    }

    setLogs([]);
    log('Fetching your following list…');

    let all: XUser[] = [];
    let nextToken: string | null = null;
    let page = 0;

    try {
      do {
        page++;
        const pageData = await fetchFollowingPage(currentMe!.id, nextToken, onRateInfo);
        if (pageData.data) all = all.concat(pageData.data);
        nextToken = pageData.meta?.next_token ?? null;
        log(`Page ${page}: +${pageData.data?.length ?? 0} accounts (total ${all.length})`);
      } while (nextToken);

      setFollowing(all);
      setSelectedIds(new Set());
      setScores({});
      setDataLoaded(true);
      setRenderLimit(RENDER_BATCH);
      log(`Done — ${all.length} accounts loaded.`, 'success');
      toast.success(`${all.length} accounts loaded`);
    } catch (err) {
      log('Error: ' + (err as Error).message, 'error');
      toast.error('Failed to load: ' + (err as Error).message);
    }
  };

  // ── Local analysis ─────────────────────────────────────────────────────────
  const runLocalAnalysis = useCallback(() => {
    if (!following.length) { toast.warning('Load your following list first.'); return; }
    const newScores: Record<string, ScoreResult> = {};
    let lowCount = 0;
    for (const user of following) {
      const result = computeLocalScore(user);
      newScores[user.id] = result;
      if (result.score < 42) lowCount++;
    }
    setScores(newScores);
    log(`Local analysis complete — ${lowCount} accounts scored below 42.`);
    if (lowCount > 8) log(`${lowCount} low-value accounts detected. Use "Worst first" to surface them.`, 'warning');
    log(AI_WARNING, 'warning');
    toast.success(`Analysis done — ${lowCount} low-value accounts found.`);
  }, [following, log]);

  // ── Smart sort ─────────────────────────────────────────────────────────────
  const sortedFollowing = useMemo(() => {
    if (!sortByScore || !Object.keys(scores).length) return following;
    return [...following].sort((a, b) => {
      const sa = scores[a.id]?.score ?? 50;
      const sb = scores[b.id]?.score ?? 50;
      return sa - sb;
    });
  }, [following, scores, sortByScore]);

  // Recalculate filtered from sorted list
  const filteredFromSorted = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return sortedFollowing.filter(u => {
      const matchesSearch = !q ||
        u.username?.toLowerCase().includes(q) ||
        u.name?.toLowerCase().includes(q) ||
        u.description?.toLowerCase().includes(q);
      const matchesFilter =
        filterMode === 'verified' ? !!u.verified :
        filterMode === 'non-verified' ? !u.verified :
        true;
      return matchesSearch && matchesFilter;
    });
  }, [sortedFollowing, searchQuery, filterMode]);

  const visibleFiltered = useMemo(
    () => filteredFromSorted.slice(0, renderLimit),
    [filteredFromSorted, renderLimit],
  );

  // ── Scroll-to-load-more ────────────────────────────────────────────────────
  useEffect(() => {
    const container = tableContainerRef.current;
    if (!container) return;
    const onScroll = () => {
      const { scrollTop, clientHeight, scrollHeight } = container;
      if (scrollTop + clientHeight >= scrollHeight - 300 && renderLimit < filteredFromSorted.length) {
        setRenderLimit(r => r + RENDER_BATCH);
      }
    };
    container.addEventListener('scroll', onScroll);
    return () => container.removeEventListener('scroll', onScroll);
  }, [filteredFromSorted.length, renderLimit]);

  // ── Grok analysis ──────────────────────────────────────────────────────────
  const [grokRunning, setGrokRunning] = useState(false);
  const [grokProgress, setGrokProgress] = useState('');

  const runGrok = async () => {
    if (!xaiApiKey) { toast.warning('Add your xAI API key in Settings first.'); setSettingsOpen(true); return; }
    if (!following.length) { toast.warning('Load your following list first.'); return; }
    setGrokRunning(true);
    const batchSize = 28;
    const totalBatches = Math.ceil(following.length / batchSize);
    let allScores: Record<string, ScoreResult> = { ...scores };
    try {
      for (let i = 0; i < following.length; i += batchSize) {
        const batchNum = Math.floor(i / batchSize) + 1;
        setGrokProgress(`${batchNum}/${totalBatches}`);
        const batch = following.slice(i, i + batchSize);
        const results = await analyzeWithGrok(batch, xaiApiKey);
        allScores = { ...allScores, ...results };
        log(`Grok batch ${batchNum}/${totalBatches}: ${Object.keys(results).length} accounts scored`);
        await sleep(650);
      }
      setScores(allScores);
      log(`Grok analysis complete — ${Object.keys(allScores).length} accounts scored.`, 'success');
      toast.success(`Grok scored ${following.length} accounts.`);
    } catch (err) {
      log('Grok error: ' + (err as Error).message, 'error');
      toast.error('Grok failed: ' + (err as Error).message);
    } finally {
      setGrokRunning(false);
      setGrokProgress('');
    }
  };

  // ── Single unfollow ────────────────────────────────────────────────────────
  const singleUnfollow = async (user: XUser) => {
    if (unfollowLock || isProcessing) {
      toast.warning('Please wait for the current operation to finish.');
      return;
    }

    setConfirmDialog({
      open: true,
      title: `Unfollow @${user.username}?`,
      description: (
        <>Unfollow <strong>{user.name}</strong> (@{user.username}).
          There is an ~18s cooldown afterward.</>
      ),
      onConfirm: async () => {
        setConfirmDialog(d => ({ ...d, open: false }));
        setUnfollowLock(true);
        try {
          await apiUnfollow(me!.id, user.id, dryRun, onRateInfo);
          setFollowing(prev => prev.filter(u => u.id !== user.id));
          setSelectedIds(prev => { const n = new Set(prev); n.delete(user.id); return n; });
          log(`Unfollowed @${user.username}`, 'success');
          toast.success(`Unfollowed @${user.username}`);
          await sleep(MIN_UNFOLLOW_DELAY_MS);
        } catch (err) {
          log(`Failed @${user.username}: ${(err as Error).message}`, 'error');
          toast.error(`Failed: ${(err as Error).message}`);
        } finally {
          setUnfollowLock(false);
        }
      },
    });
  };

  // ── Bulk unfollow ──────────────────────────────────────────────────────────
  const startBulkUnfollow = async (ids: string[]) => {
    const toDo = ids.slice(0, MAX_UNFOLLOWS_PER_SESSION);
    const capped = ids.length > MAX_UNFOLLOWS_PER_SESSION;
    const estSecs = toDo.length * (MIN_UNFOLLOW_DELAY_MS / 1000);
    const estMins = Math.round(estSecs / 60);
    const timeStr = estMins < 1 ? `~${estSecs}s` : `~${estMins} min`;

    setConfirmDialog({
      open: true,
      title: 'Confirm bulk unfollow',
      description: (
        <>
          You are about to unfollow <strong>{toDo.length}</strong> account{toDo.length !== 1 ? 's' : ''}.
          {capped && <span className="text-yellow-400"> (Capped at {MAX_UNFOLLOWS_PER_SESSION} for this session.)</span>}
        </>
      ),
      timeEstimate: `Estimated time: ${timeStr} · ${MIN_UNFOLLOW_DELAY_MS / 1000}s between each call.`,
      onConfirm: () => {
        setConfirmDialog(d => ({ ...d, open: false }));
        runBulkLoop(toDo);
      },
    });
  };

  const runBulkLoop = async (toDo: string[]) => {
    if (toDo.length >= LARGE_ACTION_THRESHOLD) {
      log(`Large action (${toDo.length} accounts). ${AI_WARNING}`, 'warning');
    }

    setIsProcessing(true);
    setIsPaused(false);
    isPausedRef.current = false;
    shouldAbortRef.current = false;
    setProgress({ current: 0, total: toDo.length, message: '' });

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < toDo.length; i++) {
      if (isPausedRef.current) {
        await new Promise<void>(r => { pauseResolverRef.current = r; });
      }
      if (shouldAbortRef.current) {
        log(`Aborted after ${i} unfollows (${successCount} succeeded).`, 'warning');
        break;
      }

      const id = toDo[i];
      const user = following.find(u => u.id === id);
      if (!user) continue;

      const etaSecs = (toDo.length - i) * (MIN_UNFOLLOW_DELAY_MS / 1000);
      const etaMins = Math.floor(etaSecs / 60);
      const etaRemSecs = etaSecs % 60;
      setProcEta(etaMins > 0 ? `~${etaMins}m ${etaRemSecs}s left` : `~${etaSecs}s left`);
      setProgress({ current: i, total: toDo.length, message: `Unfollowing ${i + 1} of ${toDo.length}…` });

      try {
        await apiUnfollow(me!.id, id, dryRun, onRateInfo);
        log(`✓ @${user.username} (${i + 1}/${toDo.length})`, 'success');
        successCount++;
      } catch (err) {
        log(`✗ @${user.username}: ${(err as Error).message}`, 'error');
        errorCount++;
      }

      if (i < toDo.length - 1) await sleep(MIN_UNFOLLOW_DELAY_MS);
    }

    setIsProcessing(false);
    setIsPaused(false);
    setProcEta('');
    setProgress({ current: toDo.length, total: toDo.length, message: `Done — ${successCount} unfollowed${errorCount ? `, ${errorCount} failed` : ''}` });

    setFollowing(prev => prev.filter(u => !toDo.includes(u.id)));
    setSelectedIds(new Set());
    toast.success(`Done: ${successCount} unfollowed${errorCount ? `, ${errorCount} errors` : ''}.`);
  };

  // ── Pause / Resume / Abort ─────────────────────────────────────────────────
  const pause = () => {
    isPausedRef.current = true;
    setIsPaused(true);
    log('Paused.', 'warning');
  };
  const resume = () => {
    isPausedRef.current = false;
    setIsPaused(false);
    log('Resumed.');
    pauseResolverRef.current?.();
    pauseResolverRef.current = null;
  };
  const abort = () => {
    shouldAbortRef.current = true;
    isPausedRef.current = false;
    setIsPaused(false);
    pauseResolverRef.current?.();
    pauseResolverRef.current = null;
    log('Aborting…', 'warning');
  };

  // ── Settings save ──────────────────────────────────────────────────────────
  const handleSaveSettings = async (newClientId: string, newXaiKey: string) => {
    const updates: Record<string, string | null> = {};
    if (newClientId) updates.clientId = newClientId;
    if (newXaiKey) updates.xaiApiKey = newXaiKey;
    else if (xaiApiKey) updates.xaiApiKey = null;
    await saveStorage(updates as Parameters<typeof saveStorage>[0]);
    if (newClientId) setClientId(newClientId);
    if (newXaiKey) setXaiApiKey(newXaiKey);
    else if (xaiApiKey) setXaiApiKey('');
    toast.success('Settings saved');
  };

  const handleDisconnect = async () => {
    await clearStorage();
    location.reload();
  };

  // ── Export CSV ─────────────────────────────────────────────────────────────
  const exportCsv = () => {
    const rows = ['name,username,verified,followers,score'].concat(
      filteredFromSorted.map(u => {
        const score = scores[u.id]?.score ?? '';
        return `"${(u.name ?? '').replace(/"/g, '""')}",${u.username},${u.verified ? 1 : 0},${u.public_metrics?.followers_count ?? 0},${score}`;
      }),
    );
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `x-following-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const allVisibleSelected = visibleFiltered.length > 0 && visibleFiltered.every(u => selectedIds.has(u.id));
  const someSelected = visibleFiltered.some(u => selectedIds.has(u.id));

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col min-h-screen bg-background">

        {/* ── Header ── */}
        <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-card/80 backdrop-blur px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 font-bold text-base">
              <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-primary bg-black text-[11px] font-black text-primary">X</div>
              Bulk Unfollow
            </div>
            {me && (
              <div className="flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1 text-sm">
                {me.profile_image_url && (
                  <img src={me.profile_image_url} alt="" className="h-6 w-6 rounded-full object-cover" />
                )}
                <span className="font-medium">{me.name}</span>
                <span className="text-muted-foreground">@{me.username}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="secondary" size="icon" title="Settings" onClick={() => setSettingsOpen(true)}>
              <Settings className="h-4 w-4" />
            </Button>
            <Button variant="secondary" size="sm" disabled={!dataLoaded} onClick={loadFollowing}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
            </Button>
            {!me ? (
              <Button size="sm" onClick={connect}>Connect with X</Button>
            ) : null}
          </div>
        </header>

        <main className="flex-1 max-w-6xl w-full mx-auto px-5 py-5 space-y-4">

          {/* ── Status card ── */}
          <div className="flex items-center justify-between rounded-xl border border-border bg-card px-5 py-4">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Accounts you follow</p>
              <p className="mt-1 text-4xl font-bold tabular-nums">
                {following.length ? following.length.toLocaleString() : '—'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {following.length ? `${following.length} accounts loaded` : 'Load your following list to begin'}
              </p>
            </div>
            <Button onClick={loadFollowing} disabled={!me}>
              {dataLoaded ? 'Refresh Following List' : 'Load Following List'}
            </Button>
          </div>

          {/* ── Onboarding ── */}
          {!me && !clientId && <OnboardingCard onOpenSettings={() => setSettingsOpen(true)} />}

          {/* ── Toolbar ── */}
          {dataLoaded && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  className="pl-8"
                  placeholder="Search name, @handle, or bio…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
              </div>

              {/* Filter tabs */}
              <div className="flex rounded-lg border border-border bg-secondary p-0.5 text-xs">
                {(['all', 'verified', 'non-verified'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setFilterMode(f)}
                    className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                      filterMode === f
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {f === 'all' ? 'All' : f === 'verified' ? 'Verified' : 'Non-verified'}
                  </button>
                ))}
              </div>

              <Button variant="secondary" size="sm" onClick={runLocalAnalysis} title="Run fast local heuristics">
                <Zap className="h-3.5 w-3.5 mr-1" /> Analyze
              </Button>
              <Button
                variant="secondary" size="sm"
                onClick={() => { setSortByScore(true); log('Sorted by score — worst match first.'); }}
                title="Sort by lowest score first"
              >
                <ArrowUpDown className="h-3.5 w-3.5 mr-1" /> Worst first
              </Button>
              <Button
                variant="secondary" size="sm"
                disabled={grokRunning}
                onClick={runGrok}
                style={{ borderColor: '#444' }}
                title="Use Grok for deeper scoring (requires xAI key)"
              >
                {grokRunning ? (
                  <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> {grokProgress}</>
                ) : (
                  <><Bot className="h-3.5 w-3.5 mr-1" /> Grok</>
                )}
              </Button>

              <Button variant="secondary" size="sm"
                onClick={() => setSelectedIds(new Set(filteredFromSorted.map(u => u.id)))}>
                Select All
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setSelectedIds(new Set())}>
                Clear
              </Button>

              <div className="ml-auto flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer text-xs text-yellow-400">
                  <Switch
                    checked={dryRun}
                    onCheckedChange={setDryRun}
                    className="scale-90"
                  />
                  Dry-run
                </label>
                <Button variant="secondary" size="sm" onClick={exportCsv} title="Export filtered list as CSV">
                  <Download className="h-3.5 w-3.5 mr-1" /> Export
                </Button>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {filteredFromSorted.length} / {following.length} shown
                </span>
              </div>
            </div>
          )}

          {/* ── Table ── */}
          {dataLoaded && (
            <div
              ref={tableContainerRef}
              className="rounded-xl border border-border bg-card overflow-hidden overflow-y-auto"
              style={{ maxHeight: 'calc(100vh - 300px)' }}
            >
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border bg-secondary/50">
                    <th className="sticky top-0 bg-card w-8 px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        ref={el => { if (el) el.indeterminate = someSelected && !allVisibleSelected; }}
                        onChange={e => {
                          const ids = visibleFiltered.map(u => u.id);
                          setSelectedIds(prev => {
                            const n = new Set(prev);
                            if (e.target.checked) ids.forEach(id => n.add(id));
                            else ids.forEach(id => n.delete(id));
                            return n;
                          });
                        }}
                        className="rounded border-border"
                      />
                    </th>
                    <th className="sticky top-0 bg-card w-10 px-2 py-2.5" />
                    <th className="sticky top-0 bg-card px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Name / Handle
                    </th>
                    <th className="sticky top-0 bg-card w-16 px-2 py-2.5 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground" title="Keep-worthiness score. Hover for details.">
                      Score
                    </th>
                    <th className="sticky top-0 bg-card w-24 px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Followers
                    </th>
                    <th className="sticky top-0 bg-card px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Bio
                    </th>
                    <th className="sticky top-0 bg-card w-24 px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleFiltered.map(user => (
                    <tr
                      key={user.id}
                      className="border-b border-border/50 hover:bg-secondary/30 transition-colors"
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(user.id)}
                          onChange={e => {
                            setSelectedIds(prev => {
                              const n = new Set(prev);
                              if (e.target.checked) n.add(user.id);
                              else n.delete(user.id);
                              return n;
                            });
                          }}
                          className="rounded border-border"
                        />
                      </td>
                      <td className="px-2 py-2">
                        {user.profile_image_url && (
                          <img
                            src={user.profile_image_url}
                            alt=""
                            className="h-8 w-8 rounded-full object-cover border border-border"
                            onError={e => { (e.target as HTMLImageElement).src = ''; }}
                          />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <span className="font-medium">{user.name}</span>
                          {user.verified && (
                            <Tooltip>
                              <TooltipTrigger>
                                <span className="text-blue-400 text-xs">✓</span>
                              </TooltipTrigger>
                              <TooltipContent>Verified account</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">@{user.username}</div>
                      </td>
                      <td className="px-2 py-2 text-center">
                        {scores[user.id] ? (
                          <ScoreBadge {...scores[user.id]} />
                        ) : (
                          <span className="text-xs text-muted-foreground/40">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground text-xs">
                        {(user.public_metrics?.followers_count ?? 0).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 max-w-[360px]">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p className="text-xs text-muted-foreground truncate max-w-[340px] cursor-default">
                              {user.description ?? ''}
                            </p>
                          </TooltipTrigger>
                          {user.description && (
                            <TooltipContent className="max-w-[300px] whitespace-normal">
                              {user.description}
                            </TooltipContent>
                          )}
                        </Tooltip>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          variant="secondary" size="sm"
                          disabled={isProcessing || unfollowLock}
                          onClick={() => singleUnfollow(user)}
                        >
                          Unfollow
                        </Button>
                      </td>
                    </tr>
                  ))}

                  {/* Load-more sentinel */}
                  {renderLimit < filteredFromSorted.length && (
                    <tr>
                      <td colSpan={7} className="py-4 text-center text-xs text-muted-foreground">
                        Showing {visibleFiltered.length} of {filteredFromSorted.length} —{' '}
                        <button
                          className="underline hover:text-foreground"
                          onClick={() => setRenderLimit(r => r + RENDER_BATCH)}
                        >
                          load more
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Empty state ── */}
          {!dataLoaded && (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <span className="text-5xl opacity-10 mb-4">👥</span>
              <h3 className="text-base font-medium text-foreground mb-1">No list loaded yet</h3>
              <p className="text-sm">Connect to X and load your following list.</p>
            </div>
          )}

          {/* ── Processor panel ── */}
          {(logs.length > 0 || isProcessing) && (
            <div className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Activity</span>
                <div className="flex items-center gap-2">
                  {isProcessing && (
                    <>
                      {isPaused ? (
                        <Button variant="secondary" size="sm" onClick={resume}>
                          <Play className="h-3 w-3 mr-1" /> Resume
                        </Button>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={pause}>
                          <Pause className="h-3 w-3 mr-1" /> Pause
                        </Button>
                      )}
                      <Button variant="secondary" size="sm" onClick={abort}>
                        <XCircle className="h-3 w-3 mr-1" /> Abort
                      </Button>
                    </>
                  )}
                  <span className="text-xs text-muted-foreground">{progress.message}</span>
                  {procEta && <span className="text-xs text-muted-foreground">{procEta}</span>}
                </div>
              </div>

              {progress.total > 0 && (
                <Progress value={pct} className="h-1" />
              )}

              <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-background p-2 space-y-0.5">
                {logs.map((entry, i) => <LogLine key={i} entry={entry} />)}
              </div>
            </div>
          )}
        </main>

        {/* ── Bulk bar ── */}
        {selectedIds.size > 0 && (
          <div className="sticky bottom-4 mx-5 flex items-center gap-3 rounded-xl border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-2xl">
            <span className="text-sm font-semibold min-w-[80px]">{selectedIds.size} selected</span>
            <Button
              variant="destructive"
              disabled={isProcessing}
              onClick={() => startBulkUnfollow(Array.from(selectedIds))}
            >
              Unfollow Selected
            </Button>
            <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              {dryRun && <span className="text-yellow-400 font-medium">DRY-RUN ON</span>}
              {isProcessing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            </div>
          </div>
        )}

        {/* ── Rate pill ── */}
        {rateInfo.remaining !== null && (
          <div className="fixed bottom-5 right-5 z-50 flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-lg">
            <span>API:</span>
            <span className={rateInfo.remaining < 5 ? 'text-red-400' : ''}>{rateInfo.remaining}</span>
            <span>/50</span>
            {rateInfo.reset && (
              <span className="ml-1">
                resets ~{Math.max(0, Math.ceil((rateInfo.reset * 1000 - Date.now()) / 60000))}m
              </span>
            )}
          </div>
        )}

        {/* ── Dialogs ── */}
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          clientId={clientId}
          xaiApiKey={xaiApiKey}
          onSave={handleSaveSettings}
          onDisconnect={handleDisconnect}
        />

        <ConfirmDialog
          open={confirmDialog.open}
          title={confirmDialog.title}
          description={confirmDialog.description}
          timeEstimate={confirmDialog.timeEstimate}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(d => ({ ...d, open: false }))}
        />

        <Toaster position="bottom-center" theme="dark" richColors />
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Manager />);
