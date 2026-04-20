#!/usr/bin/env node
// Lightweight QA slice: read-only checks for companies and jobs
const fs = require('fs');
const path = require('path');

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return [];
  }
}

const dataDir = path.join(__dirname, '../../data');
const companies = readJsonSafe(path.join(dataDir, 'companies.json'));
const jobs = readJsonSafe(path.join(dataDir, 'jobs.json'));

function pct(num, denom) {
  return denom === 0 ? 0 : Math.round((num / denom) * 10000) / 100;
}

function bucketize(tier) {
  if (typeof tier !== 'string') return 'unknown';
  const normalized = tier.toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') return normalized;
  return 'unknown';
}

function sample(array, n) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// Companies checks
const totalCompanies = companies.length;
const withCareers = companies.filter(c => c && c.careers_page_url).length;
const withKnownAts = companies.filter(c => c && c.ats_platform && String(c.ats_platform).toLowerCase() !== 'custom').length;

// Companies with careers_page_reachable true but no jobs
const jobCompanyIds = new Set((jobs || []).map(j => j.company_id));
const reachableNoJobs = companies.filter(c => c && c.careers_page_reachable === true && !jobCompanyIds.has(c.id));

console.log('Companies QA');
console.log('--------------');
console.log(`Total companies: ${totalCompanies}`);
console.log(`With careers_page_url: ${withCareers} (${pct(withCareers, totalCompanies)}%)`);
console.log(`With known ATS platform (not null/custom): ${withKnownAts} (${pct(withKnownAts, totalCompanies)}%)`);
if (reachableNoJobs.length > 0) {
  console.log('\nCompanies with careers_page_reachable:true but no jobs:');
  reachableNoJobs.forEach(c => console.log(`  - ${c.id} ${c.name || ''} (${c.careers_page_url || ''})`));
} else {
  console.log('No companies with careers_page_reachable:true and zero jobs.');
}

// Jobs checks
const totalJobs = jobs.length;
const jobsWithEnrichmentError = jobs.filter(j => j && j.enrichment_error).length;
const requiredFields = ['job_title_normalized', 'job_function', 'seniority_level', 'mba_relevance', 'climate_relevance_confirmed'];
const jobsMissingRequired = jobs.filter(j => {
  if (!j) return true;
  return requiredFields.some(f => j[f] === undefined || j[f] === null);
}).length;

// MBA distribution
const buckets = { low: 0, medium: 0, high: 0, unknown: 0 };
jobs.forEach(j => { const b = bucketize(j && j.mba_relevance); buckets[b] = (buckets[b]||0)+1; });

const climateTrue = jobs.filter(j => j && j.climate_relevance_confirmed === true).length;
const climateFalse = jobs.filter(j => j && j.climate_relevance_confirmed === false).length;
const climatePct = pct(climateTrue, totalJobs);

console.log('\nJobs QA');
console.log('-------');
console.log(`Total jobs: ${totalJobs}`);
console.log(`Jobs with enrichment_error: ${jobsWithEnrichmentError} (${pct(jobsWithEnrichmentError, totalJobs)}%)`);
console.log(`Jobs missing any required enrichment field: ${jobsMissingRequired} (${pct(jobsMissingRequired, totalJobs)}%)`);
console.log('\nMBA relevance distribution:');
Object.keys(buckets).forEach(k => console.log(`  ${k}: ${buckets[k]} (${pct(buckets[k], totalJobs)}%)`));
console.log(`\nClimate relevance confirmed: ${climateTrue} true, ${climateFalse} false (${climatePct}%)`);

// Sample 5 random jobs
const sampleJobs = sample(jobs, Math.min(5, jobs.length));
console.log('\nSample jobs:');
sampleJobs.forEach(j => {
  const company = companies.find(c => c.id === j.company_id) || {};
  console.log(` - ${company.name || j.company_id} | ${j.job_title_normalized || j.job_title_raw || ''} | MBA: ${j.mba_relevance} | Climate: ${j.climate_relevance_confirmed} | Seniority: ${j.seniority_level}`);
});

// Anomaly flags
let warned = false;
if (totalJobs > 0 && (jobsWithEnrichmentError / totalJobs) > 0.2) {
  console.log('\n[WARN] Enrichment error rate > 20%'); warned = true;
}
if (totalJobs > 0 && (climatePct < 10 || climatePct > 90)) {
  console.log(`\n[WARN] Climate relevance confirmed rate is ${climatePct}%, outside expected range (10-90%)`); warned = true;
}
const missingSeniority = jobs.filter(j => !j || j.seniority_level === undefined || j.seniority_level === null).length;
if (totalJobs > 0 && (missingSeniority / totalJobs) > 0.3) {
  console.log('\n[WARN] More than 30% of jobs missing seniority_level'); warned = true;
}

if (!warned) console.log('\nNo major anomalies detected.');
