const fs = require('fs');
const http = require('http');
const https = require('https');

const jobs = JSON.parse(fs.readFileSync('data/jobs.json', 'utf8'));

async function checkUrl(urlStr) {
  if (!urlStr) return false;
  return new Promise(resolve => {
    try {
      const url = new URL(urlStr);
      const reqLib = url.protocol === 'https:' ? https : http;
      const req = reqLib.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(0));
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.end();
    } catch (e) {
      resolve(0);
    }
  });
}

async function main() {
  const activeJobs = jobs.filter(j => !j.removed_at && j.source_url);
  console.log(`Checking ${activeJobs.length} active jobs with URLs...`);
  let errors = 0;
  for (let i = 0; i < activeJobs.length; i++) {
    const job = activeJobs[i];
    const status = await checkUrl(job.source_url);
    if (status === 404) {
      console.log(`[404] ${job.company_id}: ${job.job_title_raw} - ${job.source_url}`);
      job.removed_at = new Date().toISOString();
      errors++;
    }
  }
  if (errors > 0) {
    fs.writeFileSync('data/jobs.json', JSON.stringify(jobs, null, 2));
    console.log(`Marked ${errors} jobs as removed due to 404.`);
  } else {
    console.log('No 404s found!');
  }
}
main();
