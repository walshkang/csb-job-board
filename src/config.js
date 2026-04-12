// Central config for all agents.
// Controls which API keys and models each agent uses.
// Override any value in .env.local — per-agent vars take precedence over globals.
//
// .env.local keys:
//   ANTHROPIC_API_KEY        — shared Anthropic key (all Claude agents)
//   GEMINI_API_KEY           — shared Gemini key (OCR agent)
//   NOTION_API_KEY           — Notion integration
//
//   Per-agent model overrides (uncomment in .env.local to switch):
//   OCR_MODEL                — default: gemini-2.5-flash-lite
//   DISCOVERY_MODEL          — default: claude-haiku-4-5-20251001
//   EXTRACTION_MODEL         — default: claude-sonnet-4-6
//   ENRICHMENT_MODEL         — default: claude-sonnet-4-6
//
//   Global fallbacks (apply to all agents unless overridden above):
//   ANTHROPIC_MODEL          — overrides all Claude agent defaults
//   GEMINI_MODEL             — overrides OCR default

const fs = require('fs');
const path = require('path');

// Load .env.local once, here, so agents don't need to do it themselves.
const envPath = path.join(__dirname, '../.env.local');
try {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
} catch { /* no .env.local, fine */ }

const cfg = {
  ocr: {
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.OCR_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  },
  discovery: {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.DISCOVERY_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  },
  extraction: {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.EXTRACTION_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  },
  enrichment: {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.ENRICHMENT_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  },
  notion: {
    apiKey: process.env.NOTION_API_KEY || null,
    companiesDbId: process.env.NOTION_COMPANIES_DB_ID || null,
    jobsDbId: process.env.NOTION_JOBS_DB_ID || null,
  },
};

module.exports = cfg;
