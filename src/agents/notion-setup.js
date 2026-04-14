#!/usr/bin/env node
// One-time utility: provision required properties on the Companies and Jobs Notion databases.
// Safe to re-run — skips properties that already exist.
// Usage: node src/agents/notion-setup.js [--dry-run] [--verbose]

const { Client } = require('@notionhq/client');
const config = require('../config');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const RATE_DELAY_MS = 350;

// Property definitions for each database.
// type: Notion property type. Extra keys are type-specific config.
const COMPANIES_PROPERTIES = [
  { name: 'id',                       type: 'rich_text' },
  { name: 'Domain',                   type: 'url' },
  { name: 'Latest Stage',             type: 'select' },
  { name: 'Total Raised ($M)',        type: 'number' },
  { name: 'Latest Round Size ($M)',   type: 'number' },
  { name: 'Profile Description',      type: 'rich_text' },
  { name: 'Sector',                   type: 'select' },
  { name: 'HQ',                       type: 'rich_text' },
  { name: 'Employees',                type: 'number' },
  { name: 'Careers Page',             type: 'url' },
  { name: 'ATS Platform',             type: 'select' },
  { name: 'Dormant',                  type: 'checkbox' },
  { name: 'Consecutive Empty Scrapes', type: 'number' },
];

const JOBS_PROPERTIES = [
  { name: 'id',                       type: 'rich_text' },
  { name: 'Job Title Normalized',     type: 'rich_text' },
  { name: 'Source URL',               type: 'url' },
  { name: 'Location Raw',             type: 'rich_text' },
  { name: 'Employment Type',          type: 'select' },
  { name: 'Description',              type: 'rich_text' },
  { name: 'Description Hash',         type: 'rich_text' },
  { name: 'First Seen',               type: 'date' },
  { name: 'Last Seen',                type: 'date' },
  { name: 'Removed At',               type: 'date' },
  { name: 'Days Live',                type: 'number' },
  { name: 'Job Function',             type: 'select' },
  { name: 'Seniority Level',          type: 'select' },
  { name: 'Location Type',            type: 'select' },
  { name: 'MBA Relevance Score',      type: 'number' },
  { name: 'Description Summary',      type: 'rich_text' },
  { name: 'Climate Relevance Confirmed', type: 'checkbox' },
  { name: 'Climate Relevance Reason', type: 'rich_text' },
  { name: 'Enrichment Prompt Version', type: 'rich_text' },
  // Company relation is added separately after we know the companies DB id
];

function buildPropertySchema(prop) {
  switch (prop.type) {
    case 'rich_text': return { rich_text: {} };
    case 'url':       return { url: {} };
    case 'number':    return { number: { format: 'number' } };
    case 'select':    return { select: {} };
    case 'checkbox':  return { checkbox: {} };
    case 'date':      return { date: {} };
    case 'relation':  return { relation: { database_id: prop.database_id, single_property: {} } };
    default: throw new Error(`Unknown property type: ${prop.type}`);
  }
}

async function provisionDatabase(notion, databaseId, label, properties) {
  // Fetch existing property names
  const db = await notion.databases.retrieve({ database_id: databaseId });
  await sleep(RATE_DELAY_MS);
  const existing = new Set(Object.keys(db.properties || {}).map(k => k.toLowerCase()));

  const toAdd = properties.filter(p => !existing.has(p.name.toLowerCase()));

  if (toAdd.length === 0) {
    console.log(`${label}: all properties already exist, nothing to add.`);
    return;
  }

  console.log(`${label}: adding ${toAdd.length} properties: ${toAdd.map(p => p.name).join(', ')}`);

  if (dryRun) {
    console.log(`[DRY] would update DB ${databaseId}`);
    return;
  }

  const propsPayload = {};
  for (const prop of toAdd) {
    propsPayload[prop.name] = buildPropertySchema(prop);
  }

  await notion.databases.update({
    database_id: databaseId,
    properties: propsPayload,
  });
  await sleep(RATE_DELAY_MS);
  console.log(`${label}: done.`);
}

async function main() {
  const { apiKey, companiesDbId, jobsDbId } = config.notion;
  if (!apiKey)         { console.error('Missing NOTION_API_KEY');         process.exit(1); }
  if (!companiesDbId)  { console.error('Missing NOTION_COMPANIES_DB_ID'); process.exit(1); }
  if (!jobsDbId)       { console.error('Missing NOTION_JOBS_DB_ID');      process.exit(1); }

  const notion = new Client({ auth: apiKey });

  // Provision Companies DB
  await provisionDatabase(notion, companiesDbId, 'Companies DB', COMPANIES_PROPERTIES);

  // Provision Jobs DB — include Company relation pointing at Companies DB
  const jobsProps = [
    ...JOBS_PROPERTIES,
    { name: 'Company', type: 'relation', database_id: companiesDbId },
  ];
  await provisionDatabase(notion, jobsDbId, 'Jobs DB', jobsProps);

  console.log('\nSetup complete. Run notion-sync.js to populate data.');
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
