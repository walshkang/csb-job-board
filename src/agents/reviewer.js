#!/usr/bin/env node
/* Reviewer agent (Agent 3)
 * Reads data/runs/latest.json, samples failure artifacts, calls Gemini via callGeminiText,
 * and writes a concise postmortem to data/postmortems/YYYY-MM-DD.md (date from run_at).
 */
const fs = require('fs');
const path = require('path');
const { callGeminiText, DailyQuotaError } = require('../gemini-text');
const config = require('../config');

function safeReadJSON(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const txt = fs.readFileSync(p, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    console.error(`Failed to read/parse JSON at ${p}: ${err.message}`);
    return null;
  }
}

function findErrorStrings(obj, limit = 20) {
  const res = [];
  const seen = new Set();
  function walk(v, ctx = '') {
    if (!v || res.length >= limit) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        res.push({ context: ctx, message: s });
      }
      return;
    }
    if (typeof v === 'object') {
      if (Array.isArray(v)) {
        for (const it of v) {
          walk(it, ctx);
          if (res.length >= limit) break;
        }
        return;
      }
      for (const k of Object.keys(v)) {
        if (res.length >= limit) break;
        const val = v[k];
        const key = String(k).toLowerCase();
        if (key === 'error' || key === 'errors' || key === 'message' || key === 'stack') {
          if (typeof val === 'string') {
            walk(val, k);
          } else {
            walk(val, k);
          }
        } else if (typeof val === 'object') {
          walk(val, k);
        }
      }
    }
  }
  walk(obj);
  return res;
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n) : str;
}

async function main() {
  const runPath = path.join(__dirname, '../../data/runs/latest.json');
  if (!fs.existsSync(runPath)) {
    console.log("No run summary found — run 'npm run reporter' first");
    process.exit(0);
  }

  const runSummary = safeReadJSON(runPath);
  if (!runSummary) {
    console.error('Failed to load run summary');
    process.exit(1);
  }

  // Parse run_at
  let runAt = new Date();
  if (runSummary.run_at) {
    const d = new Date(runSummary.run_at);
    if (!Number.isNaN(d.getTime())) runAt = d;
  }
  const outDate = runAt.toISOString().slice(0, 10);

  // Load scrape_runs.json
  const scrapeRunsPath = path.join(__dirname, '../../data/scrape_runs.json');
  const scrapeRuns = safeReadJSON(scrapeRunsPath) || [];

  // Extract up to 10 scrape error snippets
  const scrapeErrors = [];
  try {
    if (Array.isArray(scrapeRuns)) {
      for (const item of scrapeRuns) {
        if (scrapeErrors.length >= 10) break;
        // collect error strings from item
        const found = findErrorStrings(item, 5);
        if (found.length > 0) {
          for (const f of found) {
            scrapeErrors.push({ context: item && (item.company || item.id || item.company_id) || null, message: f.message });
            if (scrapeErrors.length >= 10) break;
          }
        }
      }
    } else if (typeof scrapeRuns === 'object') {
      const found = findErrorStrings(scrapeRuns, 10);
      for (const f of found) {
        scrapeErrors.push({ context: null, message: f.message });
        if (scrapeErrors.length >= 10) break;
      }
    }
  } catch (e) {
    // fallback: stringify
    scrapeErrors.push({ context: null, message: `Failed to parse scrape_runs.json: ${e.message}` });
  }

  // Load jobs.json and sample enrichment errors (up to 5)
  const jobsPath = path.join(__dirname, '../../data/jobs.json');
  const jobs = safeReadJSON(jobsPath) || [];
  const enrichmentErrors = [];
  if (Array.isArray(jobs)) {
    for (const j of jobs) {
      if (enrichmentErrors.length >= 5) break;
      const errMsg = j && (j.enrichment_error || j.enrichmentError || j.enrichment_error_message || j.enrichment_error_message || j.error || j.enrichmentErrorMessage);
      if (errMsg) {
        const title = j && (j.job_title_normalized || j.job_title_raw || j.job_title || j.title || j.jobtitle) || 'Unknown title';
        enrichmentErrors.push({ job_title: title, error_message: String(errMsg) });
      }
    }
  }

  // Read prompts and excerpt
  const extractionPromptPath = path.join(__dirname, '../prompts/extraction.txt');
  const enrichmentPromptPath = path.join(__dirname, '../prompts/enrichment.txt');

  let extractionPrompt = null;
  let enrichmentPrompt = null;
  try { extractionPrompt = fs.readFileSync(extractionPromptPath, 'utf8'); } catch (_) { extractionPrompt = null; }
  try { enrichmentPrompt = fs.readFileSync(enrichmentPromptPath, 'utf8'); } catch (_) { enrichmentPrompt = null; }

  const extractionPromptExcerpt = extractionPrompt ? truncate(extractionPrompt.replace(/\s+/g, ' ').trim(), 500) : 'MISSING';
  const enrichmentPromptExcerpt = enrichmentPrompt ? truncate(enrichmentPrompt.replace(/\s+/g, ' ').trim(), 500) : 'MISSING';

  // Build prompt exactly as requested
  const runSummaryJson = JSON.stringify(runSummary, null, 2);
  const scrapeErrorsJson = scrapeErrors.length ? JSON.stringify(scrapeErrors, null, 2) : '[]';
  const enrichmentErrorsJson = enrichmentErrors.length ? JSON.stringify(enrichmentErrors, null, 2) : '[]';

  const prompt = `You are reviewing a pipeline run for a climate tech job board scraper.

Run summary:
${runSummaryJson}

Sample scrape errors (up to 10):
${scrapeErrorsJson}

Sample enrichment errors (up to 5, job titles + error messages only):
${enrichmentErrorsJson}

Current extraction prompt (truncated to 500 chars):
${extractionPromptExcerpt}

Current enrichment prompt (truncated to 500 chars):
${enrichmentPromptExcerpt}

Write a concise postmortem in markdown. Include:
1. What went well (based on success rates)
2. What failed and likely why (pattern-match on errors)
3. Which pipeline stage had the worst yield and what to investigate
4. One concrete suggestion for improving the extraction or enrichment prompt based on the errors seen

Be specific. No generic advice. If data is missing or errors are zero, say so.
`;

  // Check GEMINI key
  const apiKey = config.enrichment && config.enrichment.apiKey;
  if (!apiKey) {
    console.error('Missing GEMINI_API_KEY (config.enrichment.apiKey). Set GEMINI_API_KEY in .env.local or the environment.');
    process.exit(2);
  }

  const model = (config.enrichment && config.enrichment.model) || 'gemini-2.5-flash';

  let postmortemText;
  try {
    postmortemText = await callGeminiText({ apiKey, model, prompt, maxOutputTokens: 2000, fallbackModel: config.enrichment && config.enrichment.fallbackModel });
  } catch (err) {
    if (err && err.name === 'DailyQuotaError') {
      console.error(`Gemini quota error: ${err.message}`);
      process.exit(3);
    }
    console.error('Gemini call failed:', err && err.message ? err.message : err);
    process.exit(4);
  }

  // Ensure output dir
  const outDir = path.join(__dirname, '../../data/postmortems');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* ignore */ }

  const outPath = path.join(outDir, `${outDate}.md`);
  const header = `---\nrun_at: ${runAt.toISOString()}\ngenerated_by: reviewer\n---\n\n`;
  const content = header + postmortemText + '\n';

  try {
    fs.writeFileSync(outPath, content, 'utf8');
    console.log(postmortemText);
    console.log(`\nWrote postmortem to ${outPath}`);
    process.exit(0);
  } catch (e) {
    console.error('Failed to write postmortem:', e.message);
    process.exit(5);
  }
}

main().catch(err => {
  console.error('Unhandled error in reviewer agent:', err && err.stack ? err.stack : err);
  process.exit(10);
});
