// web/index.js

const pipelineListEl = document.getElementById('pipeline-list');
const terminalLogEl = document.getElementById('terminal-log');
const metricThroughputEl = document.getElementById('metric-throughput');
const metricSlicesEl = document.getElementById('metric-slices');
const metricProcessedEl = document.getElementById('metric-processed');
const btnRefresh = document.getElementById('btn-refresh');

let lastLogCount = 0;

// Utility to append log to terminal
function addLog(level, msg, timeOverride = null) {
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
  
  terminalLogEl.appendChild(line);
  terminalLogEl.scrollTop = terminalLogEl.scrollHeight;
  
  // Keep terminal from getting too large
  if (terminalLogEl.childNodes.length > 500) {
    terminalLogEl.removeChild(terminalLogEl.firstChild);
  }
}

// Fetch and render data from API
async function refreshDashboard() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    
    const status = await res.json();
    const source = status.live || status.lastRun || null;
    
    // Update Metrics
    if (source) {
      const stats = source.stats || {};
      const completedCount = Object.values(stats.completed || {}).reduce((a, b) => a + b, 0);
      const failedCount = Object.values(stats.failed || {}).reduce((a, b) => a + b, 0);
      
      metricProcessedEl.textContent = (completedCount + failedCount).toLocaleString();
      
      // Calculate overall throughput
      const tpm = source.throughput_per_min || {};
      const totalTpm = Object.values(tpm).reduce((a, b) => a + b, 0).toFixed(1);
      metricThroughputEl.textContent = totalTpm;
      
      // Active Slices (number of stages with in-flight or queued items)
      const inFlight = Object.values(source.in_flight || {}).reduce((a, b) => a + b, 0);
      const queued = Object.values(source.queue_depths || {}).reduce((a, b) => a + b, 0);
      metricSlicesEl.textContent = (inFlight + queued > 0) ? (source.stages?.length || 0) : 0;
    }

    // Update Logs
    const newLogs = status.recentLog || [];
    if (newLogs.length > lastLogCount) {
      const start = lastLogCount;
      for (let i = start; i < newLogs.length; i++) {
        // Simple heuristic to parse level from log line like "[profile] ..."
        const line = newLogs[i];
        const levelMatch = line.match(/^\[(.*?)\]/);
        const level = levelMatch ? levelMatch[1].toUpperCase() : 'SYS';
        const msg = line.replace(/^\[.*?\]/, '').trim();
        addLog(level, msg);
      }
      lastLogCount = newLogs.length;
    } else if (newLogs.length < lastLogCount) {
      // Log buffer was reset on server
      lastLogCount = 0;
    }

    // Update Clusters (Using stages for now as "clusters")
    if (status.stageCatalog) {
      pipelineListEl.innerHTML = '';
      status.stageCatalog.forEach(stage => {
        const stats = source?.stats?.completed?.[stage.stage] || 0;
        const failed = source?.stats?.failed?.[stage.stage] || 0;
        const statusText = (source?.in_flight?.[stage.stage] > 0) ? 'Active' : 'Standby';
        
        const el = document.createElement('div');
        el.className = 'pipeline-item';
        el.innerHTML = `
          <div class="pipeline-info">
            <h4>${stage.stage.charAt(0).toUpperCase() + stage.stage.slice(1)} Agent</h4>
            <div class="pipeline-meta">${stage.summary.slice(0, 45)}...</div>
          </div>
          <div class="intelligence-badge" style="border-color: ${statusText === 'Active' ? 'var(--accent)' : 'rgba(255,255,255,0.1)'}">
            <div class="intelligence-dot" style="background-color: ${statusText === 'Active' ? 'var(--accent)' : 'var(--text-muted)'}"></div>
            ${statusText}
          </div>
        `;
        pipelineListEl.appendChild(el);
      });
    }

  } catch (err) {
    console.error(err);
    // Only log error once to avoid spamming
    if (terminalLogEl.lastChild?.textContent.indexOf('Sync failed') === -1) {
      addLog('ERROR', `Sync failed: ${err.message}`);
    }
  }
}

btnRefresh.addEventListener('click', () => {
  addLog('SYS', 'Manual intelligence sync triggered.');
  refreshDashboard();
});

// Initial load and polling
refreshDashboard();
setInterval(refreshDashboard, 2000);
