#!/usr/bin/env node
// Notion sync for Companies and Jobs
// Usage: node src/agents/notion-sync.js [--companies-only] [--jobs-only] [--dry-run] [--verbose]

const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

// Load .env.local if present (no external dependency needed)
const envPath = path.join(__dirname, '../../.env.local');
try {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
} catch { /* no .env.local, that's fine */ }

const USAGE = `Usage: node src/agents/notion-sync.js [--companies-only] [--jobs-only] [--dry-run] [--verbose]`;

function readArgs() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  return {
    companiesOnly: argv.includes('--companies-only'),
    jobsOnly: argv.includes('--jobs-only'),
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose'),
  };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function truncate(str, max) {
  if (str == null) return null;
  const s = String(str);
  return s.length > max ? s.slice(0, max) : s;
}

async function readJsonSafe(p) {
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

async function main() {
  const args = readArgs();
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  const NOTION_COMPANIES_DB_ID = process.env.NOTION_COMPANIES_DB_ID;
  const NOTION_JOBS_DB_ID = process.env.NOTION_JOBS_DB_ID;

  if (!NOTION_API_KEY || (!NOTION_COMPANIES_DB_ID && !args.jobsOnly) || (!NOTION_JOBS_DB_ID && !args.companiesOnly)) {
    console.log('Missing NOTION_API_KEY or NOTION_COMPANIES_DB_ID/NOTION_JOBS_DB_ID. Set env vars or .env.local. Exiting.');
    process.exit(0);
  }

  const notion = new Client({ auth: NOTION_API_KEY });
  // Simple fixed delay to respect ~3 req/s limit
  const RATE_DELAY_MS = 350;

  const dataDir = path.join(__dirname, '../../data');
  const companiesPath = path.join(dataDir, 'companies.json');
  const jobsPath = path.join(dataDir, 'jobs.json');

  const companies = await readJsonSafe(companiesPath);
  const jobs = await readJsonSafe(jobsPath);

  const summary = { created: 0, updated: 0, errors: [] };

  async function notionQueryById(databaseId, idValue) {
    // Query by a rich_text property named "id"
    try {
      const res = await notion.databases.query({
        database_id: databaseId,
        filter: {
          property: 'id',
          rich_text: { equals: String(idValue) }
        }
      });
      await sleep(RATE_DELAY_MS);
      if (res.results && res.results.length > 0) return res.results[0];
      return null;
    } catch (err) {
      // Some DBs may store id as title; try title fallback
      if (err && err.code) {
        // fallback: search by title contains
        try {
          const r2 = await notion.databases.query({
            database_id: databaseId,
            filter: {
              property: 'Name',
              title: { equals: String(idValue) }
            }
          });
          await sleep(RATE_DELAY_MS);
          if (r2.results && r2.results.length > 0) return r2.results[0];
        } catch (e) {
          // ignore
        }
      }
      throw err;
    }
  }

  function companyToProps(c) {
    const props = {
      Name: { title: [{ text: { content: c.name || '' } }] },
      id: { rich_text: [{ text: { content: String(c.id) } }] },
      Domain: c.domain ? { url: c.domain } : undefined,
      'Funding Signals': { rich_text: [{ text: { content: truncate(JSON.stringify(c.funding_signals || []), 2000) } }] },
      'Profile Description': c.company_profile && c.company_profile.description ? { rich_text: [{ text: { content: truncate(c.company_profile.description, 2000) } }] } : undefined,
      Sector: c.company_profile && c.company_profile.sector ? { select: { name: String(c.company_profile.sector) } } : undefined,
      HQ: c.company_profile && c.company_profile.hq ? { rich_text: [{ text: { content: String(c.company_profile.hq) } }] } : undefined,
      Employees: c.company_profile && typeof c.company_profile.employees === 'number' ? { number: c.company_profile.employees } : undefined,
      'Careers Page': c.careers_page_url ? { url: c.careers_page_url } : undefined,
      'ATS Platform': c.ats_platform ? { select: { name: String(c.ats_platform) } } : undefined,
      Dormant: typeof c.dormant === 'boolean' ? { checkbox: c.dormant } : undefined,
      'Consecutive Empty Scrapes': typeof c.consecutive_empty_scrapes === 'number' ? { number: c.consecutive_empty_scrapes } : undefined,
    };
    // remove undefined
    Object.keys(props).forEach(k => props[k] === undefined && delete props[k]);
    return props;
  }

  async function upsertCompany(c) {
    try {
      if (args.dryRun) {
        if (args.verbose) console.log('[DRY] Upsert company', c.id);
        return { action: 'dry', pageId: null };
      }
      const existing = await notionQueryById(NOTION_COMPANIES_DB_ID, c.id);
      const props = companyToProps(c);
      if (existing) {
        await notion.pages.update({ page_id: existing.id, properties: props });
        await sleep(RATE_DELAY_MS);
        summary.updated += 1;
        if (args.verbose) console.log('Updated company', c.id, '->', existing.id);
        return { action: 'updated', pageId: existing.id };
      } else {
        const created = await notion.pages.create({ parent: { database_id: NOTION_COMPANIES_DB_ID }, properties: props });
        await sleep(RATE_DELAY_MS);
        summary.created += 1;
        if (args.verbose) console.log('Created company', c.id, '->', created.id);
        return { action: 'created', pageId: created.id };
      }
    } catch (err) {
      summary.errors.push({ item: c.id, error: err.message || String(err) });
      console.error('Error upserting company', c.id, err.message || err);
      return { action: 'error' };
    }
  }

  // Build mapping from company.id -> notion page id
  const companyNotionIdByCompanyId = {};

  if (!args.jobsOnly) {
    console.log(`Processing ${companies.length} companies`);
    for (const c of companies) {
      const res = await upsertCompany(c);
      if (res && res.pageId) companyNotionIdByCompanyId[c.id] = res.pageId;
    }
  } else {
    // If jobsOnly, try to look up companies first so relations can be built
    for (const c of companies) {
      try {
        const existing = await notionQueryById(NOTION_COMPANIES_DB_ID, c.id);
        if (existing) companyNotionIdByCompanyId[c.id] = existing.id;
      } catch (err) {
        // ignore
      }
    }
  }

  function jobToProps(j, companyPageId) {
    const props = {
      Title: { title: [{ text: { content: j.job_title_raw || (j.job_title_normalized || '') } }] },
      id: { rich_text: [{ text: { content: String(j.id) } }] },
      'Job Title Normalized': j.job_title_normalized ? { rich_text: [{ text: { content: String(j.job_title_normalized) } }] } : undefined,
      'Source URL': j.source_url ? { url: j.source_url } : undefined,
      'Location Raw': j.location_raw ? { rich_text: [{ text: { content: String(j.location_raw) } }] } : undefined,
      'Employment Type': j.employment_type ? { select: { name: String(j.employment_type) } } : undefined,
      Description: j.description_raw ? { rich_text: [{ text: { content: truncate(j.description_raw, 2000) } }] } : undefined,
      'Description Hash': j.description_hash ? { rich_text: [{ text: { content: String(j.description_hash) } }] } : undefined,
      'First Seen': j.first_seen_at ? { date: { start: j.first_seen_at } } : undefined,
      'Last Seen': j.last_seen_at ? { date: { start: j.last_seen_at } } : undefined,
      'Removed At': j.removed_at ? { date: { start: j.removed_at } } : undefined,
      'Days Live': typeof j.days_live === 'number' ? { number: j.days_live } : undefined,
      'Job Function': j.job_function ? { select: { name: String(j.job_function) } } : undefined,
      'Seniority Level': j.seniority_level ? { select: { name: String(j.seniority_level) } } : undefined,
      'Location Type': j.location_type ? { select: { name: String(j.location_type) } } : undefined,
      'MBA Relevance Score': typeof j.mba_relevance_score === 'number' ? { number: j.mba_relevance_score } : undefined,
      'Description Summary': j.description_summary ? { rich_text: [{ text: { content: truncate(j.description_summary, 2000) } }] } : undefined,
      'Climate Relevance Confirmed': typeof j.climate_relevance_confirmed === 'boolean' ? { checkbox: j.climate_relevance_confirmed } : undefined,
      'Climate Relevance Reason': j.climate_relevance_reason ? { rich_text: [{ text: { content: truncate(j.climate_relevance_reason, 2000) } }] } : undefined,
      'Enrichment Prompt Version': j.enrichment_prompt_version ? { rich_text: [{ text: { content: String(j.enrichment_prompt_version) } }] } : undefined,
    };
    if (companyPageId) props.Company = { relation: [{ id: companyPageId }] };
    Object.keys(props).forEach(k => props[k] === undefined && delete props[k]);
    return props;
  }

  async function upsertJob(j) {
    try {
      if (args.dryRun) {
        if (args.verbose) console.log('[DRY] Upsert job', j.id);
        return { action: 'dry', pageId: null };
      }
      const existing = await notionQueryById(NOTION_JOBS_DB_ID, j.id);
      const companyPageId = companyNotionIdByCompanyId[j.company_id] || null;
      const props = jobToProps(j, companyPageId);
      if (existing) {
        await notion.pages.update({ page_id: existing.id, properties: props });
        await sleep(RATE_DELAY_MS);
        summary.updated += 1;
        if (args.verbose) console.log('Updated job', j.id, '->', existing.id);
        return { action: 'updated', pageId: existing.id };
      } else {
        const created = await notion.pages.create({ parent: { database_id: NOTION_JOBS_DB_ID }, properties: props });
        await sleep(RATE_DELAY_MS);
        summary.created += 1;
        if (args.verbose) console.log('Created job', j.id, '->', created.id);
        return { action: 'created', pageId: created.id };
      }
    } catch (err) {
      summary.errors.push({ item: j.id, error: err.message || String(err) });
      console.error('Error upserting job', j.id, err.message || err);
      return { action: 'error' };
    }
  }

  if (!args.companiesOnly) {
    console.log(`Processing ${jobs.length} jobs`);
    for (const j of jobs) {
      const res = await upsertJob(j);
    }
  }

  // Summary
  console.log('\nNotion sync complete');
  console.log('Pages created/updated:', summary.created + summary.updated);
  console.log('Created:', summary.created, 'Updated:', summary.updated, 'Errors:', summary.errors.length);
  if (summary.errors.length > 0) console.error('Errors:', JSON.stringify(summary.errors, null, 2));
}

main().catch(err => {
  console.error('Fatal error:', err && err.message ? err.message : err);
  process.exit(1);
});
