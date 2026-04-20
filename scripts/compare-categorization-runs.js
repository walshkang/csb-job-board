#!/usr/bin/env node
/**
 * Compare categorize outputs between two companies snapshots.
 *
 * Usage:
 *   node scripts/compare-categorization-runs.js <baseline.json> <candidate.json>
 */

const fs = require('fs');
const path = require('path');

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Failed to read JSON at ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

function usageAndExit() {
  console.log('Usage: node scripts/compare-categorization-runs.js <baseline.json> <candidate.json>');
  process.exit(1);
}

function toMapById(companies) {
  const byId = new Map();
  for (const company of companies) {
    if (!company || !company.id) continue;
    byId.set(company.id, company);
  }
  return byId;
}

function categoryTuple(company) {
  return {
    category: company.climate_tech_category || null,
    primary_sector: company.primary_sector || null,
    opportunity_area: company.opportunity_area || null,
    confidence: company.category_confidence || null,
  };
}

function tupleEquals(a, b) {
  return (
    a.category === b.category &&
    a.primary_sector === b.primary_sector &&
    a.opportunity_area === b.opportunity_area &&
    a.confidence === b.confidence
  );
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

const args = process.argv.slice(2);
if (args.length !== 2) usageAndExit();

const baselinePath = path.resolve(args[0]);
const candidatePath = path.resolve(args[1]);
const baseline = readJSON(baselinePath);
const candidate = readJSON(candidatePath);

if (!Array.isArray(baseline) || !Array.isArray(candidate)) {
  console.error('Both input files must be JSON arrays from data/companies.json snapshots.');
  process.exit(1);
}

const baselineById = toMapById(baseline);
const candidateById = toMapById(candidate);
const sharedIds = Array.from(candidateById.keys()).filter(id => baselineById.has(id));

let resolvedByRule = 0;
let overlapCount = 0;
let agreementCount = 0;
const disagreements = [];

for (const id of sharedIds) {
  const before = baselineById.get(id);
  const after = candidateById.get(id);
  const resolver = after.category_resolver || null;
  if (resolver === 'rule') resolvedByRule++;

  const beforeTuple = categoryTuple(before);
  const afterTuple = categoryTuple(after);
  if (beforeTuple.category && afterTuple.category) {
    overlapCount++;
    if (tupleEquals(beforeTuple, afterTuple)) {
      agreementCount++;
    } else {
      disagreements.push({
        id,
        name: after.name || before.name || null,
        baseline: beforeTuple,
        candidate: afterTuple,
        resolver,
      });
    }
  }
}

console.log('\nCategorization Comparison');
console.log(`Baseline:  ${baselinePath}`);
console.log(`Candidate: ${candidatePath}`);
console.log(`Shared companies: ${sharedIds.length}`);
console.log(`Resolved by rule (candidate): ${resolvedByRule}/${sharedIds.length} (${pct(resolvedByRule, sharedIds.length)}%)`);
console.log(`Agreement on overlap: ${agreementCount}/${overlapCount} (${pct(agreementCount, overlapCount)}%)`);

if (disagreements.length) {
  console.log('\nTop disagreements (first 25):');
  for (const row of disagreements.slice(0, 25)) {
    console.log(`- ${row.id} (${row.name || 'unknown'}) [resolver=${row.resolver || 'n/a'}]`);
    console.log(`  baseline: ${row.baseline.category} | ${row.baseline.primary_sector} | ${row.baseline.opportunity_area} | ${row.baseline.confidence}`);
    console.log(`  candidate: ${row.candidate.category} | ${row.candidate.primary_sector} | ${row.candidate.opportunity_area} | ${row.candidate.confidence}`);
  }
}

const summary = {
  baseline: baselinePath,
  candidate: candidatePath,
  shared_companies: sharedIds.length,
  resolved_by_rule: resolvedByRule,
  resolved_by_rule_pct: pct(resolvedByRule, sharedIds.length),
  overlap_count: overlapCount,
  agreement_count: agreementCount,
  agreement_pct: pct(agreementCount, overlapCount),
  disagreements,
};

const outPath = path.resolve('data', 'runs', `categorize-compare-${Date.now()}.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(`\nSaved report: ${outPath}\n`);
