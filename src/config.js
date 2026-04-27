// Central config for all agents.
// Controls which API keys and models each agent uses.
// Override any value in .env.local — per-agent vars take precedence over globals.
//
// .env.local keys:
//   GEMINI_API_KEY           — shared Gemini key (all LLM agents)
//   ANTHROPIC_API_KEY        — Anthropic key (optional; enables Anthropic provider)
//   NOTION_API_KEY           — Notion integration
//   NOTION_COMPANIES_DB_ID   — Notion database id (companies sync)
//   NOTION_JOBS_DB_ID        — Notion database id (jobs sync)
//
//   LLM_PROVIDER             — "gemini" | "anthropic" (auto-detects from available keys if omitted)
//
//   Per-agent model overrides (uncomment in .env.local to switch):
//   OCR_MODEL                — default: gemini-2.5-flash-lite  (Gemini provider)
//   OCR_ANTHROPIC_MODEL      — default: claude-haiku-4-5-20251001 (Anthropic provider)
//   OCR_PROVIDER             — "gemini" (default) | "anthropic"; auto-detects from available keys
//   OCR_PDF_BACKEND          — "tabula" (default) | "liteparse" (for Step 1 PDF parsing)
//   LITEPARSE_COMMAND        — default: lit (CLI name; override if installed elsewhere)
//   EXTRACTION_MODEL         — default: gemini-2.5-flash
//   EXTRACTION_ANTHROPIC_MODEL — default: claude-haiku-4-5-20251001
//   ENRICHMENT_MODEL         — default: gemini-2.5-flash
//   ENRICHMENT_ANTHROPIC_MODEL — default: claude-haiku-4-5-20251001
//   CATEGORIZER_ANTHROPIC_MODEL — default: claude-haiku-4-5-20251001
//   REVIEWER_ANTHROPIC_MODEL — default: claude-haiku-4-5-20251001
//
//   Global fallback (all agents unless overridden above):
//   GEMINI_MODEL             — overrides non-OCR defaults; OCR still prefers OCR_MODEL
//
//   Note: Anthropic (Claude Haiku) costs more per token than Gemini Flash-Lite.

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

// Global provider: explicit override → key-based detection → gemini default
const LLM_PROVIDER = process.env.LLM_PROVIDER
  || (process.env.GEMINI_API_KEY ? 'gemini'
    : process.env.ANTHROPIC_API_KEY ? 'anthropic'
    : 'gemini');

const cfg = {
  ocr: {
    geminiKey: process.env.GEMINI_API_KEY || null,
    anthropicKey: process.env.ANTHROPIC_API_KEY || null,
    // 'gemini' | 'anthropic' — auto-selects based on available keys if not explicit
    provider: process.env.OCR_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'gemini'),
    model: process.env.OCR_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    anthropicModel: process.env.OCR_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    pdfBackend: process.env.OCR_PDF_BACKEND || 'tabula',
    liteparseCommand: process.env.LITEPARSE_COMMAND || 'lit',
    // keep legacy apiKey alias so existing image OCR path still works
    get apiKey() { return this.geminiKey; },
  },
  extraction: {
    provider: process.env.EXTRACTION_PROVIDER || LLM_PROVIDER,
    geminiKey: process.env.GEMINI_API_KEY || null,
    anthropicKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.EXTRACTION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    anthropicModel: process.env.EXTRACTION_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    // legacy alias
    get apiKey() { return this.geminiKey; },
  },
  enrichment: {
    provider: process.env.ENRICHMENT_PROVIDER || LLM_PROVIDER,
    geminiKey: process.env.GEMINI_API_KEY || null,
    anthropicKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.ENRICHMENT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    anthropicModel: process.env.ENRICHMENT_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    fallbackModel: process.env.ENRICHMENT_FALLBACK_MODEL || 'gemini-1.5-flash',
    // legacy alias
    get apiKey() { return this.geminiKey; },
  },
  categorizer: {
    provider: process.env.CATEGORIZER_PROVIDER || LLM_PROVIDER,
    geminiKey: process.env.GEMINI_API_KEY || null,
    anthropicKey: process.env.ANTHROPIC_API_KEY || null,
    // categorizer historically piggybacks enrichment model; keep that as default
    model: process.env.CATEGORIZER_MODEL || process.env.ENRICHMENT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    anthropicModel: process.env.CATEGORIZER_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    // legacy alias
    get apiKey() { return this.geminiKey; },
  },
  reviewer: {
    provider: process.env.REVIEWER_PROVIDER || LLM_PROVIDER,
    geminiKey: process.env.GEMINI_API_KEY || null,
    anthropicKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.REVIEWER_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    anthropicModel: process.env.REVIEWER_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    // legacy alias
    get apiKey() { return this.geminiKey; },
  },
  notion: {
    apiKey: process.env.NOTION_API_KEY || null,
    companiesDbId: process.env.NOTION_COMPANIES_DB_ID || null,
    jobsDbId: process.env.NOTION_JOBS_DB_ID || null,
  },
  wrds: {
    host: 'wrds-pgdata.wharton.upenn.edu',
    port: 9737,
    username: process.env.WRDS_USERNAME || null,
    password: process.env.WRDS_PASSWORD || null,
    database: process.env.WRDS_DATABASE || 'wrds',
    schema: process.env.WRDS_SCHEMA || 'pitchbk',
    table: process.env.WRDS_TABLE || 'company',
  },
};

/**
 * Returns { provider, apiKey, model } for a named agent block.
 * Callers can pass this directly to callLLM / streamLLM.
 * Also accepts an optional fallbackModel field for enricher.
 */
cfg.resolveAgent = function resolveAgent(agentName) {
  const block = cfg[agentName];
  if (!block) throw new Error(`Unknown agent config block: ${agentName}`);
  const provider = block.provider || 'gemini';
  return {
    provider,
    apiKey: provider === 'anthropic' ? block.anthropicKey : block.geminiKey,
    model: provider === 'anthropic' ? block.anthropicModel : block.model,
    ...(block.fallbackModel ? { fallbackModel: block.fallbackModel } : {}),
  };
};

cfg.validateCompanies = function validateCompanies(companies) {
  const arr = Array.isArray(companies) ? companies : [];
  const filtered = arr.filter(c => {
    const id = c && c.id ? String(c.id).trim().toLowerCase() : '';
    const name = c && c.name ? String(c.name).trim() : '';
    if (!name) return false;
    if (id === 'example' || name.toLowerCase() === 'example') return false;
    return true;
  });
  const removed = arr.length - filtered.length;
  console.info(`[validateCompanies] removed ${removed} entries`);
  if (filtered.length === 0) throw new Error('[validateCompanies] No companies remain after validation');
  return filtered;
};

module.exports = cfg;
