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

// Extract text per page from a PDF using pdftotext (poppler-utils).
// Falls back to a single-chunk extraction if -f/-l flags are unavailable.
async function extractPageTexts(pdfPath) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const exec = promisify(execFile);

  // Get page count first
  let nPages = 1;
  try {
    const { stdout } = await exec('pdfinfo', [pdfPath]);
    const m = stdout.match(/Pages:\s+(\d+)/);
    if (m) nPages = parseInt(m[1], 10);
  } catch { /* pdfinfo unavailable, fall back to single chunk */ }

  if (nPages === 1) {
    // Single extraction, split on form feed
    const { stdout } = await exec('pdftotext', ['-layout', pdfPath, '-']);
    return stdout.split('\f').map(p => p.trim()).filter(Boolean);
  }

  // Extract page by page so chunks stay manageable for the LLM
  const pages = [];
  for (let i = 1; i <= nPages; i++) {
    try {
      const { stdout } = await exec('pdftotext', ['-layout', '-f', String(i), '-l', String(i), pdfPath, '-']);
      const text = stdout.trim();
      if (text) pages.push(text);
    } catch (err) {
      console.warn(`  pdftotext failed on page ${i}: ${err.message}`);
    }
  }
  return pages;
}

// Send extracted page text to the configured provider for JSON parsing.
// Retries up to 4 times with exponential backoff on transient errors.
async function callTextModelOCR(pageText) {
  const promptText = fs.readFileSync(path.join(__dirname, '../prompts/ocr-pdf.txt'), 'utf8');
  const fullPrompt = promptText + '\n' + pageText;

  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 2000;

  function isRetryable(err) {
    const msg = String(err && err.message ? err.message : err);
    const status = err && err.status;
    return (
      /429|Too Many Requests/i.test(msg) ||
      /503|SERVICE_UNAVAILABLE/i.test(msg) ||
      /RESOURCE_EXHAUSTED/i.test(msg) ||
      /overloaded_error/i.test(msg) ||
      /rate_limit_error/i.test(msg) ||
      status === 429 || status === 503 || status === 529
    );
  }

  if (config.ocr.provider === 'anthropic' && config.ocr.anthropicKey) {
    let Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk'); } catch {
      throw new Error('Anthropic provider selected but @anthropic-ai/sdk is not installed. Run: npm install @anthropic-ai/sdk');
    }
    const client = new Anthropic({ apiKey: config.ocr.anthropicKey });
    let lastErr;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        const msg = await client.messages.create({
          model: config.ocr.anthropicModel,
          max_tokens: 32000,
          messages: [{ role: 'user', content: fullPrompt }],
        });
        return parseJSONResponse(msg.content[0].text);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || i === MAX_ATTEMPTS - 1) throw err;
        const waitMs = Math.min(120000, Math.ceil(BASE_DELAY_MS * Math.pow(2, i)));
        console.warn(`  [callTextModelOCR] retrying after ${waitMs}ms (attempt ${i + 1}): ${err.message}`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    throw lastErr;
  }

  // Default: Gemini — use responseSchema to enforce structured output and prevent truncation
  const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(config.ocr.geminiKey);
  const geminiModel = genAI.getGenerativeModel({ model: config.ocr.model });
  const geminiRequest = {
    contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
    generationConfig: {
      maxOutputTokens: 65536,
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            'Company Name':                    { type: SchemaType.STRING, nullable: true },
            'Website':                         { type: SchemaType.STRING, nullable: true },
            'Employees':                       { type: SchemaType.STRING, nullable: true },
            'Last Financing Date':             { type: SchemaType.STRING, nullable: true },
            'Last Financing Deal Type':        { type: SchemaType.STRING, nullable: true },
            'Last Financing Size':             { type: SchemaType.STRING, nullable: true },
            'Total Raised':                    { type: SchemaType.STRING, nullable: true },
            'HQ Location':                     { type: SchemaType.STRING, nullable: true },
            'Primary PitchBook Industry Code': { type: SchemaType.STRING, nullable: true },
          },
        },
      },
    },
  };
  let lastErr;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      const result = await geminiModel.generateContent(geminiRequest);
      return parseJSONResponse(result.response.text().trim());
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === MAX_ATTEMPTS - 1) throw err;
      const waitMs = Math.min(120000, Math.ceil(BASE_DELAY_MS * Math.pow(2, i)));
      console.warn(`  [callTextModelOCR] retrying after ${waitMs}ms (attempt ${i + 1}): ${err.message}`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// Validate that PDF-parsed rows look like PitchBook data.
function validatePDFRows(rows, label) {
  const warnings = [];
  if (!Array.isArray(rows) || rows.length === 0) return { warnings };
  const keys = Object.keys(rows[0] || {}).map(k => k.toLowerCase());
  if (!keys.some(k => k === 'company name' || k === 'name')) {
    warnings.push(`[WARN] ${label}: no "Company Name" column — verify PDF format`);
  }
  if (!keys.some(k => k === 'website')) {
    warnings.push(`[WARN] ${label}: no "Website" column — IDs will fall back to name-based hashes`);
  }
  return { warnings };
}

// Number of PDF pages to send per LLM call. Keeps prompts within token limits
// for large PitchBook exports (500+ companies). Override with PDF_CHUNK_SIZE env var.
const PDF_CHUNK_SIZE = parseInt(process.env.PDF_CHUNK_SIZE || '8', 10);

async function processPDF(pdfPath, verbose = false) {
  const label = path.basename(pdfPath);
  console.log(`Processing PDF: ${label}`);
  const pages = await extractPageTexts(pdfPath);

  // Split pages into chunks so each LLM call stays within output token limits.
  const chunks = [];
  for (let i = 0; i < pages.length; i += PDF_CHUNK_SIZE) {
    chunks.push(pages.slice(i, i + PDF_CHUNK_SIZE));
  }
  console.log(`  ${pages.length} page(s) extracted — processing in ${chunks.length} chunk(s) of up to ${PDF_CHUNK_SIZE} page(s) each`);

  const allRows = [];
  const failures = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunkText = chunks[ci].join('\n\n--- PAGE BREAK ---\n\n');
    try {
      const rows = await callTextModelOCR(chunkText);
      const { warnings } = validatePDFRows(rows, `${label} chunk ${ci + 1}/${chunks.length}`);
      for (const w of warnings) console.warn(w);
      if (verbose && rows.length > 0) {
        const preview = rows.slice(0, 3).map(r => r['Company Name'] || r['name'] || '?').join(', ');
        console.log(`  chunk ${ci + 1}/${chunks.length}: ${rows.length} row(s) — ${preview}${rows.length > 3 ? '...' : ''}`);
      } else {
        console.log(`  chunk ${ci + 1}/${chunks.length}: ${rows.length} row(s)`);
      }
      allRows.push(...rows);
    } catch (err) {
      console.warn(`  chunk ${ci + 1}/${chunks.length} failed: ${err.message}`);
      failures.push({ pdf: pdfPath, chunk: ci + 1, pages: `${ci * PDF_CHUNK_SIZE + 1}-${Math.min((ci + 1) * PDF_CHUNK_SIZE, pages.length)}`, error: err.message });
    }
  }

  console.log(`  ${allRows.length} row(s) total (${failures.length} chunk failure(s))`);
  return { allRows, failures };
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

  // Partial recovery: response was truncated mid-array — salvage complete objects.
  // Collect every well-formed {...} block from the truncated text.
  if (fa !== -1 && fo !== -1) {
    const partial = [];
    let depth = 0, start = -1;
    for (let i = fa; i < s.length; i++) {
      if (s[i] === '{') { if (depth++ === 0) start = i; }
      else if (s[i] === '}') {
        if (--depth === 0 && start !== -1) {
          try { partial.push(JSON.parse(s.slice(start, i + 1))); } catch (_) {}
          start = -1;
        }
      }
    }
    if (partial.length > 0) {
      console.warn(`[WARN] OCR response was truncated — recovered ${partial.length} complete row(s). Consider splitting the PDF into smaller batches.`);
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
  const domain = domainRaw
    ? domainRaw
        .replace(/^https?:\/\//, '')  // strip protocol
        .replace(/\/$/, '')            // strip trailing slash
        .replace(/[",;\s]+$/, '')      // strip CSV artifacts: trailing quotes, commas, semicolons
        .toLowerCase()
    : null;
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

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
