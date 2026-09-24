// Shared project-status judgment rules used by both the 汐构监督agent script
// (scripts/xigou-supervisor-brief.mjs) and the 数据大屏 dashboard API, so the
// two surfaces never disagree about what counts as "stalled" or "near milestone".

export const STALLED_THRESHOLD_DAYS = 7;
export const MILESTONE_SOON_DAYS = 3;
export const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function toUtcMidnight(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const ts = Date.UTC(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(ts) ? null : ts;
}

export function daysBetween(fromTs, toTs) {
  return Math.round((toTs - fromTs) / 86400000);
}

export function formatDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function buildTaskText(project) {
  if (project.note && project.note.trim()) return project.note.trim();
  if (project.next_milestone && project.next_milestone.trim()) return `推进下一个节点：${project.next_milestone.trim()}`;
  return '缺少 note / next_milestone 描述，需要项目负责人补充当前该做什么';
}

// Returns per-project judgment plus the four grouped views the supervisor
// agent and the dashboard both need: stalled / today_tasks / backlog / data_issues.
export function classifyProjects(projects, todayTs, { maxTodayTasks = 12 } = {}) {
  const active = projects.filter(p => p.status === 'active');
  const dataIssues = [];
  const enriched = active.map(project => {
    const lastUpdateTs = toUtcMidnight(project.last_update);
    const milestoneTs = toUtcMidnight(project.next_milestone_date);
    if (!project.last_update || lastUpdateTs === null) {
      dataIssues.push({ name: project.name, issue: 'last_update 缺失或格式不对，已跳过停滞判断' });
    }
    const staleDays = lastUpdateTs === null ? null : daysBetween(lastUpdateTs, todayTs);
    const isStalled = staleDays !== null && staleDays > STALLED_THRESHOLD_DAYS;
    const daysToMilestone = milestoneTs === null ? null : daysBetween(todayTs, milestoneTs);
    const isNearMilestone = daysToMilestone !== null && daysToMilestone >= 0 && daysToMilestone < MILESTONE_SOON_DAYS;
    const priorityRank = PRIORITY_ORDER[project.priority] ?? PRIORITY_ORDER.P3 + 1;
    return { project, staleDays, isStalled, isNearMilestone, priorityRank, task: buildTaskText(project) };
  });

  const stalled = enriched
    .filter(e => e.isStalled)
    .map(e => ({ name: e.project.name, days: e.staleDays, reason: `距上次更新已 ${e.staleDays} 天` }));

  const sorted = [...enriched].sort((a, b) => {
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    return (b.staleDays ?? 0) - (a.staleDays ?? 0);
  });

  const todayTasks = sorted.slice(0, maxTodayTasks).map(e => ({
    name: e.project.name, task: e.task, priority: e.project.priority, isNearMilestone: e.isNearMilestone
  }));
  const backlog = sorted.slice(maxTodayTasks).map(e => ({ name: e.project.name, task: e.task }));

  return { enriched, stalled, todayTasks, backlog, dataIssues };
}
