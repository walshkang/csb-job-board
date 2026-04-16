#!/usr/bin/env node
// Notion sync for Companies and Jobs
// Usage: node src/agents/notion-sync.js [--companies-only] [--jobs-only] [--dry-run] [--verbose]

const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');
const config = require('../config');
const { startRun, endRun } = require('../utils/run-log');

// Canonical -> list of alias display names to try when resolving Notion DB properties.
// Add common variants used across teams. Matching is case-insensitive; exact canonical name is always tried first.
const COMPANY_CANONICAL_ALIASES = {
  // Companies DB
  'Name': ['Name', 'Company', 'Company Name'],
  'id': ['id', 'ID'],
  'Domain': ['Domain', 'Website', 'URL'],
  'Latest Stage': ['Latest Stage', 'Stage', 'Deal Type'],
  'Total Raised ($M)': ['Total Raised ($M)', 'Total Raised'],
  'Latest Round Size ($M)': ['Latest Round Size ($M)', 'Round Size'],
  'Profile Description': ['Profile Description', 'Company Description', 'Description'],
  'Sector': ['Sector', 'Industry'],
  'HQ': ['HQ', 'Headquarters', 'Headquarter'],
  'Employees': ['Employees', 'Headcount', 'Team Size'],
  'Careers Page': ['Careers Page', 'Careers', 'Jobs Page', 'Careers URL'],
  'ATS Platform': ['ATS Platform', 'ATS'],
  'Dormant': ['Dormant', 'Inactive'],
  'Consecutive Empty Scrapes': ['Consecutive Empty Scrapes', 'Empty Scrapes'],
  'Climate Tech Category': ['Climate Tech Category', 'Climate Category', 'Category'],
  'Primary Sector': ['Primary Sector', 'Sector Primary'],
  'Opportunity Area': ['Opportunity Area', 'Opportunity'],
  'Category Confidence': ['Category Confidence', 'Confidence'],
};

const JOB_CANONICAL_ALIASES = {
  // Jobs DB
  'Title': ['Title', 'Name'],
  'Job Title Normalized': ['Job Title Normalized', 'Title Normalized', 'Job Title'],
  'Source URL': ['Source URL', 'Source', 'URL'],
  'Location Raw': ['Location Raw', 'Location'],
  'Employment Type': ['Employment Type', 'Employment'],
  'Description': ['Description', 'Job Description'],
  'Description Hash': ['Description Hash', 'Desc Hash'],
  'First Seen': ['First Seen', 'First Seen At', 'Created At'],
  'Last Seen': ['Last Seen', 'Last Seen At', 'Updated At'],
  'Removed At': ['Removed At', 'Removed'],
  'Days Live': ['Days Live', 'Days'],
  'Job Function': ['Job Function', 'Function'],
  'Seniority Level': ['Seniority Level', 'Seniority'],
  'Location Type': ['Location Type'],
  'MBA Relevance Score': ['MBA Relevance Score', 'MBA Score'],
  'Description Summary': ['Description Summary', 'Summary'],
  'Climate Relevance Confirmed': ['Climate Relevance Confirmed', 'Climate Relevance'],
  'Climate Relevance Reason': ['Climate Relevance Reason', 'Climate Reason'],
  'Enrichment Prompt Version': ['Enrichment Prompt Version', 'Enrichment Version'],
  'Company': ['Company', 'Company Relation', 'Company Link'],
};


async function getDatabasePropertyNames(notionClient, databaseId, RATE_DELAY_MS) {
  try {
    const db = await notionClient.databases.retrieve({ database_id: databaseId });
    await sleep(RATE_DELAY_MS);
    return Object.keys(db.properties || {});
  } catch (err) {
    console.warn(`Notion sync: could not retrieve properties for DB ${databaseId}:`, err && err.message ? err.message : err);
    return [];
  }
}

function resolvePropertyName(canonical, dbPropNames, aliases) {
  if (!dbPropNames || dbPropNames.length === 0) return null;
  const lowerMap = Object.create(null);
  for (const n of dbPropNames) lowerMap[n.toLowerCase()] = n;
  // exact canonical
  if (lowerMap[canonical.toLowerCase()]) return lowerMap[canonical.toLowerCase()];
  // aliases
  const aliasList = Array.isArray(aliases) && aliases.length ? aliases : [canonical];
  for (const a of aliasList) {
    if (lowerMap[a.toLowerCase()]) return lowerMap[a.toLowerCase()];
  }
  // try loose match: remove spaces and compare
  const canonicalNoSpace = canonical.replace(/\s+/g, '').toLowerCase();
  for (const n of dbPropNames) {
    if (n.replace(/\s+/g, '').toLowerCase() === canonicalNoSpace) return n;
  }
  return null;
}

function buildResolvedNameMap(dbPropNames, databaseId, warnedMissingProps, aliases) {
  const map = {};
  for (const canonical of Object.keys(aliases)) {
    const resolved = resolvePropertyName(canonical, dbPropNames, aliases[canonical]);
    map[canonical] = resolved;
    if (!resolved) {
      const key = `${databaseId}::${canonical}`;
      if (!warnedMissingProps.has(key)) {
        console.warn(`Notion sync: property "${canonical}" not found in DB ${databaseId}; skipping that property for this DB.`);
        warnedMissingProps.add(key);
      }
    }
  }
  return map;
}

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
  const run = startRun('notion-sync');
  const args = readArgs();
  const { apiKey: NOTION_API_KEY, companiesDbId: NOTION_COMPANIES_DB_ID, jobsDbId: NOTION_JOBS_DB_ID } = config.notion;

  if (!NOTION_API_KEY || (!NOTION_COMPANIES_DB_ID && !args.jobsOnly) || (!NOTION_JOBS_DB_ID && !args.companiesOnly)) {
    console.log('Missing NOTION_API_KEY or NOTION_COMPANIES_DB_ID/NOTION_JOBS_DB_ID. Set env vars or .env.local. Exiting.');
    process.exit(0);
  }

  const notion = new Client({ auth: NOTION_API_KEY });
  // Simple fixed delay to respect ~3 req/s limit
  const RATE_DELAY_MS = 350;

  const warnedMissingProps = new Set(); // keys: `${databaseId}::${canonical}`
  let resolvedNameMapCompanies = null;
  let resolvedNameMapJobs = null;

  const dataDir = path.join(__dirname, '../../data');
  const companiesPath = path.join(dataDir, 'companies.json');
  const jobsPath = path.join(dataDir, 'jobs.json');

  let companies = await readJsonSafe(companiesPath);
  try {
    companies = config.validateCompanies(companies);
  } catch (err) {
    console.error('Company validation failed:', err.message);
    process.exit(1);
  }
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

  function normalizeSelectName(name) {
    if (!name) return name;
    const s = String(name);
    if (s === 'Food, Ag & Nature') return 'Food / Ag & Nature';
    if (s === 'Carbon Capture, Utilization, & Storage') return 'Carbon Capture / Utilization / Storage';
    if (s === 'Low-Emissions Chemicals & Plastics, Cross-Cutting Solutions') return 'Low-Emissions Chemicals & Plastics / Cross-Cutting Solutions';
    return s;
  }

  function companyToProps(c, resolvedNameMap, databaseId) {
    const canonicalProps = {
      'Name': { title: [{ text: { content: c.name || '' } }] },
      'id': { rich_text: [{ text: { content: String(c.id) } }] },
      'Domain': c.domain ? { url: c.domain } : undefined,
      'Latest Stage': (() => { const f = Array.isArray(c.funding_signals) && c.funding_signals[0]; return f && f.deal_type ? { select: { name: String(f.deal_type) } } : undefined; })(),
      'Total Raised ($M)': (() => { const f = Array.isArray(c.funding_signals) && c.funding_signals[0]; return f && typeof f.total_raised_mm === 'number' ? { number: f.total_raised_mm } : undefined; })(),
      'Latest Round Size ($M)': (() => { const f = Array.isArray(c.funding_signals) && c.funding_signals[0]; return f && typeof f.size_mm === 'number' ? { number: f.size_mm } : undefined; })(),
      'Profile Description': c.company_profile && c.company_profile.description ? { rich_text: [{ text: { content: truncate(c.company_profile.description, 2000) } }] } : undefined,
      'Sector': c.company_profile && c.company_profile.sector ? { select: { name: normalizeSelectName(c.company_profile.sector) } } : undefined,
      'HQ': c.company_profile && c.company_profile.hq ? { rich_text: [{ text: { content: String(c.company_profile.hq) } }] } : undefined,
      'Employees': c.company_profile && typeof c.company_profile.employees === 'number' ? { number: c.company_profile.employees } : undefined,
      'Careers Page': c.careers_page_url ? { url: c.careers_page_url } : undefined,
      'ATS Platform': c.ats_platform ? { select: { name: normalizeSelectName(c.ats_platform) } } : undefined,
      'Dormant': typeof c.dormant === 'boolean' ? { checkbox: c.dormant } : undefined,
      'Consecutive Empty Scrapes': typeof c.consecutive_empty_scrapes === 'number' ? { number: c.consecutive_empty_scrapes } : undefined,
      'Climate Tech Category': c.climate_tech_category ? { select: { name: normalizeSelectName(c.climate_tech_category) } } : undefined,
      'Primary Sector': c.primary_sector ? { select: { name: normalizeSelectName(c.primary_sector) } } : undefined,
      'Opportunity Area': c.opportunity_area ? { select: { name: normalizeSelectName(c.opportunity_area) } } : undefined,
      'Category Confidence': c.category_confidence ? { select: { name: normalizeSelectName(c.category_confidence) } } : undefined,
    };
    const props = {};
    for (const [canonical, val] of Object.entries(canonicalProps)) {
      if (val === undefined) continue; // skip undefined canonical values
      const resolvedName = resolvedNameMap && resolvedNameMap[canonical] ? resolvedNameMap[canonical] : null;
      if (!resolvedName) continue; // skip if not present in DB
      props[resolvedName] = val;
    }
    return props;
  }

  async function upsertCompany(c) {
    try {
      if (args.dryRun) {
        if (args.verbose) console.log('[DRY] Upsert company', c.id);
        return { action: 'dry', pageId: null };
      }
      const existing = await notionQueryById(NOTION_COMPANIES_DB_ID, c.id);
      const props = companyToProps(c, resolvedNameMapCompanies, NOTION_COMPANIES_DB_ID);
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

  // Prepare resolved name maps for Notion DBs (cached per run). This fetches the DB property schema
  // and builds a canonical -> actual display name mapping using CANONICAL_PROPERTY_ALIASES.
  if (NOTION_COMPANIES_DB_ID) {
    const companyDbProps = await getDatabasePropertyNames(notion, NOTION_COMPANIES_DB_ID, RATE_DELAY_MS);
    resolvedNameMapCompanies = buildResolvedNameMap(companyDbProps, NOTION_COMPANIES_DB_ID, warnedMissingProps, COMPANY_CANONICAL_ALIASES);
  } else {
    resolvedNameMapCompanies = {};
  }
  if (NOTION_JOBS_DB_ID) {
    const jobsDbProps = await getDatabasePropertyNames(notion, NOTION_JOBS_DB_ID, RATE_DELAY_MS);
    resolvedNameMapJobs = buildResolvedNameMap(jobsDbProps, NOTION_JOBS_DB_ID, warnedMissingProps, JOB_CANONICAL_ALIASES);
  } else {
    resolvedNameMapJobs = {};
  }

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

  function jobToProps(j, resolvedNameMap, databaseId, companyPageId) {
    const canonicalProps = {
      'Title': { title: [{ text: { content: j.job_title_raw || (j.job_title_normalized || '') } }] },
      'id': { rich_text: [{ text: { content: String(j.id) } }] },
      'Job Title Normalized': j.job_title_normalized ? { rich_text: [{ text: { content: String(j.job_title_normalized) } }] } : undefined,
      'Source URL': j.source_url ? { url: j.source_url } : undefined,
      'Location Raw': j.location_raw ? { rich_text: [{ text: { content: String(j.location_raw) } }] } : undefined,
      'Employment Type': j.employment_type ? { select: { name: String(j.employment_type) } } : undefined,
      'Description': j.description_raw ? { rich_text: [{ text: { content: truncate(j.description_raw, 2000) } }] } : undefined,
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
    const props = {};
    for (const [canonical, val] of Object.entries(canonicalProps)) {
      if (val === undefined) continue;
      const resolvedName = resolvedNameMap && resolvedNameMap[canonical] ? resolvedNameMap[canonical] : null;
      if (!resolvedName) continue;
      props[resolvedName] = val;
    }
    // relation for company
    const companyResolvedName = resolvedNameMap && resolvedNameMap['Company'] ? resolvedNameMap['Company'] : null;
    if (companyPageId && companyResolvedName) props[companyResolvedName] = { relation: [{ id: companyPageId }] };
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
      const props = jobToProps(j, resolvedNameMapJobs, NOTION_JOBS_DB_ID, companyPageId);
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
  await endRun(run, { processed: summary.created + summary.updated, errors: summary.errors.length });
}

main().catch(err => {
  console.error('Fatal error:', err && err.message ? err.message : err);
  process.exit(1);
});
