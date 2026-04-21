#!/usr/bin/env node
/*
  Profile agent: fetch /, /about, /about-us; derive company_profile.description and careers_hints.
*/

const cheerio = require('cheerio');
const { fetchRenderedHtml } = require('../utils/browser');

const CAREERS_HINT_RE = /careers?|jobs?|join[- ]us|work[- ]with[- ]us|hiring|open[- ]roles/i;

function resolveBaseUrl(company) {
  if (company && company.url && String(company.url).trim()) {
    let u = String(company.url).trim();
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    const parsed = new URL(u);
    const path = parsed.pathname.replace(/\/+$/, '') || '';
    return `${parsed.origin}${path}/`;
  }
  if (!company || !company.domain) return null;
  const host = String(company.domain).replace(/^https?:\/\//, '').split('/')[0];
  return `https://${host}/`;
}

function buildProfileUrls(baseUrl) {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return {
    root,
    about: new URL('about', root).href,
    aboutUs: new URL('about-us', root).href,
  };
}

async function fetchStaticHtml(url, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'csb-job-board-profile/1',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(id);
  }
}

/** UTF-8 byte length of visible text (spec: bytes). */
function visibleTextUtf8ByteLength(html) {
  if (!html) return 0;
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  const text = $.root().text().replace(/\s+/g, ' ').trim();
  return Buffer.byteLength(text, 'utf8');
}

function extractDescriptionFromHtml(html) {
  if (!html) return null;
  const $ = cheerio.load(html);
  const meta = $('meta[name="description"]').attr('content');
  if (meta && String(meta).trim()) return String(meta).trim();
  const ps = $('p');
  for (let i = 0; i < ps.length; i++) {
    const t = $(ps[i]).text().replace(/\s+/g, ' ').trim();
    if (t.length > 80) return t;
  }
  return null;
}

function anchorLocation($, el) {
  const $a = $(el);
  if ($a.closest('header').length) return 'header';
  if ($a.closest('footer').length) return 'footer';
  if ($a.closest('nav').length) return 'nav';
  return 'body';
}

function extractCareersHints(html, pageUrl) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const byUrl = new Map();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const hrefMatch = href && CAREERS_HINT_RE.test(href);
    const textMatch = text && CAREERS_HINT_RE.test(text);
    if (!hrefMatch && !textMatch) return;
    let absolute;
    try {
      absolute = new URL(href, pageUrl).href;
    } catch (e) {
      return;
    }
    if (byUrl.has(absolute)) return;
    byUrl.set(absolute, {
      url: absolute,
      text: text || href || '',
      location: anchorLocation($, el),
    });
  });
  return [...byUrl.values()];
}

async function profileCompany(company, opts = {}) {
  const { verbose = false, timeoutMs = 5000 } = opts;
  const log = (...a) => {
    if (verbose) console.log('[profile]', ...a);
  };

  const baseUrl = resolveBaseUrl(company);
  if (!company.company_profile) company.company_profile = {};

  if (!baseUrl) {
    company.careers_hints = [];
    company.profile_attempted_at = new Date().toISOString();
    return;
  }

  const { root, about, aboutUs } = buildProfileUrls(baseUrl);
  const urlOrder = [
    { url: about },
    { url: aboutUs },
    { url: root },
  ];

  const staticHtmls = await Promise.all(urlOrder.map(({ url }) => fetchStaticHtml(url, timeoutMs)));
  const lengths = staticHtmls.map(h => visibleTextUtf8ByteLength(h));
  const allUnder200 = lengths.every(len => len < 200);

  let finalHtmls;
  if (allUnder200) {
    log('static text < 200 bytes on all pages; using render fallback');
    finalHtmls = await Promise.all(urlOrder.map(({ url }) => fetchRenderedHtml(url, timeoutMs)));
  } else {
    finalHtmls = staticHtmls;
  }

  const existingDesc = company.company_profile.description;
  if (!existingDesc || !String(existingDesc).trim()) {
    for (let i = 0; i < urlOrder.length; i++) {
      const desc = extractDescriptionFromHtml(finalHtmls[i]);
      if (desc) {
        company.company_profile.description = desc;
        break;
      }
    }
  }

  const merged = new Map();
  for (let i = 0; i < urlOrder.length; i++) {
    for (const h of extractCareersHints(finalHtmls[i], urlOrder[i].url)) {
      if (!merged.has(h.url)) merged.set(h.url, h);
    }
  }
  company.careers_hints = [...merged.values()];

  company.profile_attempted_at = new Date().toISOString();
}

module.exports = { profileCompany };
