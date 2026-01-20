// Dashboard state
const state = {
  stats: { ready: 0, running: 0, done: 0, failed: 0, dead: 0, total: 0 },
  jobs: [],
  queues: [],
  workers: [],
  currentPage: 0,
  pageSize: 50,
  queueFilter: '',
  statusFilter: '',
};

// Refresh interval (ms)
const REFRESH_INTERVAL = 2000;

// DOM elements
const elements = {
  statReady: document.getElementById('stat-ready'),
  statRunning: document.getElementById('stat-running'),
  statDone: document.getElementById('stat-done'),
  statFailed: document.getElementById('stat-failed'),
  statDead: document.getElementById('stat-dead'),
  workersSection: document.getElementById('workers-section'),
  workersGrid: document.getElementById('workers-grid'),
  jobsTbody: document.getElementById('jobs-tbody'),
  queueFilter: document.getElementById('queue-filter'),
  statusFilter: document.getElementById('status-filter'),
  prevPage: document.getElementById('prev-page'),
  nextPage: document.getElementById('next-page'),
  pageInfo: document.getElementById('page-info'),
  refreshIndicator: document.getElementById('refresh-indicator'),
};

// Format timestamp to relative time
function formatTime(timestamp) {
  if (!timestamp) return '-';
  
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 1000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  
  return new Date(timestamp).toLocaleDateString();
}

// Fetch stats from API
async function fetchStats() {
  try {
    const params = new URLSearchParams();
    if (state.queueFilter) params.set('queue', state.queueFilter);
    
    const response = await fetch(`/api/stats?${params}`);
    const data = await response.json();
    
    state.stats = data.stats;
    state.queues = data.queues || [];
    state.workers = data.workers || [];
    
    updateStatsUI();
    updateQueueFilterOptions();
    updateWorkersUI();
  } catch (error) {
    console.error('Failed to fetch stats:', error);
  }
}

// Fetch jobs from API
async function fetchJobs() {
  try {
    const params = new URLSearchParams({
      limit: state.pageSize.toString(),
      offset: (state.currentPage * state.pageSize).toString(),
    });
    
    if (state.queueFilter) params.set('queue', state.queueFilter);
    if (state.statusFilter) params.set('status', state.statusFilter);
    
    const response = await fetch(`/api/jobs?${params}`);
    const data = await response.json();
    
    state.jobs = data.jobs || [];
    
    updateJobsUI();
    updatePaginationUI();
  } catch (error) {
    console.error('Failed to fetch jobs:', error);
  }
}

// Update stats UI
function updateStatsUI() {
  elements.statReady.textContent = state.stats.ready.toLocaleString();
  elements.statRunning.textContent = state.stats.running.toLocaleString();
  elements.statDone.textContent = state.stats.done.toLocaleString();
  elements.statFailed.textContent = state.stats.failed.toLocaleString();
  elements.statDead.textContent = state.stats.dead.toLocaleString();
}

// Update queue filter options
function updateQueueFilterOptions() {
  const currentValue = elements.queueFilter.value;
  const options = ['<option value="">All Queues</option>'];
  
  for (const queue of state.queues) {
    const selected = queue === currentValue ? ' selected' : '';
    options.push(`<option value="${queue}"${selected}>${queue}</option>`);
  }
  
  elements.queueFilter.innerHTML = options.join('');
}

// Update workers UI
function updateWorkersUI() {
  if (state.workers.length === 0) {
    elements.workersSection.style.display = 'none';
    return;
  }
  
  elements.workersSection.style.display = 'block';
  
  const cards = state.workers.map(worker => {
    const statusClass = !worker.running ? 'stopped' : worker.paused ? 'paused' : 'running';
    const statusText = !worker.running ? 'Stopped' : worker.paused ? 'Paused' : 'Running';
    
    return `
      <div class="worker-card">
        <div class="worker-info">
          <span class="worker-queue">${worker.queue}</span>
          <span class="worker-status">
            <span class="dot ${statusClass}"></span>
            ${statusText}
          </span>
        </div>
        <div class="worker-controls">
          ${worker.paused 
            ? `<button onclick="resumeWorker('${worker.queue}')">Resume</button>`
            : `<button onclick="pauseWorker('${worker.queue}')">Pause</button>`
          }
        </div>
      </div>
    `;
  });
  
  elements.workersGrid.innerHTML = cards.join('');
}

// Update jobs UI
function updateJobsUI() {
  if (state.jobs.length === 0) {
    elements.jobsTbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="5" width="20" height="14" rx="2"/>
            <line x1="2" y1="10" x2="22" y2="10"/>
          </svg>
          <p>No jobs found</p>
        </td>
      </tr>
    `;
    return;
  }
  
  const rows = state.jobs.map(job => `
    <tr>
      <td><span class="job-id">${job.id}</span></td>
      <td><span class="job-queue">${job.queue}</span></td>
      <td><span class="job-status ${job.status}">${job.status}</span></td>
      <td class="job-priority">${job.priority}</td>
      <td class="job-attempts">${job.attempts}/${job.maxAttempts}</td>
      <td class="job-time">${formatTime(job.createdAt)}</td>
      <td class="job-error" title="${job.lastError || ''}">${job.lastError || ''}</td>
    </tr>
  `);
  
  elements.jobsTbody.innerHTML = rows.join('');
}

// Update pagination UI
function updatePaginationUI() {
  elements.prevPage.disabled = state.currentPage === 0;
  elements.nextPage.disabled = state.jobs.length < state.pageSize;
  elements.pageInfo.textContent = `Page ${state.currentPage + 1}`;
}

// Pause worker
async function pauseWorker(queue) {
  try {
    await fetch(`/api/workers/${encodeURIComponent(queue)}/pause`, { method: 'POST' });
    await fetchStats();
  } catch (error) {
    console.error('Failed to pause worker:', error);
  }
}

// Resume worker
async function resumeWorker(queue) {
  try {
    await fetch(`/api/workers/${encodeURIComponent(queue)}/resume`, { method: 'POST' });
    await fetchStats();
  } catch (error) {
    console.error('Failed to resume worker:', error);
  }
}

// Event handlers
elements.queueFilter.addEventListener('change', (e) => {
  state.queueFilter = e.target.value;
  state.currentPage = 0;
  fetchStats();
  fetchJobs();
});

elements.statusFilter.addEventListener('change', (e) => {
  state.statusFilter = e.target.value;
  state.currentPage = 0;
  fetchJobs();
});

elements.prevPage.addEventListener('click', () => {
  if (state.currentPage > 0) {
    state.currentPage--;
    fetchJobs();
  }
});

elements.nextPage.addEventListener('click', () => {
  if (state.jobs.length >= state.pageSize) {
    state.currentPage++;
    fetchJobs();
  }
});

// Make functions available globally for onclick handlers
window.pauseWorker = pauseWorker;
window.resumeWorker = resumeWorker;

// Initial fetch
fetchStats();
fetchJobs();

// Auto-refresh
setInterval(() => {
  fetchStats();
  fetchJobs();
}, REFRESH_INTERVAL);
