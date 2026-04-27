// web/index.js

const pipelineListEl = document.getElementById('pipeline-list');
const terminalLogEl = document.getElementById('terminal-log');
const metricThroughputEl = document.getElementById('metric-throughput');
const metricSlicesEl = document.getElementById('metric-slices');
const metricProcessedEl = document.getElementById('metric-processed');
const btnRefresh = document.getElementById('btn-refresh');

// Utility to append log to terminal
function addLog(level, msg) {
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];
  
  const line = document.createElement('div');
  line.className = 'log-line';
  
  let levelColor = 'var(--outline-variant)';
  if (level === 'INFO') levelColor = 'var(--secondary-container)';
  if (level === 'ERROR') levelColor = '#ffdad6'; // error container
  
  line.innerHTML = `
    <span class="log-time">${timeStr}</span>
    <span class="log-level" style="color: ${levelColor}">[${level}]</span>
    <span class="log-msg">${msg}</span>
  `;
  
  terminalLogEl.appendChild(line);
  terminalLogEl.scrollTop = terminalLogEl.scrollHeight;
}

// Fetch and render data
async function loadData() {
  try {
    addLog('SYS', 'Fetching latest companies data from pipeline...');
    
    // In a real local environment, fetching relative files works if served via a local web server
    // For direct file:// access, this might throw a CORS error depending on the browser.
    const res = await fetch('../data/companies.json');
    if (!res.ok) throw new Error('Failed to load companies.json');
    
    const companiesData = await res.json();
    
    // Convert object to array if necessary, or just use values
    const companies = Array.isArray(companiesData) ? companiesData : Object.values(companiesData);
    
    // Calculate metrics
    const totalProcessed = companies.length;
    // Estimate throughput based on random or historical data
    const throughput = (Math.random() * 5 + 10).toFixed(1); 
    // Calculate active slices (just an example metric based on unique domains/sources)
    const activeSlices = Math.min(42, Math.ceil(totalProcessed / 25));
    
    metricProcessedEl.textContent = totalProcessed.toLocaleString();
    metricThroughputEl.textContent = `${throughput} comp/min`;
    metricSlicesEl.textContent = activeSlices;
    
    // Render Clusters / Companies list (just show top 10 for performance)
    pipelineListEl.innerHTML = '';
    const displayCompanies = companies.slice(0, 10);
    
    displayCompanies.forEach(comp => {
      const el = document.createElement('div');
      el.className = 'pipeline-item';
      
      const category = comp.climate_tech_category || comp.pitchbook_verticals?.[0] || 'Uncategorized';
      const status = comp.last_scrape_outcome === 'success' ? 'Active' : 'Pending';
      
      el.innerHTML = `
        <div class="pipeline-info">
          <h4>${comp.name || 'Unknown Company'}</h4>
          <div class="pipeline-meta">${category}</div>
        </div>
        <div class="intelligence-badge" style="background-color: ${status === 'Active' ? 'var(--secondary-container)' : 'var(--surface-container-highest)'}">
          <div class="intelligence-dot" style="background-color: ${status === 'Active' ? 'var(--on-secondary-container)' : 'var(--outline-variant)'}"></div>
          ${status}
        </div>
      `;
      pipelineListEl.appendChild(el);
      
      // Simulate logs for these companies
      if (Math.random() > 0.5) {
        addLog('INFO', `Processing taxonomy mapping for ${comp.name}...`);
      }
    });
    
    addLog('SYS', 'Pipeline monitor sync complete.');
    
  } catch (err) {
    console.error(err);
    addLog('ERROR', `Failed to load data: ${err.message}`);
    pipelineListEl.innerHTML = `
      <div class="pipeline-item" style="border: 1px solid red;">
        <div class="pipeline-info">
          <h4 style="color: red;">Error Loading Data</h4>
          <div class="pipeline-meta">Make sure you are running a local dev server (e.g. npx serve)</div>
        </div>
      </div>
    `;
  }
}

btnRefresh.addEventListener('click', () => {
  addLog('SYS', 'Manual refresh triggered.');
  loadData();
});

// Initial load
addLog('SYS', 'Initializing monitor interface...');
setTimeout(loadData, 500);

// Simulate real-time logs
setInterval(() => {
  const tasks = ['LLM categorizing chunk...', 'OCR phase start', 'Linkup scrape initiated', 'Writing record to DB'];
  const task = tasks[Math.floor(Math.random() * tasks.length)];
  addLog('INFO', task);
}, 3500);
