import express from 'express';
import { classifyProjects } from './project-status.js';

async function loadCostSummary(db) {
  const [[totals]] = await db.query(`SELECT
    CAST(COALESCE(SUM(amount_cents),0) AS CHAR) AS totalCents,
    CAST(COALESCE(SUM(CASE WHEN payment_status='paid' THEN amount_cents ELSE 0 END),0) AS CHAR) AS paidCents,
    CAST(COALESCE(SUM(CASE WHEN payment_status='unpaid' THEN amount_cents ELSE 0 END),0) AS CHAR) AS unpaidCents
    FROM cost_entries`);
  const [byCategory] = await db.query(`SELECT category, CAST(SUM(amount_cents) AS CHAR) AS amountCents
    FROM cost_entries GROUP BY category ORDER BY SUM(amount_cents) DESC LIMIT 10`);
  const [byMonth] = await db.query(`SELECT DATE_FORMAT(cost_date,'%Y-%m') AS month, CAST(SUM(amount_cents) AS CHAR) AS amountCents
    FROM cost_entries WHERE cost_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH) GROUP BY month ORDER BY month`);
  return { ...totals, byCategory, byMonth };
}

// This dashboard is deliberately read-only and admin-scoped: it aggregates
// data that already exists (cost ledger, the projects table shared with the
// admin console's "项目管理" panel and the 汐构监督agent script) rather than
// owning any new source of truth.
export function createDashboardRouter({ db, requireLogin, requireAdmin, listProjects }) {
  const router = express.Router();
  router.use(requireLogin, requireAdmin);
  // Existing admin middleware has legacy nickname allowlists; this dashboard
  // aggregates company-wide cost totals (unlike the per-entry cost ledger,
  // which is now shared with every account), so it stays on the persisted
  // admin role check rather than the legacy nickname allowlist.
  router.use((req, res, next) => req.session.user.role === 'admin' ? next() : res.status(403).json({ ok: false, message: '仅管理员可访问数据大屏。' }));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  router.get('/screen', route(async (req, res) => {
    const [cost, allProjects] = await Promise.all([loadCostSummary(db), listProjects()]);
    const todayTs = Date.UTC(...new Date().toISOString().slice(0, 10).split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v)));
    const brief = classifyProjects(allProjects, todayTs);
    const activeCount = allProjects.filter(p => p.status === 'active').length;

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      cost,
      projects: {
        active: activeCount,
        stalled: brief.stalled.length,
        nearMilestone: brief.enriched.filter(e => e.isNearMilestone).length,
        items: brief.enriched.map(e => ({
          name: e.project.name,
          priority: e.project.priority,
          lastUpdate: e.project.lastUpdate || null,
          nextMilestone: e.project.nextMilestone || null,
          note: e.project.note || '',
          staleDays: e.staleDays,
          isStalled: e.isStalled,
          isNearMilestone: e.isNearMilestone
        }))
      },
      // 数据流向面板：钉钉数据同步尚未接入，先返回预留结构，前端据此展示“等待接入”状态。
      dataFlow: { source: 'placeholder', nodes: [], edges: [], note: '钉钉数据同步尚未接入，此处将展示任务/审批的真实流转情况。' }
    });
  }));

  return router;
}
