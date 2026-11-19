const BLACKBOX_URL = 'http://localhost:9876';

async function refreshPopup() {
  const badge = document.getElementById('statusBadge');
  try {
    const res = await fetch(`${BLACKBOX_URL}/api/status`);
    const data = await res.json();
    badge.textContent = `Online · ${data.projectName || 'localhost'}`;
    badge.style.color = '#34d399';
    document.getElementById('bufEvents').textContent = `${data.buffer.activeEvents} events (${data.buffer.memoryMB} MB)`;
    document.getElementById('bufTraces').textContent = data.buffer.activeTraces;
    document.getElementById('gitBranch').textContent = data.git.branch
      ? `${data.git.branch}${data.git.isDirty ? ' (dirty)' : ' (clean)'}`
      : 'N/A';
    document.getElementById('capCount').textContent = data.totalCapsules;
  } catch {
    badge.textContent = 'Daemon Offline';
    badge.style.color = '#f87171';
    document.getElementById('bufEvents').textContent = 'Run: blackbox run "<cmd>"';
  }
}

document.getElementById('freezeBtn').addEventListener('click', async () => {
  const btn = document.getElementById('freezeBtn');
  try {
    btn.textContent = 'Freezing 60s Buffer...';
    const res = await fetch(`${BLACKBOX_URL}/api/freeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggerReason: 'EXTENSION_POPUP_FREEZE' }),
    });
    const data = await res.json();
    if (data.studioUrl) {
      chrome.tabs.create({ url: data.studioUrl });
    }
  } catch {
    btn.textContent = 'Daemon Offline (:9876)';
    setTimeout(() => {
      btn.textContent = '❄️ Freeze Bug Capsule (Alt+Shift+B)';
    }, 2500);
  }
});

document.getElementById('openStudioBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: BLACKBOX_URL });
});

refreshPopup();
