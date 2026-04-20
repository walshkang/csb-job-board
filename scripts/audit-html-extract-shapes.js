#!/usr/bin/env node
/**
 * Groups artifacts/html/{id}.html files that would hit LLM extraction (no sibling .json)
 * into coarse DOM/platform shapes. Gate for html-adapters work (shape-dehallucinate Slice 5).
 *
 * Usage: node scripts/audit-html-extract-shapes.js [--artifacts=path]
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ARTIFACTS = path.join(REPO_ROOT, 'artifacts', 'html');

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function isAuxiliaryArtifact(name) {
  return (
    name.endsWith('.playwright.html') ||
    name.endsWith('.homepage.html') ||
    name.endsWith('.careers.html')
  );
}

/** Canonical scrape artifact: exactly one dot before "html", e.g. foo.html */
function isCanonicalCompanyHtml(name) {
  if (!name.endsWith('.html') || isAuxiliaryArtifact(name)) return false;
  const base = name.slice(0, -'.html'.length);
  return !base.includes('.');
}

function classifyShape(html) {
  const slice = html.length > 2000000 ? html.slice(0, 2000000) : html;
  const lower = slice.toLowerCase();

  if (/^\s*<\?xml\s/i.test(slice.trim().slice(0, 200)) || /<urlset[\s\n]/i.test(slice)) return 'xml-sitemap-not-html';

  const metaGen = slice.match(/<meta[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["']([^"']*)["']/i);
  const gen = metaGen ? metaGen[1].toLowerCase() : '';

  if (gen.includes('notion')) return 'notion-generator-meta';
  if (gen.includes('webflow')) return 'webflow-generator-meta';

  if (/id\s*=\s*["']notion-app["']|notion\.site|notion\.so/i.test(slice)) return 'notion-dom';
  if (/data-wf-domain|website-files\.com\/[^"']*\.webflow\./i.test(slice)) return 'webflow-dom';

  if (/cdn\.shopify\.com|shopify\.theme/i.test(lower)) return 'shopify';

  const jobHrefCount = (slice.match(/href\s*=\s*["'][^"']*\/(jobs?|careers)(\/|[-_]|["'])/gi) || []).length;
  if (jobHrefCount >= 4) return 'many-career-path-hrefs';

  if (/greenhouse\.io|boards\.greenhouse/i.test(lower)) return 'greenhouse-embed-snippet';
  if (/lever\.co|jobs\.lever/i.test(lower)) return 'lever-embed-snippet';
  if (/myworkdayjobs\.com|workday\.com\/wday/i.test(lower)) return 'workday-embed-snippet';

  if (/wp-content|wordpress/i.test(lower) && jobHrefCount >= 2) return 'wordpress-careers-ish';

  return 'other';
}

function main() {
  const artifactsDir =
    process.argv.find(a => a.startsWith('--artifacts='))?.split('=')[1] || DEFAULT_ARTIFACTS;

  if (!fs.existsSync(artifactsDir)) {
    console.error('Artifacts directory not found:', artifactsDir);
    process.exit(1);
  }

  const names = fs.readdirSync(artifactsDir);
  const population = [];

  for (const name of names) {
    if (!isCanonicalCompanyHtml(name)) continue;
    const id = name.replace(/\.html$/, '');
    const jsonPath = path.join(artifactsDir, `${id}.json`);
    if (fs.existsSync(jsonPath)) continue;

    const htmlPath = path.join(artifactsDir, name);
    const html = readFileSafe(htmlPath) || '';
    const shape = classifyShape(html);
    population.push({ id, shape, bytes: html.length });
  }

  const byShape = new Map();
  for (const row of population) {
    if (!byShape.has(row.shape)) byShape.set(row.shape, []);
    byShape.get(row.shape).push(row.id);
  }

  const sorted = [...byShape.entries()].sort((a, b) => b[1].length - a[1].length);
  const total = population.length;

  console.log(JSON.stringify({ artifactsDir, totalLlmEligibleHtml: total, buckets: sorted.map(([k, ids]) => ({ shape: k, count: ids.length, sampleIds: ids.slice(0, 8) })) }, null, 2));

  console.error('\n--- Summary ---');
  console.error(`LLM-eligible HTML artifacts (no sibling .json): ${total}`);
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    const [shape, ids] = sorted[i];
    cum += ids.length;
    const pct = total ? ((ids.length / total) * 100).toFixed(1) : '0';
    const cumPct = total ? ((cum / total) * 100).toFixed(1) : '0';
    console.error(`${String(i + 1).padStart(2)}. ${shape}: ${ids.length} (${pct}%), cumulative top-${i + 1}: ${cumPct}%`);
  }

  const top3 = sorted.slice(0, 3).reduce((s, [, ids]) => s + ids.length, 0);
  const top3pct = total ? (top3 / total) * 100 : 0;
  console.error(`\nTop 3 shapes cover: ${top3} / ${total} (${top3pct.toFixed(1)}%)`);
}

main();
