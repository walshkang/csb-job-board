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

// Placeholder OCR implementation: returns an array of row objects.
// Replace this with a real call to Gemini 2.5 Flash-Lite Vision API.
async function callGeminiOCR(imagePath) {
  // If GEMINI_API_KEY is set, you can implement a real API call here.
  // For now, return a best-effort extraction from filename.
  const base = path.basename(imagePath, path.extname(imagePath));
  // Try to split by underscores or spaces into pseudo-columns
  const parts = base.split(/[_\s-]+/).slice(0,4);
  const name = parts.join(' ');
  return [
    {
      'Company Name': name || base,
      'Website': (name ? `${slugify(name)}.com` : null),
      'Funding': null,
      'Sector': null
    }
  ];
}

// Placeholder mapping using simple heuristics. Replace with LLM mapping call.
async function mapRowToCompanySchema(row) {
  const name = row['Company Name'] || row.name || 'unknown';
  const domainRaw = row['Website'] || row.website || null;
  const domain = domainRaw ? domainRaw.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
  const id = domain ? slugify(domain) : deterministicId(name);
  const funding_signals = [];
  if (row['Funding'] && row['Funding'] !== '-') {
    funding_signals.push({ raw: row['Funding'] });
  }
  const company_profile = {
    sector: row['Sector'] || null,
    description: row['Description'] || null,
    hq: row['HQ'] || null,
    employees: row['Employees'] || null
  };
  return {
    id,
    name,
    domain,
    funding_signals,
    company_profile,
    careers_page_url: null,
    ats_platform: null
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
