// web/index.js

const pipelineListEl = document.getElementById('pipeline-list');
const terminalLogEl = document.getElementById('terminal-log');
const metricThroughputEl = document.getElementById('metric-throughput');
const metricSlicesEl = document.getElementById('metric-slices');
const metricProcessedEl = document.getElementById('metric-processed');
const btnRefresh = document.getElementById('btn-refresh');

// Drawer Elements
const stageDrawer = document.getElementById('stage-drawer');
const drawerBackdrop = document.getElementById('drawer-backdrop');
const btnCloseDrawer = document.getElementById('btn-close-drawer');
const drawerTitle = document.getElementById('drawer-title');
const drawerMetrics = document.getElementById('drawer-metrics');
const drawerEvents = document.getElementById('drawer-events');
const drawerAlerts = document.getElementById('drawer-alerts');
const btnResetCircuit = document.getElementById('btn-reset-circuit');

let lastLogCount = 0;
let currentStage = null;
let pollInterval = null;

// Utility to append log to terminal
function addLog(level, msg, timeOverride = null, targetEl = terminalLogEl) {
  const now = new Date();
  const timeStr = timeOverride || now.toTimeString().split(' ')[0];
  
  const line = document.createElement('div');
  line.className = 'log-line';
  
  let levelColor = 'var(--text-muted)';
  if (level.includes('ERROR')) levelColor = '#ff4f4f';
  if (level.includes('SYS')) levelColor = 'var(--accent)';
  if (level.includes('INFO')) levelColor = 'var(--primary)';
  
  line.innerHTML = `
    <span class="log-time">${timeStr}</span>
    <span class="log-level" style="color: ${levelColor}">[${level}]</span>
    <span class="log-msg">${msg}</span>
  `;
  
  targetEl.appendChild(line);
  targetEl.scrollTop = targetEl.scrollHeight;
  
  if (targetEl.childNodes.length > 500) {
    targetEl.removeChild(targetEl.firstChild);
  }
}

// Drawer Logic
function openDrawer(stage) {
  currentStage = stage;
  drawerTitle.textContent = `${stage.charAt(0).toUpperCase() + stage.slice(1)} Intelligence`;
  stageDrawer.classList.add('active');
  drawerBackdrop.classList.add('active');
  refreshStageDetail();
}

function closeDrawer() {
  stageDrawer.classList.remove('active');
  drawerBackdrop.classList.remove('active');
  currentStage = null;
}

btnCloseDrawer.addEventListener('click', closeDrawer);
drawerBackdrop.addEventListener('click', closeDrawer);

async function refreshStageDetail() {
  if (!currentStage) return;
  
  try {
    const res = await fetch(`/api/stage/${currentStage}`);
    if (!res.ok) throw new Error('Stage API failed');
    const payload = await res.json();
    if (!payload.ok) throw new Error(payload.error);
    
    const detail = payload.detail;
    
    // Render Metrics
    const c = detail.counters || {};
    drawerMetrics.innerHTML = `
      <div class="metric-card" style="padding: 1rem;">
        <span class="metric-label">Completed</span>
        <span class="metric-value" style="font-size: 1.5rem;">${c.completed}</span>
      </div>
      <div class="metric-card" style="padding: 1rem;">
        <span class="metric-label">Failed</span>
        <span class="metric-value" style="font-size: 1.5rem; color: ${c.failed > 0 ? '#ff4f4f' : 'inherit'}">${c.failed}</span>
      </div>
      <div class="metric-card" style="padding: 1rem;">
        <span class="metric-label">In Flight</span>
        <span class="metric-value" style="font-size: 1.5rem;">${c.inFlight}</span>
      </div>
      <div class="metric-card" style="padding: 1rem;">
        <span class="metric-label">Queued</span>
        <span class="metric-value" style="font-size: 1.5rem;">${c.queueDepth}</span>
      </div>
    `;

    // Render Events
    drawerEvents.innerHTML = '';
    (detail.events || []).forEach(event => {
      addLog(event.outcome === 'success' ? 'OK' : 'FAIL', `${event.company_name || 'N/A'}: ${event.error || 'Processed'}`, null, drawerEvents);
    });

    // Circuit Breaker Check
    const breakers = window.lastStatus?.live?.breakers || {};
    const breaker = breakers[currentStage];
    if (breaker && breaker.state === 'open') {
      drawerAlerts.innerHTML = `
        <div class="intelligence-badge" style="width: 100%; border-color: #ff4f4f; color: #ff4f4f; background: rgba(255,79,79,0.1); padding: 1rem;">
          Circuit Breaker Tripped: ${Math.round(breaker.failureRate * 100)}% failure rate
        </div>
      `;
      btnResetCircuit.style.display = 'block';
    } else {
      drawerAlerts.innerHTML = '';
      btnResetCircuit.style.display = 'none';
    }

  } catch (err) {
    console.error(err);
    addLog('ERROR', `Failed to fetch stage detail for ${currentStage}`);
  }
}

const btnStartRun = document.getElementById('btn-start-run');
const btnStopRun = document.getElementById('btn-stop-run');
const breakerBanner = document.getElementById('breaker-banner');
const breakerBannerText = document.getElementById('breaker-banner-text');
const btnResetAllBreakers = document.getElementById('btn-reset-all-breakers');

// Fetch and render data from API
async function refreshDashboard() {
  try {
    const res = await fetch('/api/status');
    if (res.ok) {
      const status = await res.json();
      renderStatus(status);
    } else {
      throw new Error('API down');
    }
  } catch (err) {
    console.error(err);
    addLog('ERROR', 'API Connection Lost. Retrying...');
  }
}

let lastRunId = null;

function renderStatus(status) {
  const source = status.live || status.lastRun || null;
  const currentRunId = source?.run_id || null;

  // Reset log state if we switched runs or datasets
  if (currentRunId !== lastRunId) {
    terminalLogEl.innerHTML = '';
    lastLogCount = 0;
    lastRunId = currentRunId;
    addLog('SYS', `Viewing Intelligence Stream: ${currentRunId || 'Historical'}`);
  }

  window.lastStatus = status;
  
  // Update Control Buttons
  if (btnStopRun && btnStartRun) {
    btnStopRun.style.display = status.panelChildRunning ? 'block' : 'none';
    btnStartRun.style.display = status.panelChildRunning ? 'none' : 'block';
  }

  // Update Breaker Banner
  const breakers = source?.breakers || {};
  const openBreakers = Object.entries(breakers).filter(([_, b]) => b.state === 'open');
  if (openBreakers.length > 0) {
    breakerBanner.style.display = 'flex';
    breakerBannerText.textContent = `Critical Service Interrupt: ${openBreakers.length} Stage${openBreakers.length > 1 ? 's' : ''} Tripped (${openBreakers.map(b => b[0]).join(', ')})`;
  } else {
    breakerBanner.style.display = 'none';
  }

  // Update Metrics
  if (source) {
    const stats = source.stats || {};
    const completedCount = Object.values(stats.completed || {}).reduce((a, b) => a + b, 0);
    const failedCount = Object.values(stats.failed || {}).reduce((a, b) => a + b, 0);
    metricProcessedEl.textContent = (completedCount + failedCount).toLocaleString();
    
    const tpm = source.throughput_per_min || {};
    const totalTpm = Object.values(tpm).reduce((a, b) => a + b, 0).toFixed(1);
    metricThroughputEl.textContent = totalTpm;
    
    const inFlight = Object.values(source.in_flight || {}).reduce((a, b) => a + b, 0);
    const queued = Object.values(source.queue_depths || {}).reduce((a, b) => a + b, 0);
    metricSlicesEl.textContent = (inFlight + queued > 0) ? (Object.keys(source.in_flight || {}).length) : 0;
  }

  // Update Logs
  const newLogs = status.recentLog || [];
  if (newLogs.length > lastLogCount) {
    for (let i = lastLogCount; i < newLogs.length; i++) {
      const line = newLogs[i];
      const levelMatch = line.match(/^\[(.*?)\]/);
      const level = levelMatch ? levelMatch[1].toUpperCase() : 'SYS';
      const msg = line.replace(/^\[.*?\]/, '').trim();
      addLog(level, msg);
    }
    lastLogCount = newLogs.length;
  }

  // Update Clusters
  if (status.stageCatalog) {
    pipelineListEl.innerHTML = '';
    status.stageCatalog.forEach(stage => {
      const isInFlight = source?.in_flight?.[stage.stage] > 0;
      const statusText = isInFlight ? 'Active' : 'Standby';
      
      const el = document.createElement('div');
      el.className = 'pipeline-item';
      el.style.cursor = 'pointer';
      el.onclick = () => openDrawer(stage.stage);
      el.innerHTML = `
        <div class="pipeline-info">
          <h4>${stage.stage.charAt(0).toUpperCase() + stage.stage.slice(1)} Agent</h4>
          <div class="pipeline-meta">${stage.summary.slice(0, 45)}...</div>
        </div>
        <div class="intelligence-badge" style="border-color: ${isInFlight ? 'var(--accent)' : 'rgba(255,255,255,0.1)'}">
          <div class="intelligence-dot" style="background-color: ${isInFlight ? 'var(--accent)' : 'var(--text-muted)'}"></div>
          ${statusText}
        </div>
      `;
      pipelineListEl.appendChild(el);
    });
  }

  if (currentStage) refreshStageDetail();
}

btnRefresh.addEventListener('click', () => {
  addLog('SYS', 'Manual sync triggered.');
  refreshDashboard();
});

btnResetCircuit.addEventListener('click', async () => {
  if (!currentStage) return;
  addLog('SYS', `Requesting circuit reset for ${currentStage}...`);
  try {
    const res = await fetch(`/api/circuit/${currentStage}/reset`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) addLog('SYS', 'Reset command enqueued.');
  } catch (e) {
    addLog('ERROR', 'Failed to send reset command.');
  }
});

btnResetAllBreakers.addEventListener('click', async () => {
  const breakers = window.lastStatus?.live?.breakers || {};
  const openBreakers = Object.entries(breakers).filter(([_, b]) => b.state === 'open').map(b => b[0]);
  
  for (const stage of openBreakers) {
    addLog('SYS', `Resetting circuit for ${stage}...`);
    try {
      await fetch(`/api/circuit/${stage}/reset`, { method: 'POST' });
    } catch (e) {}
  }
});

btnStartRun.addEventListener('click', async () => {
  const limit = prompt('Enter company limit (optional, e.g. 10):', '20');
  if (limit === null) return;
  
  addLog('SYS', `Initiating pipeline run (limit: ${limit})...`);
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: parseInt(limit) || 20 })
    });
    const data = await res.json();
    if (data.ok) addLog('SYS', 'Run started successfully.');
    else addLog('ERROR', `Run failed: ${data.error}`);
  } catch (e) {
    addLog('ERROR', 'Failed to start run.');
  }
});

btnStopRun.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to stop the current run?')) return;
  addLog('SYS', 'Sending emergency stop signal...');
  try {
    const res = await fetch('/api/stop', { method: 'POST' });
    const data = await res.json();
    if (data.ok) addLog('SYS', 'Stop signal received.');
  } catch (e) {
    addLog('ERROR', 'Failed to stop run.');
  }
});

if (window.location.protocol === 'file:') {
  addLog('ERROR', 'Running from file:// system. API calls will be blocked by browser security (CORS).');
  addLog('SYS', 'Please access the dashboard via: http://localhost:3847/');
}

refreshDashboard();
setInterval(refreshDashboard, 2000);
