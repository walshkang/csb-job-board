const { chromium } = require('playwright');

let browser = null;
let pageCount = 0;
const MAX_CONCURRENT_PAGES = 4; // Simple semaphore to cap concurrent pages
const queue = [];
let inflight = 0;

function acquire() {
  return new Promise(resolve => {
    if (inflight < MAX_CONCURRENT_PAGES) {
      inflight++;
      resolve();
    } else queue.push(resolve);
  });
}

function release() {
  inflight--;
  if (queue.length) {
    inflight++;
    queue.shift()();
  }
}

async function getBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

// Navigates to url, waits for networkidle, returns rendered HTML.
// Returns null on error. Timeout defaults to 15s.
async function fetchRenderedHtml(url, timeoutMs = 15000) {
  await acquire();
  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    return await page.content();
  } catch (err) {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
    release();
  }
}

// Call this when the process is done to clean up the browser.
async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

module.exports = { fetchRenderedHtml, closeBrowser };