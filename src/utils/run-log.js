const fs = require('fs');
const path = require('path');

function startRun(agentName) {
  return { agent: agentName, started_at: new Date().toISOString() };
}

async function endRun(run, counts = {}) {
  if (!run || !run.started_at) return null;
  const finished_at = new Date().toISOString();
  const duration_ms = Date.now() - Date.parse(run.started_at);

  // normalize counts.errors to a number if it's a Set or similar
  let errorCount = 0;
  if (counts && typeof counts.errors === 'number') errorCount = counts.errors;
  else if (counts && counts.errors && typeof counts.errors.size === 'number') errorCount = counts.errors.size;

  const status = errorCount > 0 ? 'partial' : 'success';

  const entry = Object.assign({}, run, { finished_at, duration_ms, status }, counts, { errors: errorCount });

  const outPath = path.join(process.cwd(), 'data', 'pipeline_runs.json');
  try {
    // read existing
    let arr = [];
    try {
      const txt = await fs.promises.readFile(outPath, 'utf8');
      arr = JSON.parse(txt);
      if (!Array.isArray(arr)) arr = [];
    } catch (e) {
      arr = [];
    }

    arr.push(entry);

    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    const tmp = outPath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(arr, null, 2), 'utf8');
    await fs.promises.rename(tmp, outPath);
  } catch (e) {
    // never throw
    console.warn('[run-log] Failed to write pipeline run:', e && e.message ? e.message : e);
  }

  // concise stdout summary
  try {
    const secs = ((entry.duration_ms || 0) / 1000).toFixed(1);
    const parts = [];
    if (typeof entry.processed !== 'undefined') parts.push(`${entry.processed} processed`);
    if (typeof entry.enriched !== 'undefined') parts.push(`${entry.enriched} enriched`);
    if (typeof entry.found !== 'undefined') parts.push(`${entry.found} found`);
    if (typeof entry.extracted !== 'undefined') parts.push(`${entry.extracted} extracted`);
    if (typeof entry.errors !== 'undefined') parts.push(`${entry.errors} errors`);
    const tail = parts.length ? ' — ' + parts.join(', ') : '';
    console.log(`[run-log] ${entry.agent} finished in ${secs}s${tail}`);
  } catch (e) {
    // swallow logging errors
  }

  return entry;
}

module.exports = { startRun, endRun };