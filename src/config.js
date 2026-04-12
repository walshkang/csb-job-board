// Central config for all agents.
// Controls which API keys and models each agent uses.
// Override any value in .env.local — per-agent vars take precedence over globals.
//
// .env.local keys:
//   GEMINI_API_KEY           — shared Gemini key (all LLM agents)
//   NOTION_API_KEY           — Notion integration
//   NOTION_COMPANIES_DB_ID   — Notion database id (companies sync)
//   NOTION_JOBS_DB_ID        — Notion database id (jobs sync)
//
//   Per-agent model overrides (uncomment in .env.local to switch):
//   OCR_MODEL                — default: gemini-2.5-flash-lite
//   DISCOVERY_MODEL          — default: gemini-2.5-flash
//   EXTRACTION_MODEL         — default: gemini-2.5-flash
//   ENRICHMENT_MODEL         — default: gemini-2.5-flash
//
//   Global fallback (all agents unless overridden above):
//   GEMINI_MODEL             — overrides non-OCR defaults; OCR still prefers OCR_MODEL

const fs = require('fs');
const path = require('path');

// Load .env.local once, here, so agents don't need to do it themselves.
const envPath = path.join(__dirname, '../.env.local');
try {
  let text = fs.readFileSync(envPath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
} catch { /* no .env.local, fine */ }

const cfg = {
  ocr: {
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.OCR_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  },
  discovery: {
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.DISCOVERY_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  extraction: {
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.EXTRACTION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  enrichment: {
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.ENRICHMENT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  notion: {
    apiKey: process.env.NOTION_API_KEY || null,
    companiesDbId: process.env.NOTION_COMPANIES_DB_ID || null,
    jobsDbId: process.env.NOTION_JOBS_DB_ID || null,
  },
};

module.exports = cfg;
