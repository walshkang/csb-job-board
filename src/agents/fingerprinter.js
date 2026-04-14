#!/usr/bin/env node
/*
ATS Fingerprinter

Runs between discovery and scraping. Reads data/companies.json and attempts to fingerprint ATS platform
for companies with careers_page_reachable === true.
Writes updates atomically to data/companies.json and prints a summary.
*/

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const CONCURRENCY = 5;
const TIMEOUT_MS = 15000;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function readJsonSafe(p) {
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

async function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, p);
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'csb-job-board-fingerprinter/1' } });
    clearTimeout(id);
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    return null;
  }
}

function detectFromHtml(html) {
  if (!html) return null;
  const low = html.toLowerCase();
  // Greenhouse
  if (low.includes('boards.greenhouse.io') || low.includes('greenhouse-io') || /id\s*=\s*"grnhse_app"/.test(low)) return 'greenhouse';
  // Lever
  if (low.includes('jobs.lever.co')) return 'lever';
  // Ashby
  if (low.includes('jobs.ashbyhq.com') || low.includes('ashby-job-posting')) return 'ashby';
  // Workday
  if (low.includes('myworkdayjobs.com')) return 'workday';
  return null;
}

function extractSlugFromUrl(u) {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname.split('/').filter(Boolean);
    // Host-based heuristics
    if (host.includes('boards.greenhouse.io') || host.includes('greenhouse')) {
      return parts.length ? parts[0] : null;
    }
    if (host.includes('jobs.lever.co') || host.includes('lever')) {
      return parts.length ? parts[0] : null;
    }
    if (host.includes('jobs.ashbyhq.com') || host.includes('ashby')) {
      return parts.length ? parts[parts.length - 1] : null;
    }
    // Generic: take first path segment
    return parts.length ? parts[0] : null;
  } catch (err) {
    return null;
  }
}

async function ensureDir(p) {
  try { await fs.promises.mkdir(p, { recursive: true }); } catch (e) {}
}

async function run() {
  const repoRoot = path.join(__dirname, '../../');
  const dataPath = path.join(repoRoot, 'data', 'companies.json');
  const artifactsDir = path.join(repoRoot, 'artifacts', 'html');

  const companies = await readJsonSafe(dataPath);
  if (!companies || companies.length === 0) {
    console.log('No companies found in data/companies.json');
    process.exit(0);
  }

  const targets = companies.filter(c => c && c.careers_page_reachable === true);
  if (targets.length === 0) {
    console.log('No companies with careers_page_reachable === true');
    process.exit(0);
  }

  let alreadyKnown = 0;
  const platformCounts = Object.create(null);
  let processed = 0;
  let updated = 0;

  // Build tasks
  const tasks = targets.map(c => async () => {
    const origPlatform = c.ats_platform;
    if (origPlatform && origPlatform !== 'custom') {
      alreadyKnown += 1;
    }

    // attempt cached homepage
    const homepagePath = path.join(artifactsDir, `${c.id}.homepage.html`);
    let html = null;
    try {
      html = await fs.promises.readFile(homepagePath, 'utf8');
    } catch (err) {
      // not cached -> fetch
      if (c.domain) {
        const url = `https://${c.domain.replace(/https?:\/\//, '')}/`;
        html = await fetchWithTimeout(url);
        if (html) {
          try {
            await ensureDir(artifactsDir);
            await fs.promises.writeFile(homepagePath, html, 'utf8');
          } catch (e) {
            // ignore write errors
          }
        }
      }
    }

    // detect from homepage
    let detected = detectFromHtml(html);
    const homepageUrl = c.domain ? `https://${c.domain.replace(/https?:\/\//, '')}/` : null;
    const normalize = u => u ? u.replace(/\/+$/, '').toLowerCase() : null;
    const slug = extractSlugFromUrl(c.careers_page_url);

    let changed = false;

    if (detected) {
      if (!origPlatform || origPlatform === 'custom') {
        c.ats_platform = detected;
        platformCounts[detected] = (platformCounts[detected] || 0) + 1;
        changed = true;
      } else {
        platformCounts[origPlatform || detected] = (platformCounts[origPlatform || detected] || 0) + 1;
      }
      // mark where detection came from
      c.ats_detection_source = 'homepage';
    } else if (c.careers_page_url) {
      // only fetch careers page if it's different from homepage URL
      if (normalize(c.careers_page_url) !== normalize(homepageUrl)) {
        const careersPath = path.join(artifactsDir, `${c.id}.careers.html`);
        let careersHtml = null;
        try {
          careersHtml = await fs.promises.readFile(careersPath, 'utf8');
        } catch (e) {
          // not cached -> fetch
          careersHtml = await fetchWithTimeout(c.careers_page_url);
          if (careersHtml) {
            try {
              await ensureDir(artifactsDir);
              await fs.promises.writeFile(careersPath, careersHtml, 'utf8');
            } catch (e2) {
              // ignore write errors
            }
          }
        }

        const detectedFromCareers = detectFromHtml(careersHtml);
        if (detectedFromCareers) {
          if (!origPlatform || origPlatform === 'custom') {
            c.ats_platform = detectedFromCareers;
            platformCounts[detectedFromCareers] = (platformCounts[detectedFromCareers] || 0) + 1;
            changed = true;
          } else {
            platformCounts[origPlatform || detectedFromCareers] = (platformCounts[origPlatform || detectedFromCareers] || 0) + 1;
          }
          c.ats_detection_source = 'careers_page';
          // re-run slug extraction against careers page URL
          const careersSlug = extractSlugFromUrl(c.careers_page_url);
          if (careersSlug && !c.ats_slug) {
            c.ats_slug = careersSlug;
            changed = true;
          }
        }
      }
    }

    if (slug && !c.ats_slug) {
      c.ats_slug = slug;
      changed = true;
    }

    if (changed) updated += 1;
    processed += 1;
  });

  // Run with concurrency
  const concurrency = Math.min(CONCURRENCY, tasks.length);
  const queue = tasks.slice();
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const t = queue.shift();
      try { await t(); } catch (e) { /* ignore per-item errors */ }
    }
  });
  await Promise.all(workers);

  // Write back atomically
  try {
    await writeJsonAtomic(dataPath, companies);
  } catch (err) {
    console.error('Failed to write companies.json:', err.message || err);
    process.exit(1);
  }

  // Summary
  console.log('\nFingerprinting complete');
  console.log('Companies inspected:', processed);
  console.log('Already had known ATS (not custom):', alreadyKnown);
  console.log('Updated companies:', updated);
  console.log('Platform distribution:');
  for (const k of Object.keys(platformCounts)) console.log(`  ${k}: ${platformCounts[k]}`);
}

run().catch(err => { console.error('Fatal:', err && err.message ? err.message : err); process.exit(1); });
