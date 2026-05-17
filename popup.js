// popup.js — tiny launcher for X Bulk Unfollow

const STATUS_EL = () => document.getElementById('status');
const BTN = () => document.getElementById('open-manager');

async function init() {
  const statusEl = STATUS_EL();
  const btn = BTN();

  try {
    const data = await chrome.storage.local.get(['accessToken', 'lastUser']);
    if (data.accessToken && data.lastUser) {
      statusEl.textContent = `Connected as @${data.lastUser.username}`;
      statusEl.classList.add('connected');
      btn.disabled = false;
      btn.textContent = 'Open Unfollow Manager';
    } else {
      statusEl.textContent = 'Not connected to X';
      btn.textContent = 'Open Manager to Connect';
      btn.disabled = false;
    }
  } catch (e) {
    statusEl.textContent = 'Error reading storage';
    console.error(e);
    btn.disabled = false;
  }

  btn.addEventListener('click', () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL('manager.html'),
      active: true
    });
    // Close popup after opening (best effort)
    setTimeout(() => window.close(), 80);
  });
}

document.addEventListener('DOMContentLoaded', init);
