const path = require('path');
const fs = require('fs');

const STAGES = ['profile', 'discovery', 'fingerprint', 'scrape', 'extract', 'enrich', 'categorize'];

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function getStage(company) {
  const c = company || {};

  if (isBlank(c.profile_attempted_at)) {
    return 'profile';
  }

  if (isBlank(c.careers_page_discovery_method)) {
    return 'discovery';
  }

  // Unreachable careers page: skip fingerprint/scrape/extract, go straight to categorize.
  if (c.careers_page_reachable === false) {
    if (isBlank(c.climate_tech_category) || c.climate_tech_category === 'None') {
      return 'categorize';
    }
    return 'done';
  }

  if (isBlank(c.fingerprint_attempted_at)) {
    return 'fingerprint';
  }

  if (isBlank(c.last_scraped_at)) {
    return 'scrape';
  }

  // Signature-gated ATS companies intentionally skip extraction when unchanged.
  if (c.last_scrape_outcome === 'skipped_signature_match') {
    if (isBlank(c.climate_tech_category) || c.climate_tech_category === 'None') {
      return 'categorize';
    }
    return 'done';
  }

  if (isBlank(c.last_extracted_at)) {
    return 'extract';
  }

  if (isBlank(c.last_enriched_at)) {
    return 'enrich';
  }

  if (isBlank(c.climate_tech_category) || c.climate_tech_category === 'None') {
    return 'categorize';
  }

  return 'done';
}

function nextStage(stage) {
  if (stage === 'done') return null;
  const idx = STAGES.indexOf(stage);
  if (idx === -1) return null;
  if (idx === STAGES.length - 1) return 'done';
  return STAGES[idx + 1];
}

module.exports = {
  STAGES,
  getStage,
  nextStage,
};

if (require.main === module) {
  const companiesPath = path.resolve(__dirname, '..', '..', 'data', 'companies.json');
  const raw = fs.readFileSync(companiesPath, 'utf8');
  const companies = JSON.parse(raw);

  const tallies = {
    profile: 0,
    discovery: 0,
    fingerprint: 0,
    scrape: 0,
    extract: 0,
    categorize: 0,
    done: 0,
  };

  for (const company of companies) {
    const stage = getStage(company);
    if (tallies[stage] === undefined) {
      tallies[stage] = 0;
    }
    tallies[stage] += 1;
  }

  const total = companies.length;
  console.log(`Total companies: ${total}`);
  for (const key of [...STAGES, 'done']) {
    const count = tallies[key] || 0;
    console.log(`${key}: ${count}`);
  }
}

