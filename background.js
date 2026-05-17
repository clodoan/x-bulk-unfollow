// X Bulk Unfollow - Background Service Worker (Manifest V3)
// Minimal stub. All real work happens in the manager tab (long-lived context).

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[x-bulk-unfollow] Extension installed/updated:', details.reason);
});

// Future: could listen for alarms to schedule very long-running queues across restarts,
// but for v1 we keep the processor inside the open manager tab (user keeps it alive).
