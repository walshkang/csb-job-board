// web/explorer.js

let allData = [];
let filteredData = [];
let currentPage = 1;
const itemsPerPage = 20;
let currentMode = 'companies'; // 'companies' or 'jobs'

const tableHead = document.getElementById('table-head');
const tableBody = document.getElementById('table-body');
const recordCount = document.getElementById('record-count');
const pageIndicator = document.getElementById('page-indicator');
const searchInput = document.getElementById('explorer-search');
const explorerTitle = document.getElementById('explorer-title');

const btnViewCompanies = document.getElementById('btn-view-companies');
const btnViewJobs = document.getElementById('btn-view-jobs');
const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');

const recordDrawer = document.getElementById('record-drawer');
const drawerBackdrop = document.getElementById('drawer-backdrop');
const recordTitle = document.getElementById('record-title');
const recordContent = document.getElementById('record-content');
const btnCloseDrawer = document.getElementById('btn-close-drawer');

async function loadDataset(mode) {
  currentMode = mode;
  explorerTitle.textContent = mode === 'companies' ? 'Company Explorer' : 'Job Explorer';
  
  btnViewCompanies.classList.toggle('active', mode === 'companies');
  btnViewJobs.classList.toggle('active', mode === 'jobs');
  
  const url = mode === 'companies' ? '../data/companies.json' : '../data/jobs.json';
  
  recordCount.textContent = `Loading ${mode}...`;
  
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to load dataset');
    const data = await res.json();
    
    allData = Array.isArray(data) ? data : Object.values(data);
    filteredData = [...allData];
    currentPage = 1;
    
    renderTable();
  } catch (err) {
    recordCount.textContent = 'Error loading data.';
    console.error(err);
  }
}

function renderTable() {
  const start = (currentPage - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const pageData = filteredData.slice(start, end);
  
  const totalPages = Math.ceil(filteredData.length / itemsPerPage) || 1;
  pageIndicator.textContent = `Page ${currentPage} of ${totalPages}`;
  recordCount.textContent = `${filteredData.length} records found`;
  
  // Header
  if (currentMode === 'companies') {
    tableHead.innerHTML = `
      <tr>
        <th>Name</th>
        <th>Domain</th>
        <th>Category</th>
        <th>Status</th>
      </tr>
    `;
  } else {
    tableHead.innerHTML = `
      <tr>
        <th>Title</th>
        <th>Company</th>
        <th>Function</th>
        <th>MBA</th>
      </tr>
    `;
  }
  
  // Body
  tableBody.innerHTML = '';
  pageData.forEach(item => {
    const tr = document.createElement('tr');
    tr.onclick = () => openDetail(item);
    
    if (currentMode === 'companies') {
      tr.innerHTML = `
        <td>${item.name || 'N/A'}</td>
        <td>${item.domain || 'N/A'}</td>
        <td>${item.climate_tech_category || 'N/A'}</td>
        <td><div class="intelligence-badge" style="font-size: 0.7rem; padding: 0.2rem 0.5rem;">${item.last_scrape_outcome || 'pending'}</div></td>
      `;
    } else {
      tr.innerHTML = `
        <td>${item.job_title_normalized || item.job_title_raw}</td>
        <td>${item.company_id}</td>
        <td>${item.job_function || 'N/A'}</td>
        <td>${item.mba_relevance || 'N/A'}</td>
      `;
    }
    tableBody.appendChild(tr);
  });
}

function openDetail(item) {
  recordTitle.textContent = item.name || item.job_title_raw;
  recordContent.innerHTML = `
    <pre style="background: rgba(0,0,0,0.3); padding: 1rem; border-radius: 8px; overflow: auto; font-size: 0.8rem; color: var(--accent);">
${JSON.stringify(item, null, 2)}
    </pre>
  `;
  recordDrawer.classList.add('active');
  drawerBackdrop.classList.add('active');
}

function closeDrawer() {
  recordDrawer.classList.remove('active');
  drawerBackdrop.classList.remove('active');
}

btnCloseDrawer.addEventListener('click', closeDrawer);
drawerBackdrop.addEventListener('click', closeDrawer);

// Search
searchInput.addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  filteredData = allData.filter(item => {
    const text = JSON.stringify(item).toLowerCase();
    return text.includes(query);
  });
  currentPage = 1;
  renderTable();
});

// Pagination
btnPrevPage.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    renderTable();
  }
});

btnNextPage.addEventListener('click', () => {
  const totalPages = Math.ceil(filteredData.length / itemsPerPage);
  if (currentPage < totalPages) {
    currentPage++;
    renderTable();
  }
});

btnViewCompanies.addEventListener('click', () => loadDataset('companies'));
btnViewJobs.addEventListener('click', () => loadDataset('jobs'));

// Initial Load
loadDataset('companies');
