// web/jobs.js

const jobFeedEl = document.getElementById('job-feed');
const jobCountSubtitle = document.getElementById('job-count-subtitle');
const searchInput = document.getElementById('search-input');
const filterFunctionsEl = document.getElementById('filter-functions');
const filterSeniorityEl = document.getElementById('filter-seniority');
const filterClimateCheck = document.getElementById('filter-climate');

let allJobs = [];
let allCompanies = {};

let activeFilters = {
  functions: new Set(),
  seniority: new Set(),
  climateOnly: true
};

let searchQuery = "";

async function loadData() {
  try {
    jobFeedEl.innerHTML = `<div style="text-align: center; color: var(--on-surface-variant); padding: 3rem;">Loading intelligence...</div>`;
    
    // Fetch both datasets
    const [compRes, jobsRes] = await Promise.all([
      fetch('../data/companies.json'),
      fetch('../data/jobs.json')
    ]);

    if (!compRes.ok || !jobsRes.ok) throw new Error("Failed to load local data");

    const compData = await compRes.json();
    const jobsData = await jobsRes.json();

    // companies.json might be an array or object
    const companiesList = Array.isArray(compData) ? compData : Object.values(compData);
    companiesList.forEach(c => {
      allCompanies[c.id] = c;
    });

    // Extract unique filter values
    const functionsSet = new Set();
    const senioritySet = new Set();

    // Map company data onto jobs
    const jobsList = Array.isArray(jobsData) ? jobsData : Object.values(jobsData);
    allJobs = jobsList.map(job => {
      const company = allCompanies[job.company_id];
      if (job.job_function) functionsSet.add(job.job_function);
      if (job.seniority_level) senioritySet.add(job.seniority_level);
      
      return {
        ...job,
        company_name: company ? company.name : 'Unknown Company',
        company_industry: company ? (company.pitchbook_industry_group || company.domain) : '',
        location: job.location_raw || 'Remote / Unknown'
      };
    });

    // Render filter chips
    renderChips(filterFunctionsEl, Array.from(functionsSet).filter(Boolean).sort(), 'functions');
    renderChips(filterSeniorityEl, Array.from(senioritySet).filter(Boolean).sort(), 'seniority');

    // Initial render
    renderJobs();

  } catch (err) {
    console.error(err);
    jobCountSubtitle.textContent = "Error loading data.";
    jobFeedEl.innerHTML = `
      <div class="job-card" style="border: 1px solid var(--error-container);">
        <h3 style="color: var(--error);">Data Connection Failed</h3>
        <p style="color: var(--on-surface-variant);">Ensure you are running a local HTTP server (e.g., \`python3 -m http.server 8000\`). Cross-Origin requests are blocked for local files.</p>
      </div>
    `;
  }
}

function renderChips(container, items, filterKey) {
  container.innerHTML = '';
  items.forEach(item => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.textContent = item;
    
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      if (chip.classList.contains('active')) {
        activeFilters[filterKey].add(item);
      } else {
        activeFilters[filterKey].delete(item);
      }
      renderJobs();
    });
    
    container.appendChild(chip);
  });
}

function renderJobs() {
  const filtered = allJobs.filter(job => {
    // Search Query Filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchTitle = (job.job_title_normalized || job.job_title_raw || '').toLowerCase().includes(q);
      const matchComp = (job.company_name || '').toLowerCase().includes(q);
      if (!matchTitle && !matchComp) return false;
    }

    // Climate Filter
    if (activeFilters.climateOnly && job.climate_relevance_confirmed !== true) {
      return false;
    }

    // Function Filter
    if (activeFilters.functions.size > 0 && !activeFilters.functions.has(job.job_function)) {
      return false;
    }

    // Seniority Filter
    if (activeFilters.seniority.size > 0 && !activeFilters.seniority.has(job.seniority_level)) {
      return false;
    }

    return true;
  });

  jobCountSubtitle.textContent = `Showing ${filtered.length} curated opportunities`;

  jobFeedEl.innerHTML = '';
  
  if (filtered.length === 0) {
    jobFeedEl.innerHTML = `<div style="text-align: center; color: var(--on-surface-variant); padding: 3rem;">No jobs match your executive filters.</div>`;
    return;
  }

  // Render top 50 for performance
  filtered.slice(0, 50).forEach(job => {
    const card = document.createElement('div');
    card.className = 'job-card';

    // Format tags
    let tagsHtml = '';
    if (job.climate_relevance_confirmed) {
      tagsHtml += `<div class="intelligence-badge"><div class="intelligence-dot"></div>Climate Verified</div>`;
    }
    if (job.mba_relevance) {
      tagsHtml += `<div class="intelligence-badge" style="background-color: var(--surface-container-low); color: var(--on-surface);"><div class="intelligence-dot" style="background-color: var(--primary);"></div>MBA Relevant</div>`;
    }

    card.innerHTML = `
      <div class="job-header">
        <div>
          <div class="job-title">${job.job_title_normalized || job.job_title_raw || 'Untitled Position'}</div>
          <div class="job-company">${job.company_name}</div>
          <div class="job-meta-row">
            <span class="job-meta-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
              ${job.location}
            </span>
            ${job.employment_type ? `<span class="job-meta-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>
              ${job.employment_type}
            </span>` : ''}
          </div>
        </div>
        <div>
          <button class="btn-primary" style="padding: 0.5rem 1rem; font-size: 0.875rem;">View Intel</button>
        </div>
      </div>
      
      ${tagsHtml ? `<div class="job-footer"><div class="job-badges">${tagsHtml}</div></div>` : ''}
    `;

    jobFeedEl.appendChild(card);
  });
}

// Event Listeners
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderJobs();
});

filterClimateCheck.addEventListener('change', (e) => {
  activeFilters.climateOnly = e.target.checked;
  renderJobs();
});

// Init
setTimeout(loadData, 300);
