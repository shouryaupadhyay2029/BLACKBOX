const KALA_URL = 'http://localhost:9876';

async function refreshPopup() {
  const badge = document.getElementById('statusBadge');
  try {
    const res = await fetch(`${KALA_URL}/api/status`);
    const data = await res.json();
    badge.textContent = 'Daemon Online';
    document.getElementById('bufEvents').textContent = `${data.buffer.activeEvents} events (${data.buffer.memoryMB} MB)`;
    document.getElementById('bufTraces').textContent = data.buffer.activeTraces;
    document.getElementById('gitBranch').textContent = data.git.branch
      ? `${data.git.branch}${data.git.isDirty ? ' (dirty)' : ''}`
      : 'N/A';
    document.getElementById('capCount').textContent = data.totalCapsules;
  } catch {
    badge.textContent = 'Daemon Offline';
    badge.style.color = '#f87171';
  }
}

document.getElementById('freezeBtn').addEventListener('click', async () => {
  try {
    const res = await fetch(`${KALA_URL}/api/freeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggerReason: 'EXTENSION_POPUP_FREEZE' }),
    });
    const data = await res.json();
    if (data.studioUrl) {
      chrome.tabs.create({ url: data.studioUrl });
    }
  } catch {
    alert('KALA Daemon is not running on port 9876. Start it with: npx kala demo');
  }
});

document.getElementById('openStudioBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: KALA_URL });
});

refreshPopup();
