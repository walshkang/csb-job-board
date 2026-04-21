#!/usr/bin/env node
/**
 * Offline parity with docs/archive/extract-html-shape-audit-2026-04-20.md: for each validated company
 * with artifacts/html/{id}.html and no sibling {id}.json, run extractCompanyJobs with
 * a no-op LLM so extractStats reflect adapter vs LLM path without API calls.
 *
 * Usage: node scripts/audit-html-extract-adapter-baseline.js
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const { extractCompanyJobs } = require('../src/agents/extraction');
const config = require('../src/config');

const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts', 'html');
const COMPANIES_PATH = path.join(REPO_ROOT, 'data', 'companies.json');

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const raw = readJsonSafe(COMPANIES_PATH);
  if (!raw) {
    console.error('Missing or invalid', COMPANIES_PATH);
    process.exit(1);
  }
  let companies;
  try {
    companies = config.validateCompanies(raw);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (!fs.existsSync(ARTIFACTS_DIR)) {
    console.log('No artifacts/html directory — cannot compute HTML-only baseline.');
    process.exit(0);
  }

  const extractStats = { htmlAdapterCompanies: 0, htmlLlmCompanies: 0 };
  let htmlOnlyRows = 0;
  const noopLlm = async () => '[]';

  for (const company of companies) {
    const id = company.id;
    const htmlPath = path.join(ARTIFACTS_DIR, `${id}.html`);
    const jsonPath = path.join(ARTIFACTS_DIR, `${id}.json`);
    if (!fs.existsSync(htmlPath) || fs.existsSync(jsonPath)) continue;
    htmlOnlyRows += 1;
    await extractCompanyJobs(company, {
      artifactsDir: ARTIFACTS_DIR,
      callFn: noopLlm,
      extractStats,
    });
  }

  const adapter = extractStats.htmlAdapterCompanies;
  const llm = extractStats.htmlLlmCompanies;
  const denom = adapter + llm;
  const share = denom ? ((adapter / denom) * 100).toFixed(1) : '—';

  console.log('HTML-only extract path (no-op LLM) — parity with docs/archive/extract-html-shape-audit-2026-04-20.md');
  console.log(`  HTML-only rows (canonical .html, no .json): ${htmlOnlyRows}`);
  console.log(`  htmlAdapterCompanies: ${adapter}`);
  console.log(`  htmlLlmCompanies: ${llm}`);
  console.log(`  adapter share of (adapter+llm): ${share}%`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
