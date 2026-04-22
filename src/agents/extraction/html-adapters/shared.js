/**
 * Shared heuristics for DOM-based HTML job extraction (before LLM fallback).
 */
const cheerio = require('cheerio');
const { URL } = require('url');

/** LLM extraction truncates HTML; adapters parse the full artifact (bounded) because listings often appear far below the fold. */
const ADAPTER_HTML_MAX = Math.min(parseInt(process.env.EXTRACTION_ADAPTER_HTML_MAX || '2000000', 10) || 2000000, 4_000_000);

/** Non-HTML artifacts sometimes saved as .html (Yoast XML sitemap, etc.) */
function isXmlSitemapOrNonHtml(html) {
  const head = (html || '').slice(0, 800).trim();
  return /^<\?xml\s/i.test(head) || /<urlset[\s\n]/i.test(html || '');
}

/**
 * Coarse DOM/platform shape bucket used to gate LLM fallback.
 * Mirrors scripts/audit-html-extract-shapes.js — keep behavior in sync.
 */
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

function isWebflowHtml(html) {
  const slice = html.length > 2000000 ? html.slice(0, 2000000) : html;
  const metaGen = slice.match(/<meta[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["']([^"']*)["']/i);
  const gen = metaGen ? metaGen[1].toLowerCase() : '';
  if (gen.includes('webflow')) return true;
  return /data-wf-domain|website-files\.com\/[^"']*\.webflow\./i.test(slice);
}

/**
 * Same intent as careers URL patterns used in audits — job posting links only.
 */
/** Listing index pages (/careers, /jobs), not individual postings */
function isBareListingPath(pathname) {
  if (!pathname) return false;
  const p = pathname.replace(/\/+$/, '').toLowerCase();
  return /^\/(jobs?|careers|career|opportunities|openings|positions|vacancies)\/?$/.test(p);
}

const DENIED_PATH_SEGMENTS = new Set([
  'privacy',
  'privacy-policy',
  'terms',
  'terms-of-use',
  'terms-and-conditions',
  'contact',
  'blog',
  'press',
  'legal'
]);

function isDeniedPolicyOrNavPath(pathname) {
  if (!pathname) return false;
  const segments = pathname
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .map(s => s.replace(/\.[a-z0-9]+$/i, ''));
  if (!segments.length) return false;
  for (let i = 0; i < segments.length; i++) {
    if (DENIED_PATH_SEGMENTS.has(segments[i])) return true;
    if (
      i > 0 &&
      /^(jobs?|careers|career|opportunities|openings|positions|vacancies)$/.test(segments[i - 1]) &&
      DENIED_PATH_SEGMENTS.has(segments[i])
    ) {
      return true;
    }
  }
  return false;
}

function looksLikeJobHref(href) {
  if (!href || typeof href !== 'string') return false;
  const t = href.trim();
  if (!t || t.startsWith('#') || /^mailto:|^javascript:|^tel:/i.test(t)) return false;
  const u = t.toLowerCase();
  if (u.includes('linkedin.com') || u.includes('facebook.com') || u.includes('instagram.com')) return false;
  if (/greenhouse\.io|boards\.greenhouse/i.test(u)) return true;
  if (/jobs\.lever\.|\.lever\.co\/jobs/i.test(u)) return true;
  if (/myworkdayjobs\.com/i.test(u)) return true;
  if (/ashbyhq\.com/i.test(u)) return true;
  if (/[a-z0-9.-]+\.careers\//i.test(u)) return true;
  // Hosted ATS under careers subdomain (e.g. careers.acme.com/p/...)
  if (/careers?\./.test(u) && /\/p\/|\/jobs?\/|\/job\//i.test(u)) return true;
  if (/\/careers[-_][a-z0-9]/i.test(u)) return true;
  if (/\/jobs?[-_][a-z0-9]/i.test(u)) return true;
  if (/\/(jobs?|careers|career|opportunities|openings|positions|vacancies)(\/|$|\?)/i.test(u)) return true;
  if (/job-position\/|\/job-opening|\/jobposting/i.test(u)) return true;
  return false;
}

function normalizeHrefForJobMatch(href) {
  if (typeof href !== 'string') return '';
  return href.trim().replace(/#.*/, '');
}

/** First path segment: company/marketing pages, not postings (Webflow card context). */
const WEBFLOW_NON_JOB_FIRST_SEGMENTS = new Set([
  'about',
  'about-us',
  'contact',
  'company',
  'team',
  'culture',
  'blog',
  'news',
  'press',
  'events',
  'resources',
  'resource',
  'pricing',
  'faq',
  'login',
  'sign-in',
  'signup',
  'sign-up',
  'legal',
  'privacy',
  'terms',
]);

function isLikelyWebflowJobCardHref(href, resolved) {
  const rawHref = typeof href === 'string' ? href.trim() : '';
  const candidate = normalizeHrefForJobMatch(href || resolved);
  if (!candidate) return false;
  const lower = candidate.toLowerCase();
  if (/^mailto:|^javascript:|^tel:/.test(lower)) return false;
  if (/(^|\/)(about|contact|privacy|legal|terms|blog|resource|resources|company)(\/|$)/.test(lower)) return false;

  try {
    const u = new URL(resolved || candidate, resolved ? undefined : 'https://example.com');
    const p = (u.pathname || '').toLowerCase().replace(/\/+$/, '');
    const hasListingAnchor = /\/(jobs?|careers?)(\/)?#.+/i.test(rawHref);
    if (!p || (isBareListingPath(p) && !hasListingAnchor)) return false;
    if (isBareListingPath(p) && hasListingAnchor) return true;
    if (/(^|\/)(about|contact|privacy|legal|terms|blog|resource|resources|company)(\/|$)/.test(p)) return false;
    const segments = p.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const first = segments[0];
      if (WEBFLOW_NON_JOB_FIRST_SEGMENTS.has(first)) return false;
      if (/(jobs?|careers?|positions|openings|opportunities|vacancies)/.test(first)) return true;
      if (first === 'job' || /^(roles?|postings?)$/.test(first)) return true;
    }
    if (segments.length === 1) {
      const s = segments[0];
      if (WEBFLOW_NON_JOB_FIRST_SEGMENTS.has(s)) return false;
      if (isBareListingPath(`/${s}`)) return false;
      if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(s)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function resolveUrl(urlStr, base) {
  if (!urlStr) return null;
  try {
    return new URL(urlStr, base || undefined).toString();
  } catch {
    return null;
  }
}

/** Strip HTML noise from anchor text */
function anchorText($el) {
  return $el.text().replace(/\s+/g, ' ').trim() || null;
}

/**
 * Count raw href matches (fast path for adapter match()).
 */
function countJobLikeHrefs(html) {
  const slice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let n = 0;
  let m;
  while ((m = re.exec(slice))) {
    if (looksLikeJobHref(normalizeHrefForJobMatch(m[1]))) n++;
  }
  return n;
}

/**
 * Validate resolved URL appears in HTML prompt window (parity with LLM extraction path).
 */
function urlAppearsInHtml(resolved, htmlSlice) {
  if (!resolved) return false;
  try {
    const { pathname } = new URL(resolved);
    return htmlSlice.includes(pathname) || htmlSlice.includes(resolved);
  } catch {
    return false;
  }
}

/**
 * Main/article/section cluster gating for generic high-signal pages only.
 * many-career-path-hrefs keeps nav-stripped extraction without cluster (avoids corpus regressions).
 */
function shouldApplyDenseClusterPass(html) {
  return classifyShape(html) === 'other' && countJobLikeHrefs(html) >= 3;
}

/** Nearest semantic block used for cluster counting (null = no usable root). */
function denseListingClusterRoot($, el) {
  const $el = $(el);
  const mainish = $el.closest('main, article, [role="main"]');
  if (mainish.length) return mainish.get(0);
  const block = $el.closest('section, ul, ol');
  return block.length ? block.get(0) : null;
}

function isMainLikeClusterRoot($, root) {
  if (!root) return false;
  const tag = String(root.tagName || '').toLowerCase();
  if (tag === 'main' || tag === 'article') return true;
  const role = String($(root).attr('role') || '').toLowerCase();
  return role === 'main';
}

/** @param {{ el: unknown, resolved: string, job_title: string | null }[]} rows */
function filterDenseListingClusterRows($, rows) {
  const rootToUrls = new Map();
  for (const row of rows) {
    const root = denseListingClusterRoot($, row.el);
    if (!root) continue;
    if (!rootToUrls.has(root)) rootToUrls.set(root, new Set());
    rootToUrls.get(root).add(row.resolved);
  }
  return rows.filter(row => {
    const root = denseListingClusterRoot($, row.el);
    if (!root) return false;
    const urlSet = rootToUrls.get(root);
    const distinct = urlSet ? urlSet.size : 0;
    return isMainLikeClusterRoot($, root) || distinct >= 2;
  });
}

/**
 * Parse anchors with cheerio; dedupe by resolved URL; attach titles.
 */
function extractJobsFromAnchors(html, baseUrl) {
  const htmlSlice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
  const $ = cheerio.load(htmlSlice);
  const webflow = isWebflowHtml(htmlSlice);
  const denseCluster = shouldApplyDenseClusterPass(htmlSlice);

  /**
   * @param {boolean} stripNonWebflowNav - When true, ignore header/footer/nav/banner
   *   unless Webflow in-collection. When false, only the legacy Webflow chrome guard applies.
   * @returns {{ el: unknown, resolved: string, job_title: string | null }[]}
   */
  const collectAnchorRows = stripNonWebflowNav => {
    const seen = new Set();
    const rows = [];
    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      const hrefForMatch = normalizeHrefForJobMatch(href);
      const inNavChrome = !!$(el).closest(
        'header, footer, nav, [role="navigation"], [role="banner"], [role="contentinfo"], .w-nav'
      ).length;
      const inWebflowCard =
        webflow && !!$(el).closest('.w-dyn-item, .w-dyn-list, .w-dyn-items').length;
      const baseMatch = looksLikeJobHref(hrefForMatch);
      if (stripNonWebflowNav) {
        if (inNavChrome && (!webflow || !inWebflowCard)) return;
      } else if (webflow && inNavChrome && !inWebflowCard) {
        return;
      }

      const resolved = resolveUrl(href, baseUrl);
      const webflowCardMatch = webflow && inWebflowCard && isLikelyWebflowJobCardHref(href, resolved);
      if (!baseMatch && !webflowCardMatch) return;
      if (!resolved || !urlAppearsInHtml(resolved, htmlSlice)) return;
      try {
        const parsed = new URL(resolved);
        if (isDeniedPolicyOrNavPath(parsed.pathname)) return;
        if (isBareListingPath(parsed.pathname)) {
          const allowSectionAnchor = webflowCardMatch && !!parsed.hash && parsed.hash.length > 1;
          if (!allowSectionAnchor) return;
        }
      } catch {
        /* skip */
      }
      if (seen.has(resolved)) return;
      seen.add(resolved);
      const title = anchorText($(el));
      const job_title = title && title.length > 120 ? title.slice(0, 117) + '...' : title;
      rows.push({
        el,
        resolved,
        job_title: job_title || deriveTitleFromUrl(resolved)
      });
    });
    return rows;
  };

  const rowsToItems = rows =>
    rows.map(r => ({
      job_title: r.job_title,
      url: r.resolved,
      location: null,
      employment_type: null,
      description: null
    }));

  let rows = collectAnchorRows(true);
  if (denseCluster) {
    rows = filterDenseListingClusterRows($, rows);
  }
  let out = rowsToItems(rows);
  const wpish = /wp-content|wordpress/i.test(htmlSlice);
  if (out.length === 0 && !webflow && (countJobLikeHrefs(htmlSlice) < 3 || wpish)) {
    out = rowsToItems(collectAnchorRows(false));
  }
  return out;
}

/**
 * Aggregate JobPosting entries from JSON-LD blocks (common on WordPress / ATS embeds).
 */
function extractJobsFromJsonLd(html, baseUrl) {
  const htmlSlice = html.length > ADAPTER_HTML_MAX ? html.slice(0, ADAPTER_HTML_MAX) : html;
  const $ = cheerio.load(htmlSlice);
  const out = [];
  const seen = new Set();
  const normalizeJsonText = (raw) => {
    if (!raw || typeof raw !== 'string') return '';
    return raw
      .trim()
      .replace(/^<!\[CDATA\[/i, '')
      .replace(/\]\]>$/i, '')
      .trim();
  };
  const pickStringOrId = (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      if (typeof value['@id'] === 'string') return value['@id'];
      if (typeof value.url === 'string') return value.url;
    }
    return null;
  };
  /** JobPosting.identifier as URL string, PropertyValue, or array (WordPress / SEO plugins). */
  const pickIdentifierUrl = (identifier) => {
    if (identifier == null) return null;
    if (typeof identifier === 'string') {
      const t = identifier.trim();
      if (/^https?:\/\//i.test(t) || t.startsWith('/')) return t;
      return null;
    }
    if (Array.isArray(identifier)) {
      for (const item of identifier) {
        const u = pickIdentifierUrl(item);
        if (u) return u;
      }
      return null;
    }
    if (typeof identifier === 'object') {
      if (typeof identifier.value === 'string') {
        const v = identifier.value.trim();
        if (/^https?:\/\//i.test(v) || v.startsWith('/')) return v;
      }
      if (typeof identifier['@id'] === 'string') {
        const id = identifier['@id'].trim();
        if (/^https?:\/\//i.test(id) || id.startsWith('/')) return id;
      }
    }
    return null;
  };
  const pickJobUrl = (node) => {
    const direct = pickStringOrId(node.url);
    if (direct) return direct;
    const fromIdentifier = pickIdentifierUrl(node.identifier);
    if (fromIdentifier) return fromIdentifier;
    const mainEntity = pickStringOrId(node.mainEntityOfPage);
    if (mainEntity) return mainEntity;
    const idUrl = pickStringOrId(node['@id']);
    if (idUrl && /^https?:\/\//i.test(idUrl)) return idUrl;
    if (Array.isArray(node.potentialAction)) {
      for (const action of node.potentialAction) {
        const actionUrl = pickStringOrId(action?.target) || pickStringOrId(action?.url);
        if (actionUrl) return actionUrl;
      }
    } else if (node.potentialAction && typeof node.potentialAction === 'object') {
      const actionUrl = pickStringOrId(node.potentialAction.target) || pickStringOrId(node.potentialAction.url);
      if (actionUrl) return actionUrl;
    }
    return pickStringOrId(node.hiringOrganization?.sameAs);
  };
  const extractNodeCandidates = (data) => {
    const candidates = [];
    const queue = Array.isArray(data) ? [...data] : [data];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      candidates.push(node);
      if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
      if (Array.isArray(node.itemListElement)) queue.push(...node.itemListElement);
      if (node.item && typeof node.item === 'object') queue.push(node.item);
      if (node.mainEntity && typeof node.mainEntity === 'object') queue.push(node.mainEntity);
      if (Array.isArray(node.mainEntity)) queue.push(...node.mainEntity);
    }
    return candidates;
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    const jsonText = normalizeJsonText($(el).contents().text());
    if (!jsonText) return;
    let data;
    try {
      data = JSON.parse(jsonText);
    } catch {
      return;
    }
    const candidates = extractNodeCandidates(data);
    for (const node of candidates) {
      if (!node || typeof node !== 'object') continue;
      const types = node['@type'];
      const tArr = Array.isArray(types) ? types : types ? [types] : [];
      const isJob = tArr.some(t => String(t).toLowerCase().includes('jobposting'));
      if (!isJob) continue;
      const url = pickJobUrl(node);
      const title = node.title || node.name || null;
      if (!url || typeof url !== 'string') continue;
      const resolved = resolveUrl(url, baseUrl);
      if (!resolved || seen.has(resolved)) continue;
      if (!urlAppearsInHtml(resolved, htmlSlice) && !htmlSlice.includes(url)) continue;
      try {
        const { pathname } = new URL(resolved);
        if (isBareListingPath(pathname)) continue;
        if (isDeniedPolicyOrNavPath(pathname)) continue;
      } catch {
        continue;
      }
      seen.add(resolved);
      out.push({
        job_title: title ? String(title).replace(/\s+/g, ' ').trim() : deriveTitleFromUrl(resolved),
        url: resolved,
        location: null,
        employment_type: null,
        description: typeof node.description === 'string' ? node.description.slice(0, 500) : null
      });
    }
  });
  return out;
}

function deriveTitleFromUrl(resolved) {
  try {
    const { pathname } = new URL(resolved);
    const seg = pathname.split('/').filter(Boolean).pop() || '';
    const words = seg.replace(/[-_]+/g, ' ').replace(/\.[a-z]+$/i, '').trim();
    return words ? words.replace(/\b\w/g, c => c.toUpperCase()) : null;
  } catch {
    return null;
  }
}

function mergeByUrl(a, b) {
  const seen = new Set();
  const out = [];
  for (const arr of [a, b]) {
    for (const it of arr) {
      if (!it || !it.url || seen.has(it.url)) continue;
      seen.add(it.url);
      out.push(it);
    }
  }
  return out;
}

module.exports = {
  ADAPTER_HTML_MAX,
  isXmlSitemapOrNonHtml,
  classifyShape,
  isWebflowHtml,
  isBareListingPath,
  isDeniedPolicyOrNavPath,
  looksLikeJobHref,
  countJobLikeHrefs,
  extractJobsFromAnchors,
  extractJobsFromJsonLd,
  resolveUrl,
  urlAppearsInHtml,
  deriveTitleFromUrl,
  mergeByUrl
};
