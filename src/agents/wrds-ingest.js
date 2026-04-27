/**
 * WRDS Ingest Agent (Slice 3)
 *
 * Pulls company records from WRDS PitchBook (`pitchbk.company`) via SSH
 * tunnel, maps each row to the companies.json schema, and merges
 * new/updated records into `data/companies.json`.
 *
 * Owns: `data/companies.json` (WRDS-sourced fields only)
 * Reads: WRDS PostgreSQL (`pitchbk.company`)
 *
 * Usage:
 *   npm run wrds-ingest
 *   npm run wrds-ingest -- --dry-run
 *   npm run wrds-ingest -- --full --verbose
 *
 * Flags:
 *   --dry-run   Log what would happen without writing files
 *   --full      Ignore the high-water mark; re-ingest all records
 *   --verbose   Print extra debug output
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const wrdsPool = require('../utils/wrds-pool');
const {
  slugify,
  deterministicId,
  loadExistingCompanies,
  saveCompanies,
} = require('./ocr-utils');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const COMPANIES_PATH = path.resolve(__dirname, '..', '..', 'data', 'companies.json');
const FILTERS_PATH = path.resolve(__dirname, '..', '..', 'data', 'wrds-filters.json');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PAGE_LIMIT = 500;

/**
 * SQL columns to fetch from pitchbk.company.
 * Column names are plain-English per the WRDS variable reference.
 */
const COLUMNS = [
  'companyid',
  'companyname',
  'website',
  'description',
  'descriptionshort',
  'keywords',
  'emergingspaces',
  'verticals',
  'allindustries',
  'primaryindustrycode',
  'primaryindustrygroup',
  'primaryindustrysector',
  'employees',
  'hqlocation',
  'hqcity',
  'hqstate_province',
  'hqcountry',
  'yearfounded',
  'totalraised',
  'ownershipstatus',
  'lastfinancingdate',
  'lastfinancingsize',
  'lastfinancingdealtype',
  'lastupdated',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Splits a comma/pipe/semicolon-separated string into a trimmed string[].
 * Returns null when input is falsy or produces an empty array.
 */
function splitDelimited(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value
    .split(/[,;|]+/)
    .map(s => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

/**
 * Normalizes a raw website field to a bare domain.
 *   "https://www.example.com/about" → "www.example.com"
 */
function normalizeDomain(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let d = raw.trim();
  d = d.replace(/^https?:\/\//i, '');
  d = d.replace(/\/.*$/, '');
  d = d.replace(/\?.*$/, '');
  d = d.replace(/#.*$/, '');
  return d || null;
}

/**
 * Computes the high-water mark (latest `wrds_last_updated`) from existing
 * companies. Falls back to epoch if none have been ingested yet.
 */
function computeHighWaterMark(companies) {
  let max = '1970-01-01';
  for (const c of companies) {
    if (c.wrds_last_updated && c.wrds_last_updated > max) {
      max = c.wrds_last_updated;
    }
  }
  return max;
}

/**
 * Maps a raw WRDS row to the companies.json schema additions.
 */
function mapRowToCompanyFields(row) {
  const domain = normalizeDomain(row.website);
  const name = (row.companyname || '').trim() || 'unknown';
  const id = domain ? slugify(domain) : deterministicId(name);

  const emergingSpaces = splitDelimited(row.emergingspaces);
  const verticals = splitDelimited(row.verticals);
  const keywords = splitDelimited(row.keywords);
  const yearFounded = row.yearfounded != null ? Number(row.yearfounded) || null : null;
  const employees = row.employees != null ? Number(row.employees) || null : null;
  const totalRaised = row.totalraised != null ? Number(row.totalraised) || null : null;

  // Build funding signal from last financing data
  const fundingSignals = [];
  if (row.lastfinancingdate || row.lastfinancingsize || row.lastfinancingdealtype) {
    fundingSignals.push({
      date: row.lastfinancingdate ? String(row.lastfinancingdate) : null,
      deal_type: row.lastfinancingdealtype || null,
      size_mm: row.lastfinancingsize != null ? Number(row.lastfinancingsize) || null : null,
      total_raised_mm: totalRaised,
    });
  }

  // Build HQ string from structured fields
  const hqParts = [row.hqcity, row.hqstate_province, row.hqcountry].filter(Boolean);
  const hq = hqParts.length > 0 ? hqParts.join(', ') : (row.hqlocation || null);

  return {
    id,
    name,
    domain,
    funding_signals: fundingSignals,
    company_profile: {
      description: row.description || null,
      keywords: keywords || [],
      hq,
      employees,
      year_founded: yearFounded,
    },
    // WRDS-specific fields
    wrds_company_id: row.companyid || null,
    emerging_spaces: emergingSpaces,
    pitchbook_verticals: verticals,
    pitchbook_industry_code: row.primaryindustrycode || null,
    pitchbook_industry_group: row.primaryindustrygroup || null,
    pitchbook_industry_sector: row.primaryindustrysector || null,
    pitchbook_description: row.description || null,
    pitchbook_keywords: keywords,
    wrds_last_updated: row.lastupdated ? new Date(row.lastupdated).toISOString() : null,
    category_source: null, // Filled later by taxonomy-mapper
  };
}

/**
 * Merges WRDS-sourced company records into the existing list.
 * Uses domain as the primary dedup key, then id.
 * WRDS fields overwrite only when the incoming value is non-null.
 */
function mergeWrdsRecords(existing, incoming) {
  const byDomain = new Map();
  const byId = new Map();
  for (const c of existing) {
    if (c.domain) byDomain.set(c.domain.toLowerCase(), c);
    byId.set(c.id, c);
  }

  const merged = [...existing];
  let updated = 0;
  let added = 0;

  for (const inc of incoming) {
    let target = null;
    if (inc.domain && byDomain.has(inc.domain.toLowerCase())) {
      target = byDomain.get(inc.domain.toLowerCase());
    } else if (byId.has(inc.id)) {
      target = byId.get(inc.id);
    }

    if (target) {
      // Merge WRDS-specific fields (prefer incoming non-null values)
      const wrdsFields = [
        'wrds_company_id', 'emerging_spaces', 'pitchbook_verticals',
        'pitchbook_industry_code', 'pitchbook_industry_group',
        'pitchbook_industry_sector', 'pitchbook_description',
        'pitchbook_keywords', 'wrds_last_updated', 'category_source',
      ];
      for (const field of wrdsFields) {
        if (inc[field] != null) {
          target[field] = inc[field];
        }
      }
      // Merge company_profile sub-fields (prefer existing non-null)
      target.company_profile = target.company_profile || {};
      const incp = inc.company_profile || {};
      for (const key of Object.keys(incp)) {
        if (incp[key] != null && (target.company_profile[key] == null || target.company_profile[key] === '')) {
          target.company_profile[key] = incp[key];
        }
      }
      // Merge funding signals (append new ones)
      if (inc.funding_signals && inc.funding_signals.length > 0) {
        target.funding_signals = target.funding_signals || [];
        // Simple dedup by date+deal_type
        for (const sig of inc.funding_signals) {
          const exists = target.funding_signals.some(
            s => s.date === sig.date && s.deal_type === sig.deal_type
          );
          if (!exists) target.funding_signals.push(sig);
        }
      }
      // Name fallback
      target.name = target.name || inc.name;
      target.domain = target.domain || inc.domain;
      updated++;
    } else {
      merged.push(inc);
      if (inc.domain) byDomain.set(inc.domain.toLowerCase(), inc);
      byId.set(inc.id, inc);
      added++;
    }
  }

  return { merged, updated, added };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(opts = {}) {
  const dryRun = opts.dryRun || false;
  const verbose = opts.verbose || false;
  const full = opts.full || false;

  const wrds = config.wrds || {};
  if (!wrds.username || !wrds.password) {
    console.warn('[wrds-ingest] WRDS credentials not configured — skipping.');
    return { skipped: true, reason: 'no_credentials' };
  }

  // 1. Load existing companies
  const companies = await loadExistingCompanies(COMPANIES_PATH);
  if (verbose) console.log(`[wrds-ingest] Loaded ${companies.length} existing companies`);

  // 2. Compute high-water mark
  const hwm = full ? '1970-01-01' : computeHighWaterMark(companies);
  if (verbose) console.log(`[wrds-ingest] High-water mark: ${hwm}${full ? ' (--full override)' : ''}`);

  // 2b. Load dynamic filters
  let filters = {};
  try {
    filters = JSON.parse(await fs.promises.readFile(FILTERS_PATH, 'utf8'));
    if (verbose) console.log(`[wrds-ingest] Loaded filters from wrds-filters.json`);
  } catch (err) {
    if (verbose) console.log(`[wrds-ingest] No filters file found at ${FILTERS_PATH}, querying all records.`);
  }

  // 3. Connect to WRDS
  try {
    await wrdsPool.connect();
    if (verbose) console.log('[wrds-ingest] Connected to WRDS');
  } catch (err) {
    console.error(`[wrds-ingest] Connection failed: ${err.message}`);
    return { skipped: true, reason: 'connection_failed', error: err.message };
  }

  // 4. Paginated fetch using high-water mark
  let totalFetched = 0;
  let allIncoming = [];
  let currentHwm = hwm;
  let page = 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      page++;
      const schema = wrds.schema || 'pitchbk';
      const table = wrds.table || 'company';
      let whereClause = `WHERE lastupdated > $1`;
      const queryParams = [currentHwm];
      let paramIndex = 2;

      if (filters.ownership_status && filters.ownership_status.length > 0) {
        const placeholders = filters.ownership_status.map(() => `$${paramIndex++}`).join(', ');
        whereClause += ` AND ownershipstatus IN (${placeholders})`;
        queryParams.push(...filters.ownership_status);
      }

      if (filters.hq_country && filters.hq_country.length > 0) {
        const placeholders = filters.hq_country.map(() => `$${paramIndex++}`).join(', ');
        whereClause += ` AND hqcountry IN (${placeholders})`;
        queryParams.push(...filters.hq_country);
      }

      if (filters.verticals_contains && filters.verticals_contains.length > 0) {
        const conditions = filters.verticals_contains.map(() => `verticals ILIKE $${paramIndex++}`).join(' OR ');
        whereClause += ` AND (${conditions})`;
        queryParams.push(...filters.verticals_contains.map(v => `%${v}%`));
      }

      if (filters.max_employees != null) {
        whereClause += ` AND (employees IS NULL OR employees <= $${paramIndex++})`;
        queryParams.push(filters.max_employees);
      }

      if (filters.last_financing_date_min) {
        whereClause += ` AND lastfinancingdate >= $${paramIndex++}`;
        queryParams.push(filters.last_financing_date_min);
      }

      const sql = `
        SELECT ${COLUMNS.join(', ')}
        FROM ${schema}.${table}
        ${whereClause}
        ORDER BY lastupdated ASC
        LIMIT ${PAGE_LIMIT}
      `;

      if (verbose) console.log(`[wrds-ingest] Page ${page}: querying after ${currentHwm}...`);

      const result = await wrdsPool.query(sql, queryParams);
      const rows = result.rows || [];

      if (rows.length === 0) {
        if (verbose) console.log(`[wrds-ingest] Page ${page}: 0 rows — done.`);
        break;
      }

      totalFetched += rows.length;
      if (verbose) console.log(`[wrds-ingest] Page ${page}: ${rows.length} rows`);

      // Map rows to company schema
      const mapped = rows.map(mapRowToCompanyFields);
      allIncoming.push(...mapped);

      // Advance high-water mark to the last row's lastupdated
      const lastRow = rows[rows.length - 1];
      if (lastRow.lastupdated) {
        currentHwm = new Date(lastRow.lastupdated).toISOString();
      }

      // If we got fewer than PAGE_LIMIT, we've consumed all results
      if (rows.length < PAGE_LIMIT) break;
    }
  } finally {
    await wrdsPool.close();
    if (verbose) console.log('[wrds-ingest] Disconnected from WRDS');
  }

  console.log(`[wrds-ingest] Fetched ${totalFetched} records from WRDS`);

  if (allIncoming.length === 0) {
    console.log('[wrds-ingest] No new records to merge.');
    return { fetched: 0, added: 0, updated: 0 };
  }

  // 5. Merge
  const { merged, updated, added } = mergeWrdsRecords(companies, allIncoming);
  console.log(`[wrds-ingest] Merge result: ${added} new, ${updated} updated (total ${merged.length})`);

  // 6. Write
  if (dryRun) {
    console.log('[wrds-ingest] Dry-run — no files written.');
  } else {
    await saveCompanies(COMPANIES_PATH, merged);
    console.log('[wrds-ingest] Wrote data/companies.json');
  }

  return { fetched: totalFetched, added, updated };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const full = args.includes('--full');

  run({ dryRun, verbose, full })
    .then(result => {
      if (result.skipped) {
        console.log(`[wrds-ingest] Skipped: ${result.reason}`);
        process.exit(0);
      }
      console.log(`[wrds-ingest] Done: fetched=${result.fetched}, added=${result.added}, updated=${result.updated}`);
    })
    .catch(err => {
      console.error('[wrds-ingest] Fatal:', err);
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------
// Exports (for testing and orchestrator integration)
// ---------------------------------------------------------------------------
module.exports = {
  run,
  // Expose internals for unit testing
  splitDelimited,
  normalizeDomain,
  computeHighWaterMark,
  mapRowToCompanyFields,
  mergeWrdsRecords,
  COLUMNS,
  PAGE_LIMIT,
};
