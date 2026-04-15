#!/usr/bin/env node
/*
OCR Agent (Slice 1)
- Usage: node src/agents/ocr.js <images_dir> [--dry-run]

Notes:
- This is scaffolded: real OCR via Gemini/Anthropic should be implemented in
  functions `callGeminiOCR` and `mapRowToCompanySchema` when API access is
  available. For now this script will create deterministic placeholder
  companies from filenames so you can validate the pipeline and merging logic.

Environment variables:
- GEMINI_API_KEY (optional)
- ANTHROPIC_API_KEY (optional)
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const USAGE = `Usage: node src/agents/ocr.js <images_dir> [--dry-run]`;

function slugify(str) {
  return str
    .toString()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '-');
}

function deterministicId(str) {
  const hash = crypto.createHash('sha1').update(str).digest('hex').slice(0,10);
  return `${slugify(str)}-${hash}`;
}

function readArgs() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }
  const imagesDir = argv[0];
  const dryRun = argv.includes('--dry-run');
  return { imagesDir, dryRun };
}

async function listImages(dir) {
  const exts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tiff']);
  try {
    const items = await fs.promises.readdir(dir);
    return items
      .filter(f => exts.has(path.extname(f).toLowerCase()))
      .map(f => path.join(dir, f));
  } catch (err) {
    console.error('Error reading images directory:', err.message);
    return [];
  }
}

// Call Gemini 2.5 Flash-Lite Vision API to OCR a Pitchbook screenshot.
// Returns an array of row objects keyed by column headers (as shown in the image).
// Expected Pitchbook columns: "Companies (N)", "Website", "Employees",
//   "Last Financing Date", "Last Financing Deal Type", "Last Financing Size",
//   "Total Raised", "HQ Location"
// NOTE: The first column header will contain the row count, e.g. "Companies (1,480)".
//   mapRowToCompanySchema handles this with a regex match.
// Robustly extract a JSON array or object from an LLM response.
// Strips markdown fences, finds the outermost [ ] or { }, fixes trailing commas.
function parseJSONResponse(text) {
  if (!text) throw new Error('Empty response from OCR model');
  let s = text.replace(/```(?:json)?/g, '\n').trim();

  // try array first
  const fa = s.indexOf('['), la = s.lastIndexOf(']');
  if (fa !== -1 && la > fa) {
    const c = s.slice(fa, la + 1);
    try { return JSON.parse(c); } catch (_) {
      const fixed = c.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');
      try { return JSON.parse(fixed); } catch (_2) { /* fall through */ }
    }
  }

  // try object
  const fo = s.indexOf('{'), lo = s.lastIndexOf('}');
  if (fo !== -1 && lo > fo) {
    const c = s.slice(fo, lo + 1);
    try { return JSON.parse(c); } catch (_) {
      const fixed = c.replace(/,\s*}/g, '}');
      try { return JSON.parse(fixed); } catch (_2) { /* fall through */ }
    }
  }

  throw new Error('No JSON found in OCR response. Raw (truncated): ' + text.slice(0, 300));
}

async function callGeminiOCR(imagePath) {
  if (process.env.GEMINI_API_KEY) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: config.ocr.model });
    const imageData = fs.readFileSync(imagePath).toString('base64');
    const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const promptText = fs.readFileSync(path.join(__dirname, '../prompts/ocr.txt'), 'utf8');
    const result = await model.generateContent([
      { inlineData: { data: imageData, mimeType } },
      promptText
    ]);
    const raw = result.response.text().trim();
    return parseJSONResponse(raw);
  }

  // Fallback placeholder: derive a fake row from filename so the pipeline runs.
  const base = path.basename(imagePath, path.extname(imagePath));
  const parts = base.split(/[_\s-]+/).slice(0, 4);
  const name = parts.join(' ');
  return [
    {
      'Companies (placeholder)': name || base,
      'Website': name ? `${slugify(name)}.com` : null,
      'Employees': null,
      'Last Financing Date': null,
      'Last Financing Deal Type': null,
      'Last Financing Size': null,
      'Total Raised': null,
      'HQ Location': null,
    }
  ];
}

// Resolve company name from Pitchbook column headers.
// Pitchbook exports the column as "Companies (N,NNN)" with the count embedded.
function resolveCompanyName(row) {
  // Try exact key first, then fuzzy match for Pitchbook's count-suffixed header
  if (row['Company Name']) return row['Company Name'];
  if (row['name']) return row['name'];
  const key = Object.keys(row).find(k => /^companies/i.test(k));
  return key ? row[key] : 'unknown';
}

// Map a Pitchbook row to the Company schema.
// Handles actual Pitchbook export columns:
//   Companies (N), Website, Employees, Last Financing Date,
//   Last Financing Deal Type, Last Financing Size, Total Raised, HQ Location
async function mapRowToCompanySchema(row) {
  // Strip trailing '?' from any string cell produced by OCR and set an uncertainty flag
  let ocr_uncertain = false;
  const cleanRow = {};
  for (const k of Object.keys(row)) {
    let v = row[k];
    if (typeof v === 'string') {
      if (v.trim().endsWith('?')) {
        ocr_uncertain = true;
        v = v.replace(/\?+$/g, '').trim();
      } else {
        v = v.trim();
      }
    }
    cleanRow[k] = v;
  }

  const name = resolveCompanyName(cleanRow);
  const domainRaw = cleanRow['Website'] || cleanRow['website'] || null;
  const domain = domainRaw ? domainRaw.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
  const id = domain ? slugify(domain) : deterministicId(name);

  const funding_signals = [];
  const date = cleanRow['Last Financing Date'] || null;
  const dealType = cleanRow['Last Financing Deal Type'] || null;
  const size = cleanRow['Last Financing Size'] || null;
  const totalRaised = cleanRow['Total Raised'] || null;
  if (date || dealType || size) {
    funding_signals.push({
      date,
      deal_type: dealType,
      size_mm: size ? parseFloat(String(size).replace(/[^0-9.]/g, '')) || null : null,
      total_raised_mm: totalRaised ? parseFloat(String(totalRaised).replace(/[^0-9.]/g, '')) || null : null,
    });
  }

  const company_profile = {
    sector: cleanRow['Sector'] || null,
    description: cleanRow['Description'] || null,
    keywords: cleanRow['Keywords'] || null,
    hq: cleanRow['HQ Location'] || cleanRow['HQ'] || null,
    employees: cleanRow['Employees'] ? parseInt(String(cleanRow['Employees']).replace(/[^0-9]/g, ''), 10) || null : null,
  };

  return {
    id,
    name,
    domain,
    funding_signals,
    company_profile,
    careers_page_url: null,
    ats_platform: null,
    ocr_uncertain,
  };
}

function mergeCompanies(existing = [], extracted = []) {
  const byDomain = new Map();
  const byId = new Map();
  for (const c of existing) {
    if (c.domain) byDomain.set(c.domain, c);
    byId.set(c.id, c);
  }

  const merged = [...existing];
  for (const c of extracted) {
    let target = null;
    if (c.domain && byDomain.has(c.domain)) {
      target = byDomain.get(c.domain);
    } else if (byId.has(c.id)) {
      target = byId.get(c.id);
    }

    if (target) {
      // shallow merge: prefer existing non-null fields
      target.name = target.name || c.name;
      target.domain = target.domain || c.domain;
      target.funding_signals = (target.funding_signals || []).concat(c.funding_signals || []);
      target.company_profile = Object.assign({}, c.company_profile || {}, target.company_profile || {});
      // keep careers_page_url and ats_platform from existing if present
    } else {
      merged.push(c);
      if (c.domain) byDomain.set(c.domain, c);
      byId.set(c.id, c);
    }
  }
  return merged;
}

// Validate that OCR rows look like a PitchBook company list.
// Returns { ok, warnings } — warnings are printed but do not abort the run.
function validatePitchbookRows(rows, imagePath) {
  const warnings = [];
  const label = path.basename(imagePath);

  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, warnings: [`[WARN] ${label}: OCR returned 0 rows — image may not be a PitchBook company list`] };
  }

  const keys = Object.keys(rows[0] || {}).map(k => k.toLowerCase());

  // Must have a company name column
  const hasCompanyCol = keys.some(k => /^companies/.test(k) || k === 'company name' || k === 'name');
  if (!hasCompanyCol) {
    warnings.push(`[WARN] ${label}: no "Companies" column detected — verify this is a PitchBook company list export`);
  }

  // Must have a website column (required for domain/id derivation)
  const hasWebsite = keys.some(k => k === 'website');
  if (!hasWebsite) {
    warnings.push(`[WARN] ${label}: no "Website" column detected — company IDs will fall back to name-based hashes`);
  }

  // Warn (not error) if Keywords column is absent — it may not be in older exports
  const hasKeywords = keys.some(k => k === 'keywords');
  if (!hasKeywords) {
    warnings.push(`[WARN] ${label}: no "Keywords" column detected — categorization quality will be lower; ensure screenshot uses the expected PitchBook column set`);
  }

  // Sanity check: if rows look like non-tabular data (all nulls) flag it
  const nonNullCells = rows.slice(0, 5).reduce((acc, r) => acc + Object.values(r).filter(v => v != null).length, 0);
  if (nonNullCells === 0) {
    warnings.push(`[WARN] ${label}: all sampled cells are null — image may be unreadable or not a data table`);
  }

  return { ok: warnings.length === 0, warnings };
}

async function loadExistingCompanies(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

async function saveCompanies(filePath, companies) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(companies, null, 2), 'utf8');
}

async function main() {
  const { imagesDir, dryRun } = readArgs();
  const images = await listImages(imagesDir);
  if (images.length === 0) {
    console.log('No images found in', imagesDir);
    return;
  }
  console.log(`Found ${images.length} image(s)`);

  const extractedCompanies = [];
  const failures = [];
  for (const img of images) {
    try {
      const rows = await callGeminiOCR(img);
      const { warnings } = validatePitchbookRows(rows, img);
      for (const w of warnings) console.warn(w);
      for (const row of rows) {
        try {
          const company = await mapRowToCompanySchema(row);
          extractedCompanies.push(company);
        } catch (err) {
          failures.push({ image: img, row, error: err.message });
          console.warn('Failed to map row for image', img, err.message);
        }
      }
    } catch (err) {
      failures.push({ image: img, error: err.message });
      console.warn('OCR failed for image', img, err.message);
    }
  }

  console.log(`Extracted ${extractedCompanies.length} company candidates (failures: ${failures.length})`);

  const outPath = path.join(process.cwd(), 'data', 'companies.json');
  const existing = await loadExistingCompanies(outPath);
  const merged = mergeCompanies(existing, extractedCompanies);

  if (dryRun) {
    console.log('Dry-run mode; not writing files. Sample output (up to 10):');
    console.log(JSON.stringify(merged.slice(0,10), null, 2));
  } else {
    await saveCompanies(outPath, merged);
    console.log(`Wrote ${merged.length} companies to ${outPath}`);
  }

  // Print sample of 10 for manual spot-check
  console.log('\nSample companies (up to 10):');
  console.log(JSON.stringify(merged.slice(0,10), null, 2));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
