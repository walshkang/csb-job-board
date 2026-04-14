#!/usr/bin/env node
// One-time utility: archive all pages in the Companies and Jobs Notion databases.
// Usage: node src/agents/notion-clear.js [--companies-only] [--jobs-only] [--dry-run]

const { Client } = require('@notionhq/client');
const config = require('../config');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const companiesOnly = args.includes('--companies-only');
const jobsOnly = args.includes('--jobs-only');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const RATE_DELAY_MS = 350;

async function archiveAll(notion, databaseId, label) {
  let archived = 0;
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    await sleep(RATE_DELAY_MS);
    for (const page of res.results) {
      if (dryRun) {
        console.log(`[DRY] would archive ${label} page ${page.id}`);
      } else {
        await notion.pages.update({ page_id: page.id, archived: true });
        await sleep(RATE_DELAY_MS);
        archived += 1;
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return archived;
}

async function main() {
  const { apiKey, companiesDbId, jobsDbId } = config.notion;
  if (!apiKey) { console.error('Missing NOTION_API_KEY'); process.exit(1); }

  const notion = new Client({ auth: apiKey });

  if (!jobsOnly && companiesDbId) {
    console.log('Clearing Companies DB...');
    const n = await archiveAll(notion, companiesDbId, 'company');
    console.log(dryRun ? 'Dry run — no changes.' : `Archived ${n} company pages.`);
  }

  if (!companiesOnly && jobsDbId) {
    console.log('Clearing Jobs DB...');
    const n = await archiveAll(notion, jobsDbId, 'job');
    console.log(dryRun ? 'Dry run — no changes.' : `Archived ${n} job pages.`);
  }
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
