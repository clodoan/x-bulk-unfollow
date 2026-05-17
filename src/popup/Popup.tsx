import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../globals.css';
import { Button } from '@/components/ui/button';

interface StoredData {
  accessToken?: string;
  me?: { username: string; name: string };
}

function Popup() {
  const [status, setStatus] = useState<'loading' | 'connected' | 'disconnected'>('loading');
  const [username, setUsername] = useState('');

  useEffect(() => {
    chrome.storage.local.get(['accessToken', 'me']).then((data: StoredData) => {
      if (data.accessToken && data.me) {
        setStatus('connected');
        setUsername(data.me.username);
      } else {
        setStatus('disconnected');
      }
    });
  }, []);

  const openManager = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/manager/index.html'), active: true });
    setTimeout(() => window.close(), 80);
  };

  return (
    <div className="p-3">
      <div className="rounded-xl border border-border bg-card p-4 shadow-lg">
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          <div className="w-6 h-6 rounded-full bg-black border-2 border-primary flex items-center justify-center">
            <span className="text-[10px] font-black text-primary">X</span>
          </div>
          <span className="text-sm font-semibold">X Bulk Unfollow</span>
        </div>

        {/* Status */}
        <div className="mb-3 min-h-[18px]">
          {status === 'loading' && (
            <p className="text-xs text-muted-foreground">Checking connection…</p>
          )}
          {status === 'connected' && (
            <p className="text-xs text-green-400">Connected as @{username}</p>
          )}
          {status === 'disconnected' && (
            <p className="text-xs text-muted-foreground">Not connected to X</p>
          )}
        </div>

        {/* CTA */}
        <Button className="w-full" size="sm" onClick={openManager} disabled={status === 'loading'}>
          {status === 'connected' ? 'Open Unfollow Manager' : 'Open Manager to Connect'}
        </Button>

        <p className="mt-3 text-center text-[10px] text-muted-foreground/60">
          Uses official X API · Private · v0.2.0
        </p>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Popup />);
