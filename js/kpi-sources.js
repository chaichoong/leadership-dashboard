/* KPI Source Registry
 *
 * Pre-named templates for project KPIs. Most are MANUAL (the client updates
 * the Current value themselves each cycle). A handful are AUTOMATED — the
 * app computes the value from live data on every page load.
 *
 * Each source:
 *   key        — unique snake_case id (stored in the project's kpiSource field)
 *   label      — display name
 *   category   — 'Financial' | 'SaaS' | 'Task & Project'
 *   unit       — '£' | '%' | 'count' | 'days' | 'items' | 'hours'
 *   automated  — true if compute() is implemented and should run on page load
 *   compute    — (project, ctx) => number   (only for automated sources)
 *                ctx = { allTasks, todayStr }
 *
 * When a client needs a bespoke automated source not listed here, the UI
 * offers a "Request Custom Source" button which spawns a support task.
 */
const KPI_SOURCES = [
  // -------------------- Financial (manual) --------------------
  { key: 'monthly_revenue',  label: 'Monthly revenue',           category: 'Financial', unit: '£',     automated: false },
  { key: 'monthly_expenses', label: 'Monthly expenses',          category: 'Financial', unit: '£',     automated: false },
  { key: 'monthly_profit',   label: 'Monthly profit',            category: 'Financial', unit: '£',     automated: false },
  { key: 'cash_balance',     label: 'Cash balance',              category: 'Financial', unit: '£',     automated: false },
  { key: 'mom_growth',       label: 'Month-over-month growth',   category: 'Financial', unit: '%',     automated: false },
  { key: 'gross_margin',     label: 'Gross margin',              category: 'Financial', unit: '%',     automated: false },
  { key: 'annual_run_rate',  label: 'Annual run rate',           category: 'Financial', unit: '£',     automated: false },

  // -------------------- SaaS (manual) --------------------
  { key: 'mrr',                 label: 'Monthly Recurring Revenue (MRR)', category: 'SaaS', unit: '£',     automated: false },
  { key: 'new_customers_month', label: 'New customers this month',        category: 'SaaS', unit: 'count', automated: false },
  { key: 'churn_rate',          label: 'Churn rate',                      category: 'SaaS', unit: '%',     automated: false },
  { key: 'customer_count',      label: 'Customer count',                  category: 'SaaS', unit: 'count', automated: false },
  { key: 'arpu',                label: 'Average revenue per user',        category: 'SaaS', unit: '£',     automated: false },

  // -------------------- Task & Project (automated) --------------------
  {
    key: 'active_task_count',
    label: 'Active tasks (for this project)',
    category: 'Task & Project',
    unit: 'count',
    automated: true,
    compute: (project, ctx) => {
      const tasks = (ctx && ctx.allTasks) || [];
      return tasks.filter(t =>
        (t.projectIds || []).includes(project.id) && t.status !== 'Completed'
      ).length;
    }
  },
  {
    key: 'overdue_task_count',
    label: 'Overdue tasks (for this project)',
    category: 'Task & Project',
    unit: 'count',
    automated: true,
    compute: (project, ctx) => {
      const tasks = (ctx && ctx.allTasks) || [];
      const today = (ctx && ctx.todayStr) || '';
      return tasks.filter(t =>
        (t.projectIds || []).includes(project.id)
        && t.status !== 'Completed'
        && t.dueDate && today && t.dueDate < today
      ).length;
    }
  },
  {
    key: 'completed_tasks_month',
    label: 'Completed tasks this month',
    category: 'Task & Project',
    unit: 'count',
    automated: true,
    // NOTE: allTasks is fetched with a server-side filter that EXCLUDES
    // completed tasks (see loadAllData -> fetchTable filter). So we can
    // never compute this accurately with the current data. Returning 0
    // until the task fetch is widened (e.g. pull completed tasks from the
    // last ~35 days in a separate request).
    compute: () => 0
  },
  {
    key: 'project_completion_pct',
    label: 'Project completion',
    category: 'Task & Project',
    unit: '%',
    automated: true,
    compute: (project) => {
      const total = Number(project.totalTasks) || 0;
      if (total <= 0) return 0;
      const done = Number(project.completedTasks) || 0;
      return (done / total) * 100;
    }
  },
  {
    key: 'time_elapsed_pct',
    label: 'Time elapsed on project',
    category: 'Task & Project',
    unit: '%',
    automated: true,
    compute: (project) => {
      if (!project.start || !project.end) return 0;
      const start = new Date(project.start).getTime();
      const end   = new Date(project.end).getTime();
      if (!isFinite(start) || !isFinite(end) || end <= start) return 0;
      const now = Date.now();
      const pct = ((now - start) / (end - start)) * 100;
      if (pct < 0) return 0;
      if (pct > 100) return 100;
      return pct;
    }
  },
];

function getKpiSource(key){
  if(!key) return null;
  return KPI_SOURCES.find(s => s.key === key) || null;
}

function getKpiSourcesByCategory(){
  const out = { 'Financial': [], 'SaaS': [], 'Task & Project': [] };
  KPI_SOURCES.forEach(s => {
    if(!out[s.category]) out[s.category] = [];
    out[s.category].push(s);
  });
  return out;
}

// Expose on window so the Task OS page (and any other page that loads this
// file) can reach the registry without a module import.
window.KPI_SOURCES = KPI_SOURCES;
window.getKpiSource = getKpiSource;
window.getKpiSourcesByCategory = getKpiSourcesByCategory;
