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

const USAGE = `Usage:
  node src/agents/ocr.js <images_dir> [--dry-run] [--verbose]          # screenshot/image mode
  node src/agents/ocr.js <file.pdf>   [--dry-run] [--verbose]          # single PDF
  node src/agents/ocr.js <pdfs_dir>   [--dry-run] [--verbose]          # directory of PDFs`;

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
  const inputPath = argv[0];
  const dryRun = argv.includes('--dry-run');
  const verbose = argv.includes('--verbose');
  return { inputPath, dryRun, verbose };
}

// --- PDF pipeline ---

async function detectInputMode(inputPath) {
  const stat = await fs.promises.stat(inputPath);
  if (stat.isFile() && inputPath.toLowerCase().endsWith('.pdf')) return 'pdf';
  if (stat.isDirectory()) {
    const items = await fs.promises.readdir(inputPath);
    const hasPdfs = items.some(f => f.toLowerCase().endsWith('.pdf'));
    if (hasPdfs) return 'pdf-dir';
  }
  return 'images';
}

async function listPDFs(dir) {
  const items = await fs.promises.readdir(dir);
  return items
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => path.join(dir, f));
}

// Extract table data from a PitchBook PDF using Tabula (java-based).
// Returns an array of objects mapping column headers to cell values.
async function extractPitchbookTableTabula(pdfPath, verbose = false) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const exec = promisify(execFile);
  const tabulaJar = 'tabula.jar';

  // Helper function to execute Tabula and parse the brittle JSON output
  async function runTabula(pageRange, extraArgs = []) {
    // Use stream mode (-r) — PitchBook PDFs have no visible grid lines, so lattice mode (-g) returns nothing
    const args = ['-jar', tabulaJar, '-p', pageRange, '-f', 'JSON', '-r', ...extraArgs, pdfPath];
    try {
      const { stdout } = await exec('java', args);
      
      // Robust multi-block JSON recovery:
      // Tabula output can be fragmented or contain JVM noise between page arrays.
      // We find all top-level arrays/objects and merge them.
      const pageBlocks = [];
      let depth = 0;
      let start = -1;

      for (let i = 0; i < stdout.length; i++) {
        if (stdout[i] === '[') {
          if (depth === 0) start = i;
          depth++;
        } else if (stdout[i] === ']') {
          depth--;
          if (depth === 0 && start !== -1) {
            try {
              const block = JSON.parse(stdout.slice(start, i + 1));
              if (Array.isArray(block)) {
                // Tabula JSON is usually an array of page objects
                pageBlocks.push(...block.filter(item => item && (item.data || item.page)));
              } else if (block && (block.data || block.page)) {
                pageBlocks.push(block);
              }
            } catch (e) { /* ignore fragmented/invalid blocks */ }
            start = -1;
          }
        }
      }

      if (verbose && pageBlocks.length > 0) {
        console.log(`    [Tabula] Recovered ${pageBlocks.length} page(s) for range ${pageRange}`);
      }
      return pageBlocks;
    } catch (err) {
      return []; 
    }
  }

  try {
    // SEQUENTIAL PAGE EXTRACTION (stream mode, no coordinate cropping)
    // Stream mode works for PitchBook PDFs which have no visible grid lines.
    // We detect the header row by text scan and skip nav chrome by row index.
    const pages = [];
    let pIdx = 1;
    while (true) {
      const pageData = await runTabula(pIdx.toString());
      if (!pageData || pageData.length === 0) break;
      pages.push(...pageData);
      pIdx++;
      if (pIdx > 500) break;
    }

    if (pages.length === 0) {
      console.warn(`  [Tabula] No valid JSON extracted from ${path.basename(pdfPath)}.`);
      return [];
    }

    // HEADER SCAN: find the header row on page 1 by text content, note its row index.
    // PitchBook nav chrome sits above the table — we skip by row index, not coordinates.
    let globalHeaders = null; // Array of { text, left }
    let headerRowIndex = -1;  // row index within page 0's data array

    if (pages[0] && pages[0].data) {
      for (let i = 0; i < pages[0].data.length; i++) {
        const row = pages[0].data[i];
        const rowData = row.map(cell => (cell.text || '').trim());
        const nonBlank = rowData.filter(Boolean);
        if (nonBlank.length < 3) continue;

        const hasWebsite = rowData.some(text => /\bwebsite\b/i.test(text));
        const matchCount = [/\bwebsite\b/i, /\bhq\b/i, /companies/i, /\bemployees\b/i, /financing/i, /total raised/i]
          .reduce((acc, re) => acc + (rowData.some(text => re.test(text)) ? 1 : 0), 0);

        if (hasWebsite || matchCount >= 3) {
          globalHeaders = row.map(cell => ({
            text: (cell.text || '').trim(),
            left: cell.left
          })).filter(h => h.text);
          headerRowIndex = i;
          break;
        }
      }
    }

    if (verbose && globalHeaders) {
      console.log(`    [Header] Found at page-1 row ${headerRowIndex}: ${globalHeaders.map(h => h.text).join(' | ').slice(0, 120)}`);
    } else if (!globalHeaders) {
      console.warn(`    [Header] Could not find column headers in ${path.basename(pdfPath)}.`);
    }

    // DATA MAPPING: skip nav chrome (everything up to and including the header row on page 1)
    const allRows = [];
    for (let pIdx = 0; pIdx < pages.length; pIdx++) {
      const page = pages[pIdx];
      if (!page.data || page.data.length === 0) continue;

      let pageRows = 0;
      for (let rowI = 0; rowI < page.data.length; rowI++) {
        // Skip nav chrome and the header row itself on page 1
        if (pIdx === 0 && rowI <= headerRowIndex) continue;
        const row = page.data[rowI];

        const nonBlank = row.filter(cell => (cell.text || '').trim());
        if (nonBlank.length < 3) continue;

        // Skip the header row itself if it appears on this page
        const rowText = row.map(c => (c.text||'').trim()).join('');
        if (globalHeaders && rowText === globalHeaders.map(h => h.text).join('')) continue;

        const rowObj = {};
        if (globalHeaders) {
          // GEOMETRIC MAPPING: Map each cell to the closest header by 'left' coordinate
          for (const cell of row) {
            const cellText = (cell.text || '').trim();
            if (!cellText) continue;

            // Find the header with the closest 'left' coordinate
            let closestHeader = null;
            let minDistance = Infinity;

            for (const header of globalHeaders) {
              const distance = Math.abs(header.left - cell.left);
              if (distance < minDistance) {
                minDistance = distance;
                closestHeader = header;
              }
            }

            // Only map if the distance is reasonable (e.g., within 40 points)
            // This prevents "floaters" from mapping to distant columns.
            if (closestHeader && minDistance < 40) {
              // If multiple cells map to the same header (e.g. multi-line), append them
              if (rowObj[closestHeader.text]) {
                rowObj[closestHeader.text] += ' ' + cellText;
              } else {
                rowObj[closestHeader.text] = cellText;
              }
            }
          }

          const hasName = rowObj['Company Name'] || rowObj['name'] || Object.values(rowObj)[0];
          const hasWebsite = rowObj['Website'] || rowObj['website'];

          if ((hasName || hasWebsite) && Object.keys(rowObj).length >= 3) {
            allRows.push(rowObj);
            pageRows++;
          }
        }
      }
      
      if (verbose && pageRows > 0) {
        console.log(`    Page ${pIdx + 1}: ${pageRows} row(s)`);
      }
    }

    return allRows;
  } catch (err) {
    console.error(`  [Tabula] Failed to extract table from ${path.basename(pdfPath)}:`, err.message);
    throw err;
  }
}

async function processPDF(pdfPath, verbose = false) {
  const label = path.basename(pdfPath);
  console.log(`Processing PDF: ${label}`);

  try {
    const allRows = await extractPitchbookTableTabula(pdfPath, verbose);
    console.log(`  ${allRows.length} row(s) total extracted via Tabula`);
    return { allRows, failures: [] };
  } catch (err) {
    return { allRows: [], failures: [{ pdf: pdfPath, error: err.message }] };
  }
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
  // Strip any markdown code fence and optional language tag (```json, ```python, ``` etc.)
  let s = text.replace(/```[a-z]*/gi, '\n').trim();

  // try array first
  const fa = s.indexOf('['), la = s.lastIndexOf(']');
  if (fa !== -1 && la > fa) {
    const c = s.slice(fa, la + 1);
    try { return JSON.parse(c); } catch (_) {
      const fixed = c.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');
      try { return JSON.parse(fixed); } catch (_2) { /* fall through to partial recovery */ }
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

  // Partial recovery: response was truncated mid-array (or a string value looped infinitely).
  // First, cap any suspiciously long string values (> 1000 chars) — Gemini repetition loops
  // produce multi-kilobyte strings that prevent the brace scanner from finding closing braces.
  const capped = s.replace(/"([^"\\]|\\.){1001,}"/g, m => JSON.stringify(m.slice(1, 501) + '…'));

  if (fa !== -1 && fo !== -1) {
    const partial = [];
    let depth = 0, start = -1;
    for (let i = fa; i < capped.length; i++) {
      if (capped[i] === '{') { if (depth++ === 0) start = i; }
      else if (capped[i] === '}') {
        if (--depth === 0 && start !== -1) {
          try { partial.push(JSON.parse(capped.slice(start, i + 1))); } catch (_) {}
          start = -1;
        }
      }
    }
    if (partial.length > 0) {
      console.warn(`[WARN] OCR response truncated or looped — recovered ${partial.length} complete row(s).`);
      return partial;
    }
  }

  throw new Error('No JSON found in OCR response. Raw (first 500 chars): ' + text.slice(0, 500));
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

async function callAnthropicOCR(imagePath) {
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch {
    throw new Error('Anthropic provider selected but @anthropic-ai/sdk is not installed. Run: npm install @anthropic-ai/sdk');
  }
  const client = new Anthropic({ apiKey: config.ocr.anthropicKey });
  const imageData = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';
  const promptText = fs.readFileSync(path.join(__dirname, '../prompts/ocr.txt'), 'utf8');
  const msg = await client.messages.create({
    model: config.ocr.anthropicModel,
    max_tokens: 16000,
    messages: [{ role: 'user', content: [ { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } }, { type: 'text', text: promptText }, ], }],
  });
  return parseJSONResponse(msg.content[0].text);
}

// Resolve company name from Pitchbook column headers.
// Pitchbook Tabula output uses "#Companies (N,NNN)" as the column key,
// and each cell value is prefixed with the row number e.g. "42Acme Corp".
function resolveCompanyName(row) {
  if (row['Company Name']) return stripRowNumber(row['Company Name']);
  if (row['name']) return stripRowNumber(row['name']);
  // PitchBook column key starts with "#" then "Companies (N)"
  const key = Object.keys(row).find(k => /companies/i.test(k));
  return key ? stripRowNumber(row[key]) : 'unknown';
}

// PitchBook Tabula rows prepend the 1-based row number directly to the company name:
// "42Acme Corp" → "Acme Corp". Strip the leading digits.
function stripRowNumber(val) {
  if (typeof val !== 'string') return val;
  return val.replace(/^\d+/, '').trim();
}

// Map a Pitchbook row to the Company schema.
// Handles actual Pitchbook export columns:
//   Companies (N), Website, Employees, Last Financing Date,
//   Last Financing Deal Type, Last Financing Size, Total Raised, HQ Location
// Fuzzy column lookup: find the value for a canonical field regardless of
// exact key casing or minor naming variations returned by the LLM.
function resolveColumn(row, patterns) {
  const keys = Object.keys(row);
  for (const pat of patterns) {
    const re = typeof pat === 'string' ? new RegExp(`^${pat}$`, 'i') : pat;
    const match = keys.find(k => re.test(k.trim()));
    if (match && row[match] != null) return row[match];
  }
  return null;
}

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
  const domainRaw = resolveColumn(cleanRow, ['Website', 'website', 'Domain', 'URL']) ||
    cleanRow['Website'] || cleanRow['website'] || null;
  const domain = domainRaw
    ? domainRaw
        .replace(/^https?:\/\//, '')  // strip protocol
        .replace(/\/$/, '')            // strip trailing slash
        .replace(/[",;\s]+$/, '')      // strip CSV artifacts: trailing quotes, commas, semicolons
        .toLowerCase()
    : null;
  const id = domain ? slugify(domain) : deterministicId(name);

  const funding_signals = [];
  const date = resolveColumn(cleanRow, ['Last Financing Date', /financing.d(ate)?/i, /last.*date/i]);
  const dealType = resolveColumn(cleanRow, ['Last Financing Deal Type', /deal.type/i, /financing.deal/i, /last.*deal/i]);
  const size = resolveColumn(cleanRow, ['Last Financing Size', /financing.size/i, /last.*size/i, /round.size/i]);
  const totalRaised = resolveColumn(cleanRow, ['Total Raised', /total.raised/i, /cumulative/i]);
  if (date || dealType || size) {
    funding_signals.push({
      date,
      deal_type: dealType,
      size_mm: size ? parseFloat(String(size).replace(/[^0-9.]/g, '')) || null : null,
      total_raised_mm: totalRaised ? parseFloat(String(totalRaised).replace(/[^0-9.]/g, '')) || null : null,
    });
  }

  const employeesRaw = resolveColumn(cleanRow, ['Employees', 'Employee', 'Headcount', /^num.*employee/i]);
  const company_profile = {
    sector: resolveColumn(cleanRow, ['Sector', 'Industry', /primary.*pitchbook/i]),
    description: resolveColumn(cleanRow, ['Description', 'Summary']),
    keywords: resolveColumn(cleanRow, ['Keywords', 'Keyword', /pitchbook.*keyword/i, /keyword.*tag/i]),
    hq: resolveColumn(cleanRow, ['HQ Location', 'HQ', 'Location', 'Headquarters', /hq.*/i]),
    employees: employeesRaw ? parseInt(String(employeesRaw).replace(/[^0-9]/g, ''), 10) || null : null,
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

// Deduplicate funding signals by (deal_type, total_raised_mm).
// When two signals share the same key, keep the one with more non-null fields.
function dedupFundingSignals(signals) {
  const best = new Map();
  for (const s of signals) {
    const key = `${(s.deal_type || '').toLowerCase()}|${String(s.size_mm ?? '')}`;
    const prev = best.get(key);
    if (!prev) { best.set(key, s); continue; }
    // Prefer the entry with more non-null fields (e.g. has a date)
    const score = v => Object.values(v).filter(x => x != null).length;
    if (score(s) > score(prev)) best.set(key, s);
  }
  return [...best.values()];
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
      const combined = (target.funding_signals || []).concat(c.funding_signals || []);
      target.funding_signals = dedupFundingSignals(combined);
      const existingProfile = target.company_profile || {};
      const newProfile = c.company_profile || {};
      const mergedProfile = { ...newProfile };
      for (const [k, v] of Object.entries(existingProfile)) {
        if (v != null) mergedProfile[k] = v;
      }
      target.company_profile = mergedProfile;
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
    const companies = JSON.parse(raw);
    // Heal any duplicate funding_signals accumulated from prior runs
    for (const c of companies) {
      if (Array.isArray(c.funding_signals) && c.funding_signals.length > 1) {
        c.funding_signals = dedupFundingSignals(c.funding_signals);
      }
      // Heal domains with CSV artifacts from prior OCR runs
      if (c.domain && /[",;\s]+$/.test(c.domain)) {
        c.domain = c.domain.replace(/[",;\s]+$/, '');
      }
    }
    return companies;
  } catch (err) {
    return [];
  }
}

async function saveCompanies(filePath, companies) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(companies, null, 2), 'utf8');
}

async function rowsToCompanies(rows, label, failures) {
  const companies = [];
  for (const row of rows) {
    try {
      companies.push(await mapRowToCompanySchema(row));
    } catch (err) {
      failures.push({ source: label, row, error: err.message });
      console.warn(`Failed to map row from ${label}:`, err.message);
    }
  }
  return companies;
}

async function main() {
  const { inputPath, dryRun, verbose } = readArgs();
  const mode = await detectInputMode(inputPath);
  console.log(`Mode: ${mode} | Provider: ${config.ocr.provider} | Model: ${mode === 'images' ? config.ocr.model : (config.ocr.provider === 'anthropic' ? config.ocr.anthropicModel : config.ocr.model)}`);

  const extractedCompanies = [];
  const failures = [];

  if (mode === 'images') {
    // --- existing image / screenshot path ---
    const images = await listImages(inputPath);
    if (images.length === 0) { console.log('No images found in', inputPath); return; }
    console.log(`Found ${images.length} image(s)`);
    for (const img of images) {
      try {
        const ocrFn = config.ocr.provider === 'anthropic' ? callAnthropicOCR : callGeminiOCR;
        const rows = await ocrFn(img);
        const { warnings } = validatePitchbookRows(rows, img);
        for (const w of warnings) console.warn(w);
        if (verbose && rows.length > 0) {
          const preview = rows.slice(0, 3).map(r => r['Company Name'] || r['name'] || '?').join(', ');
          console.log(`  ${path.basename(img)}: ${rows.length} row(s) — ${preview}${rows.length > 3 ? '...' : ''}`);
        }
        extractedCompanies.push(...await rowsToCompanies(rows, img, failures));
      } catch (err) {
        failures.push({ image: img, error: err.message });
        console.warn('OCR failed for image', img, err.message);
      }
    }
  } else {
    // --- PDF path ---
    const pdfs = mode === 'pdf' ? [inputPath] : await listPDFs(inputPath);
    if (pdfs.length === 0) { console.log('No PDFs found in', inputPath); return; }
    console.log(`Found ${pdfs.length} PDF(s)`);
    for (const pdf of pdfs) {
      const { allRows, failures: pdfFailures } = await processPDF(pdf, verbose);
      failures.push(...pdfFailures);
      extractedCompanies.push(...await rowsToCompanies(allRows, path.basename(pdf), failures));
    }
  }

  console.log(`Extracted ${extractedCompanies.length} company candidates (failures: ${failures.length})`);

  const outPath = path.join(process.cwd(), 'data', 'companies.json');
  const existing = await loadExistingCompanies(outPath);
  const merged = mergeCompanies(existing, extractedCompanies);

  if (dryRun) {
    console.log('Dry-run mode; not writing files. Sample output (up to 10):');
    console.log(JSON.stringify(merged.slice(0, 10), null, 2));
  } else {
    await saveCompanies(outPath, merged);
    console.log(`Wrote ${merged.length} companies to ${outPath}`);
  }

  console.log('\nSample companies (up to 10):');
  console.log(JSON.stringify(merged.slice(0, 10), null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(2);
  });
}

module.exports = {
  extractPitchbookTableTabula,
  processPDF,
  rowsToCompanies,
  mergeCompanies,
  mapRowToCompanySchema
};
