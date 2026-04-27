const fs = require('fs');
const path = require('path');
const { resolveByRule, buildKeywordIndex } = require('../agents/categorizer');

const MAP_PATH = path.join(__dirname, '..', '..', 'data', 'pitchbook-taxonomy-map.json');
const TAX_PATH = path.join(__dirname, '..', '..', 'data', 'climate-tech-map-industry-categories.json');

let cachedMap = null;
let taxonomyKeywordIndex = null;

function loadPitchbookTaxonomyMap() {
  if (cachedMap) return cachedMap;
  try {
    const raw = fs.readFileSync(MAP_PATH, 'utf8');
    cachedMap = JSON.parse(raw);
    return cachedMap;
  } catch (err) {
    console.error('Failed to load pitchbook-taxonomy-map.json:', err.message);
    return {
      emerging_spaces: {},
      verticals: {},
      industry_codes: {},
      industry_groups: {},
      industry_sectors: {}
    };
  }
}

function getTaxonomyKeywordIndex() {
  if (taxonomyKeywordIndex) return taxonomyKeywordIndex;
  try {
    const raw = fs.readFileSync(TAX_PATH, 'utf8');
    const taxonomy = JSON.parse(raw);
    taxonomyKeywordIndex = buildKeywordIndex(taxonomy);
    return taxonomyKeywordIndex;
  } catch (err) {
    console.error('Failed to load climate-tech-map-industry-categories.json:', err.message);
    return { keywordToCategoryIds: new Map(), categoryById: new Map() };
  }
}

/**
 * Normalizes strings for case-insensitive matching.
 */
function normalize(str) {
  if (!str) return '';
  return String(str).toLowerCase().trim();
}

/**
 * Helper to match an array of tags against a dictionary section of the map.
 * Returns the first matching mapped value.
 */
function matchArrayTags(tags, mapSection) {
  if (!tags || !Array.isArray(tags) || !mapSection) return undefined;
  
  // Create a case-insensitive map
  const normalizedMap = new Map();
  for (const [key, value] of Object.entries(mapSection)) {
    normalizedMap.set(normalize(key), value);
  }

  for (const tag of tags) {
    const normTag = normalize(tag);
    if (normalizedMap.has(normTag)) {
      return normalizedMap.get(normTag);
    }
  }
  return undefined;
}

/**
 * Helper to match a single tag against a dictionary section of the map.
 */
function matchSingleTag(tag, mapSection) {
  if (!tag || !mapSection) return undefined;
  const normalizedMap = new Map();
  for (const [key, value] of Object.entries(mapSection)) {
    normalizedMap.set(normalize(key), value);
  }
  const normTag = normalize(tag);
  return normalizedMap.has(normTag) ? normalizedMap.get(normTag) : undefined;
}

/**
 * Cascades through PitchBook classifications to find the best taxonomy match.
 * 
 * @param {Object} company - The company record.
 * @param {Object} pbMap - The PitchBook taxonomy map.
 * @returns {Object|null} { category, confidence, resolver, climate_relevant_hint } or null.
 */
function cascadeLookup(company, pbMap) {
  // 1. Emerging Spaces (High confidence)
  const esMatch = matchArrayTags(company.emerging_spaces, pbMap.emerging_spaces);
  if (esMatch !== undefined) {
    if (esMatch === null) return { category: null, confidence: null, resolver: 'emerging_space', climate_relevant_hint: true };
    return { category: esMatch, confidence: 'high', resolver: 'emerging_space' };
  }

  // 2. Verticals (High confidence)
  const verticalMatch = matchArrayTags(company.pitchbook_verticals, pbMap.verticals);
  if (verticalMatch !== undefined) {
    if (verticalMatch === null) return { category: null, confidence: null, resolver: 'vertical', climate_relevant_hint: true };
    return { category: verticalMatch, confidence: 'high', resolver: 'vertical' };
  }

  // 3. Industry Code (Medium confidence)
  const codeMatch = matchSingleTag(company.pitchbook_industry_code, pbMap.industry_codes);
  if (codeMatch !== undefined) {
    if (codeMatch === null) return { category: null, confidence: null, resolver: 'industry_code', climate_relevant_hint: true };
    return { category: codeMatch, confidence: 'medium', resolver: 'industry_code' };
  }

  // 4. Industry Group (Low confidence)
  const groupMatch = matchSingleTag(company.pitchbook_industry_group, pbMap.industry_groups);
  if (groupMatch !== undefined) {
    if (groupMatch === null) return { category: null, confidence: null, resolver: 'industry_group', climate_relevant_hint: true };
    return { category: groupMatch, confidence: 'low', resolver: 'industry_group' };
  }

  // 5. Keyword rule resolution (using existing fallback)
  // Ensure we pass the company profile with keywords structured properly for resolveByRule
  const structuredCompany = {
    ...company,
    company_profile: {
      ...company.company_profile,
      keywords: company.pitchbook_keywords || []
    }
  };
  
  const ruleMatch = resolveByRule(structuredCompany, getTaxonomyKeywordIndex());
  if (ruleMatch) {
    // resolveByRule returns { category: { 'Tech Category Name': '...' }, confidence, resolver }
    const categoryName = ruleMatch.category['Tech Category Name'] || ruleMatch.category['Tech category name'] || ruleMatch.category.name;
    return {
      category: categoryName,
      confidence: ruleMatch.confidence,
      resolver: ruleMatch.resolver
    };
  }

  return null;
}

module.exports = {
  loadPitchbookTaxonomyMap,
  cascadeLookup,
};
