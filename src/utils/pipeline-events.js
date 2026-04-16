const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(REPO_ROOT, 'data', 'runs');
const SNAPSHOT_PATH = path.join(RUNS_DIR, 'orchestrator-snapshot.json');
const RETENTION = 30;

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }

function newRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

function retentionCleanup() {
  if (!fs.existsSync(RUNS_DIR)) return;
  const files = fs.readdirSync(RUNS_DIR)
    .filter(f => f.startsWith('pipeline-events-') && f.endsWith('.jsonl'))
    .sort();
  const excess = files.length - RETENTION;
  if (excess <= 0) return;
  for (let i = 0; i < excess; i++) {
    try { fs.unlinkSync(path.join(RUNS_DIR, files[i])); } catch (e) {}
  }
}

// Classify errors/results into a coarse failure_class for dashboards.
function classifyFailure(stage, err, result) {
  if (!err && (!result || result.skipped)) return 'skipped';
  if (!err) return null;
  const msg = (err.message || String(err)).toLowerCase();
  if (msg.includes('aborterror') || msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('enotfound') || msg.includes('getaddrinfo') || msg.includes('dns')) return 'dns';
  if (/http\s*4\d{2}|status\s*4\d{2}/.test(msg)) return 'http_4xx';
  if (/http\s*5\d{2}|status\s*5\d{2}/.test(msg)) return 'http_5xx';
  if (msg.includes('blocked') || msg.includes('captcha') || msg.includes('cloudflare')) return 'blocked';
  if (msg.includes('json') && (msg.includes('parse') || msg.includes('unexpected'))) return 'llm_parse_fail';
  if (msg.includes('rate') && msg.includes('limit')) return 'llm_rate_limit';
  if (msg.includes('429')) return 'llm_rate_limit';
  if (stage === 'extract' && msg.includes('empty')) return 'empty_result';
  return 'unknown';
}

class EventSink {
  constructor(runId = newRunId()) {
    this.runId = runId;
    ensureDir(RUNS_DIR);
    retentionCleanup();
    this.path = path.join(RUNS_DIR, `pipeline-events-${runId}.jsonl`);
    this.stream = fs.createWriteStream(this.path, { flags: 'a' });
  }

  emit(stage, company, outcome, extra = {}) {
    const rec = {
      ts: new Date().toISOString(),
      run_id: this.runId,
      company_id: company && company.id,
      company_name: company && company.name,
      stage,
      outcome, // 'success' | 'failure' | 'skipped'
      ...extra,
    };
    try { this.stream.write(JSON.stringify(rec) + '\n'); } catch (e) {}
  }

  close() {
    try { this.stream.end(); } catch (e) {}
  }
}

function writeSnapshot(snapshot) {
  ensureDir(RUNS_DIR);
  const tmp = SNAPSHOT_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(tmp, SNAPSHOT_PATH);
  } catch (e) {}
}

function clearSnapshot() {
  try { fs.unlinkSync(SNAPSHOT_PATH); } catch (e) {}
}

module.exports = { EventSink, writeSnapshot, clearSnapshot, classifyFailure, newRunId, RUNS_DIR, SNAPSHOT_PATH };
