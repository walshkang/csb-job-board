const fs = require('fs');
const path = require('path');
const { loadPitchbookTaxonomyMap, cascadeLookup } = require('../utils/pitchbook-taxonomy-lookup');
const { categorizeCompany } = require('./categorizer');
const { callLLM } = require('../llm-client');
const { extractJSON } = require('./enricher');

/**
 * Returns a category's primary_sector and opportunity_area given a category string and taxonomy.
 */
function lookupCategoryDetails(categoryName, taxonomy) {
  if (!categoryName || !taxonomy) return { primary_sector: null, opportunity_area: null };
  const targetName = String(categoryName).toLowerCase().trim();
  
  for (const cat of taxonomy) {
    const name = cat['Tech Category Name'] || cat['Tech category name'] || cat.name;
    if (name && String(name).toLowerCase().trim() === targetName) {
      return {
        primary_sector: cat['Primary Sector'] || cat['Primary sector'] || null,
        opportunity_area: cat['Related Opportunity Area'] || cat['Related opportunity area'] || null
      };
    }
  }
  return { primary_sector: null, opportunity_area: null };
}

/**
 * Gets category name string
 */
function getCategoryName(category) {
  return category['Tech Category Name'] || category['Tech category name'] || category.name || '';
}

/**
 * Gets Opportunity Area string
 */
function getOpportunityArea(category) {
  return category['Related Opportunity Area'] || category['Related opportunity area'] || null;
}

/**
 * Gets Primary Sector string
 */
function getPrimarySector(category) {
  return category['Primary Sector'] || category['Primary sector'] || null;
}

/**
 * Helper to assign category result to company record.
 */
function applyCategory(company, cascadeResult, source, taxonomy) {
  company.climate_tech_category = cascadeResult.category;
  company.category_confidence = cascadeResult.confidence;
  company.category_resolver = cascadeResult.resolver;
  company.category_source = source;
  
  // Lookup opportunity area and primary sector from taxonomy
  const details = lookupCategoryDetails(cascadeResult.category, taxonomy);
  company.primary_sector = details.primary_sector;
  company.opportunity_area = details.opportunity_area;
  delete company.category_error;
  
  console.info(`[taxonomy-mapper] ${company.id} -> ${company.climate_tech_category} (${company.category_confidence}) [${company.category_resolver} - ${source}]`);
}

/**
 * Uses LLM to categorize based on PitchBook API description (Lane 2).
 */
async function categorizeFromDescription(company, desc, taxonomy, llmOpts, extra) {
  const { provider, apiKey, model, dryRun } = llmOpts;
  const companyName = company.name || company.company || String(company.id);
  
  // Build company signal token set for keyword overlap scoring
  const pitchbookContext = extra.pitchbook_context || {};
  const pbVerticals = pitchbookContext.verticals || [];
  const pbKeywords = company.pitchbook_keywords || [];
  
  const signalStr = [
    companyName,
    desc || '',
    pitchbookContext.industry_code || '',
    pitchbookContext.industry_group || '',
    pitchbookContext.industry_sector || '',
    pbVerticals.join(' '),
    pbKeywords.join(' ')
  ].join(' ').toLowerCase();
  
  const signalTokens = new Set(signalStr.split(/\W+/).filter(Boolean));

  // Score each category by keyword token overlap
  const scored = taxonomy.map(c => {
    const name = getCategoryName(c);
    const kws = Array.isArray(c.keywords) ? c.keywords : [];
    let score = 0;
    for (const kw of kws) {
      for (const tok of kw.toLowerCase().split(/\W+/).filter(Boolean)) {
        if (signalTokens.has(tok)) score++;
      }
    }
    return { c, name, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const anyMatch = scored[0].score > 0;
  const shortlist = anyMatch ? scored.slice(0, 10) : scored;

  const topScores = scored.slice(0, 3).map(s => `${s.score}:${s.name}`).join(', ');
  console.info(`[taxonomy-mapper] ${company.id} shortlisted ${shortlist.length}/${taxonomy.length} categories (top scores: ${topScores})`);

  const categoriesList = shortlist.map(({ c }) => {
    const name = getCategoryName(c);
    const area = getOpportunityArea(c) || '';
    const sector = getPrimarySector(c) || '';
    const cdesc = c.short_description || '';
    const kws = Array.isArray(c.keywords) && c.keywords.length ? c.keywords.join(', ') : '';
    return `- Category: ${name}\n  Opportunity Area: ${area}\n  Primary Sector: ${sector}\n  Description: ${cdesc}${kws ? '\\n  Keywords: ' + kws : ''}`;
  }).join('\n\n');

  const promptTemplate = fs.readFileSync(path.join(__dirname, '../prompts/categorizer-wrds.txt'), 'utf8');
  const prompt = promptTemplate
    .replace('{company_name}', companyName)
    .replace('{pitchbook_description}', desc || 'N/A')
    .replace('{pitchbook_industry_code}', pitchbookContext.industry_code || 'N/A')
    .replace('{pitchbook_industry_group}', pitchbookContext.industry_group || 'N/A')
    .replace('{pitchbook_industry_sector}', pitchbookContext.industry_sector || 'N/A')
    .replace('{pitchbook_verticals}', Array.isArray(pbVerticals) && pbVerticals.length > 0 ? pbVerticals.join(', ') : 'N/A')
    .replace('{climate_relevant_hint}', extra.climate_relevant_hint ? 'true' : 'false')
    .replace('{categories_list}', categoriesList);

  try {
    const raw = await callLLM({ provider, apiKey, model, prompt, maxOutputTokens: 4096, _agent: 'taxonomy-mapper' });
    let parsed = null;
    try {
      parsed = extractJSON(raw);
    } catch (e) {
      console.error(`Company ${company.id} (${companyName}): JSON parse failed`);
      company.category_error = String(e.message || e);
      return;
    }

    const ctc = parsed.climate_tech_category == null ? null : String(parsed.climate_tech_category).trim();
    const primary = parsed.primary_sector == null ? null : String(parsed.primary_sector).trim();
    const opp = parsed.opportunity_area == null ? null : String(parsed.opportunity_area).trim();
    const conf = parsed.category_confidence == null ? null : String(parsed.category_confidence).trim();

    company.climate_tech_category = ctc;
    company.primary_sector = primary === 'None' ? null : primary;
    company.opportunity_area = opp === 'None' ? null : opp;
    company.category_confidence = conf === 'None' ? null : conf;
    company.category_resolver = 'llm_wrds';
    company.category_source = 'wrds_medium';
    delete company.category_error;

    if (dryRun) {
      console.log(`DRY [taxonomy-mapper] ${company.id} -> ${ctc} (${conf})`);
    } else {
      console.info(`[taxonomy-mapper] Company ${company.id} -> ${ctc} (${conf}) [llm_wrds - wrds_medium]`);
    }
  } catch (err) {
    console.error(`[taxonomy-mapper] Company ${company.id} (${companyName}): call failed: ${String(err.message || err)}`);
    company.category_error = String(err.message || err);
  }
}

/**
 * Main entry point: three-lane categorization router.
 * Mutates company in-place.
 */
async function mapCategory(company, repJob, taxonomy, llmOpts) {
  const pbMap = loadPitchbookTaxonomyMap();

  // Lane 1: Fast — multi-signal deterministic cascade
  const cascadeResult = cascadeLookup(company, pbMap);
  if (cascadeResult && cascadeResult.category) {
    applyCategory(company, cascadeResult, 'wrds_fast', taxonomy);
    return;
  }

  // Lane 2: Medium — LLM on WRDS description
  const desc = (company.pitchbook_description || '').trim();
  if (company.wrds_company_id && desc.length >= 80) {
    const hint = cascadeResult?.climate_relevant_hint || false;
    await categorizeFromDescription(company, desc, taxonomy, llmOpts, {
      climate_relevant_hint: hint,
      pitchbook_context: {
        industry_code: company.pitchbook_industry_code,
        industry_group: company.pitchbook_industry_group,
        industry_sector: company.pitchbook_industry_sector,
        verticals: company.pitchbook_verticals,
      },
    });
    // Set category_source here just in case categorizeFromDescription failed to do it properly
    company.category_source = 'wrds_medium';
    return;
  }

  // Lane 3: Cold — existing categorizer pipeline
  await categorizeCompany(company, repJob, taxonomy, llmOpts, []);
  company.category_source = 'cold';
}

module.exports = {
  mapCategory,
};
