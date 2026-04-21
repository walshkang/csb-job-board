#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');

const { STAGES } = require('../src/utils/pipeline-stages');
const {
  SNAPSHOT_PATH,
  LAST_RUN_SUMMARY_PATH,
} = require('../src/utils/pipeline-events');

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.ADMIN_PORT || '3847', 10);
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');
const ORCHESTRATOR_PATH = path.join(REPO_ROOT, 'src', 'orchestrator.js');
const PROMPTS_DIR = path.join(REPO_ROOT, 'src', 'prompts');

const STAGE_METADATA = {
  profile: {
    title: 'Company Profiling',
    summary: 'Builds initial company profile signal used to guide discovery and downstream categorization.',
    driver: 'ai',
    promptPath: null,
  },
  discovery: {
    title: 'Careers Discovery',
    summary: 'Finds likely careers URLs and validates reachability using deterministic crawling and heuristics.',
    driver: 'code',
    promptPath: null,
  },
  fingerprint: {
    title: 'ATS Fingerprinting',
    summary: 'Detects ATS/provider signatures from discovered pages and artifacts.',
    driver: 'code',
    promptPath: null,
  },
  scrape: {
    title: 'Scrape',
    summary: 'Fetches careers content and applies signature checks to skip unchanged pages.',
    driver: 'code',
    promptPath: null,
  },
  extract: {
    title: 'Extraction',
    summary: 'Parses scraped HTML into structured job records and extraction artifacts.',
    driver: 'ai',
    promptPath: path.join(PROMPTS_DIR, 'extraction.txt'),
  },
  enrich: {
    title: 'Enrichment',
    summary: 'Classifies role function, seniority, location type, and MBA relevance for each job.',
    driver: 'ai',
    promptPath: path.join(PROMPTS_DIR, 'enrichment.txt'),
  },
  categorize: {
    title: 'Categorization',
    summary: 'Assigns climate-tech category and confidence at the company level.',
    driver: 'ai',
    promptPath: path.join(PROMPTS_DIR, 'categorizer.txt'),
  },
};

if (process.env.ENABLE_ADMIN_PANEL !== '1') {
  process.stderr.write('Admin panel disabled. Set ENABLE_ADMIN_PANEL=1 to run.\n');
  process.exit(1);
}

let currentChild = null;
let currentRun = null;
let recentLog = [];

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function childIsRunning() {
  return !!(currentChild && currentChild.exitCode === null && !currentChild.killed);
}

function hasLiveSnapshot() {
  return fs.existsSync(SNAPSHOT_PATH);
}

function buildOrchestratorArgs(payload) {
  const args = ['--max-old-space-size=4096', ORCHESTRATOR_PATH];

  if (Number.isInteger(payload.limit) && payload.limit > 0) {
    args.push('--limit', String(payload.limit));
  }

  if (typeof payload.company === 'string' && payload.company.trim()) {
    args.push('--company', payload.company.trim());
  }

  if (Array.isArray(payload.stages)) {
    const normalized = payload.stages
      .map((s) => String(s || '').trim())
      .filter((s) => STAGES.includes(s));
    const unique = [...new Set(normalized)];
    if (unique.length > 0 && unique.length < STAGES.length) {
      args.push('--stages', unique.join(','));
    }
  }

  if (payload.dryRun) args.push('--dry-run');
  if (payload.verbose) args.push('--verbose');

  return args;
}

function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function appendLog(line) {
  if (!line) return;
  recentLog.push(line);
  if (recentLog.length > 400) recentLog = recentLog.slice(recentLog.length - 400);
}

function statusPayload() {
  const live = readJSON(SNAPSHOT_PATH);
  const lastRun = readJSON(LAST_RUN_SUMMARY_PATH);
  const stageCatalog = STAGES.map((stage) => ({
    stage,
    ...STAGE_METADATA[stage],
    promptRelativePath: STAGE_METADATA[stage] && STAGE_METADATA[stage].promptPath
      ? path.relative(REPO_ROOT, STAGE_METADATA[stage].promptPath)
      : null,
  }));
  return {
    live,
    lastRun,
    panelChildRunning: childIsRunning(),
    panelRun: currentRun,
    recentLog,
    hasLiveSnapshot: hasLiveSnapshot(),
    stages: STAGES,
    stageCatalog,
  };
}

function readRecentEventsForStage(runId, stage, limit = 40) {
  if (!runId || !stage) return [];
  const eventsPath = path.join(REPO_ROOT, 'data', 'runs', `pipeline-events-${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  try {
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    const rows = [];
    for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec.stage === stage) rows.push(rec);
      } catch (err) {
        // Ignore malformed lines.
      }
    }
    return rows.reverse();
  } catch (err) {
    return [];
  }
}

function resolvePromptPath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return null;
  const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
  const candidate = path.resolve(REPO_ROOT, normalized);
  const promptsRoot = path.resolve(REPO_ROOT, 'src', 'prompts');
  if (!candidate.startsWith(promptsRoot)) return null;
  return candidate;
}

function stageDetailPayload(stage) {
  const live = readJSON(SNAPSHOT_PATH);
  const lastRun = readJSON(LAST_RUN_SUMMARY_PATH);
  const source = live || lastRun || null;
  const runId = source && source.run_id;
  const meta = STAGE_METADATA[stage] || null;

  if (!STAGES.includes(stage)) {
    return {
      ok: false,
      error: `Unknown stage: ${stage}`,
    };
  }

  const stats = source && source.stats ? source.stats : {};
  const detail = {
    stage,
    metadata: {
      ...meta,
      promptRelativePath: meta && meta.promptPath ? path.relative(REPO_ROOT, meta.promptPath) : null,
    },
    runId: runId || null,
    source: live ? 'live' : (lastRun ? 'lastRun' : null),
    counters: {
      started: (stats.started && stats.started[stage]) || 0,
      completed: (stats.completed && stats.completed[stage]) || 0,
      noResult: (stats.no_result && stats.no_result[stage]) || 0,
      failed: (stats.failed && stats.failed[stage]) || 0,
      skipped: (stats.skipped && stats.skipped[stage]) || 0,
      queueDepth: source && source.queue_depths ? (source.queue_depths[stage] || 0) : 0,
      inFlight: source && source.in_flight ? (source.in_flight[stage] || 0) : 0,
      throughputPerMin: source && source.throughput_per_min ? (source.throughput_per_min[stage] || 0) : 0,
    },
    events: readRecentEventsForStage(runId, stage, 60),
    recentLog: recentLog.filter((line) => line.startsWith(`[${stage}]`)).slice(-80),
  };

  return {
    ok: true,
    detail,
  };
}

function handleStartRun(req, res) {
  if (childIsRunning()) {
    return sendJSON(res, 409, { ok: false, error: 'A panel-started run is already in progress.' });
  }
  if (hasLiveSnapshot()) {
    return sendJSON(res, 409, {
      ok: false,
      error: 'A live orchestrator snapshot exists. Stop that run first before starting from panel.',
    });
  }

  readBody(req).then((payload) => {
    const args = buildOrchestratorArgs(payload || {});
    recentLog = [];
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    currentChild = child;
    currentRun = {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      args,
    };

    child.stdout.on('data', (chunk) => appendLog(chunk.toString('utf8').trimEnd()));
    child.stderr.on('data', (chunk) => appendLog(chunk.toString('utf8').trimEnd()));
    child.on('exit', (code, signal) => {
      if (currentRun) {
        currentRun.exitCode = code;
        currentRun.exitSignal = signal;
        currentRun.finishedAt = new Date().toISOString();
      }
      currentChild = null;
    });

    return sendJSON(res, 200, { ok: true, pid: child.pid, args });
  }).catch((err) => {
    return sendJSON(res, 400, { ok: false, error: err.message });
  });
}

function handleStopRun(res) {
  if (!childIsRunning()) {
    return sendJSON(res, 409, { ok: false, error: 'No panel-started run is currently active.' });
  }
  currentChild.kill('SIGTERM');
  return sendJSON(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && reqUrl.pathname === '/') {
    const html = fs.readFileSync(INDEX_PATH, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/status') {
    sendJSON(res, 200, statusPayload());
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname.startsWith('/api/stage/')) {
    const stage = reqUrl.pathname.replace('/api/stage/', '');
    const payload = stageDetailPayload(stage);
    sendJSON(res, payload.ok ? 200 : 404, payload);
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/prompt') {
    const relativePath = reqUrl.searchParams.get('path');
    const resolved = resolvePromptPath(relativePath);
    if (!resolved || !fs.existsSync(resolved)) {
      sendJSON(res, 404, { ok: false, error: 'Prompt file not found.' });
      return;
    }
    const text = fs.readFileSync(resolved, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/run') {
    handleStartRun(req, res);
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/stop') {
    handleStopRun(res);
    return;
  }

  sendJSON(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`Admin panel listening at http://${HOST}:${PORT}\n`);
});
