const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

function mapRowToCompanySchema(row) {
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

module.exports = {
  slugify,
  deterministicId,
  mergeCompanies,
  loadExistingCompanies,
  saveCompanies,
  mapRowToCompanySchema
};
