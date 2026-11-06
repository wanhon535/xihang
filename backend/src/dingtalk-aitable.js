// ---------------------------------------------------------------------------
// 钉钉 AI 表格（MCP 网关）客户端 + 「申请中心」表单目录
//
// 关键设计：表单是「配置驱动」的。
// 以后要新增一类申请，只需在 APPLY_FORMS 里追加一个对象（含字段元数据），
// 后端路由和前端页面都会自动长出来，不用改任何页面代码。
// ---------------------------------------------------------------------------

const DEFAULT_GATEWAY_URL =
  'https://mcp-gw.dingtalk.com/server/453154e71fbbd303b1457bd8bb20703686abb4a2dab4b8df7a15a38f990f77a1?key=01e496bf5e015840fdd0e1d0fcd99cc1';

const GATEWAY_URL = process.env.DINGTALK_AITABLE_MCP_URL || DEFAULT_GATEWAY_URL;

/** 资源到期登记表 */
export const RESOURCE_EXPIRY_TABLE = {
  baseId: 'LeBq413JAw6Lpo45Tq5gzj5KWDOnGvpb',
  tableId: 'cOwb5BK',
  viewUrl: 'https://alidocs.dingtalk.com/i/nodes/LeBq413JAw6Lpo45Tq5gzj5KWDOnGvpb',
  formUrl: 'https://alidocs.dingtalk.com/notable/share/form/v01PdnpYMXvdkwxpqw9_cOwb5BK_GidR8SI',
  fields: {
    name: 'besqBAi',
    type: 'TzMPHCm',
    due: 'gHHYyjn',
    status: 'jNeCe7A',
    owner: 'xEPYzFm',
    vendor: '4yCEFaA',
    amount: 'VaSNYzv',
    autoRenew: 'V3LOhSe',
    note: 'q93gLNA'
  }
};

/** 电商采集任务表 */
export const ECOMMERCE_TABLE = {
  baseId: 'b9Y4gmKWrPjvR1zNTrGYXBgQJGXn6lpz',
  tableId: 'SlJuaks',
  viewUrl: 'https://alidocs.dingtalk.com/i/nodes/b9Y4gmKWrPjvR1zNTrGYXBgQJGXn6lpz',
  formUrl: 'https://alidocs.dingtalk.com/notable/share/form/v01bEnBVGPZWKz03nP1_SlJuaks_kxTMKkZ',
  fields: {
    task: 'IzGq47X',
    platform: 'sm6PNnJ',
    pageType: 'Yuwr8do',
    refUrl: 'vhtUDAt',
    scope: 'XNodIKz',
    site: '8KRXKbm',
    qty: 'VKPl1cD',
    priority: 'H0WGyKK',
    owner: 'Y9OqvIT',
    due: 'zdl9M7k',
    status: 'BxHBcXA',
    note: 'bkhT51Q',
    // 可重复填写的上架金额：amounts 存明细文本，amountTotal 存自动合计
    amounts: 'h0tN4zq',
    amountTotal: 'LfYCAbo'
  }
};

/**
 * 「申请中心」的表单目录。
 * 新增一类申请 = 往这个数组里加一项。前端卡片、表单、校验、写入全部自动生效。
 *
 * field.type 支持：text | textarea | select | date | number | currency | owner
 *   - owner 由登录身份自动带入，不需要用户填
 *   - select 必须有 options
 *   - default 会写进表格（如状态默认值）
 */
export const APPLY_FORMS = [
  {
    key: 'resource',
    title: '资源到期登记',
    subtitle: '域名 · 服务器 · IP · 证书 · License',
    description: '登记后有到期提醒，到期前 7 天和 1 天自动推送到钉钉群。',
    icon: 'clock',
    accent: 'amber',
    successText: '已登记，到期前 7 天 / 1 天会自动提醒',
    table: RESOURCE_EXPIRY_TABLE,
    defaults: { status: '正常' },
    fields: [
      // 顺序按「两列成对」排：除了 wide 字段，每两个一组正好填满一行，
      // 否则会出现某一行只占左半列、右边留一大块黑的观感问题。
      { key: 'name', fieldId: 'name', label: '资源名称', type: 'text', required: true, max: 200, wide: true, section: '基本信息', placeholder: '如 api.example.com / 42.193.159.241 / ALI-ECS-01' },
      { key: 'type', fieldId: 'type', label: '资源类型', type: 'select', required: true, section: '到期信息', options: ['域名', '云服务器', 'IP地址', 'SSL证书', '软件License', '数据库', '对象存储', '其他'] },
      { key: 'due', fieldId: 'due', label: '到期日期', type: 'date', required: true, help: '系统按这个日期提前提醒' },
      { key: 'amount', fieldId: 'amount', label: '金额（元）', type: 'currency', required: true, placeholder: '续费金额，不确定先填预估' },
      { key: 'autoRenew', fieldId: 'autoRenew', label: '是否自动续费', type: 'select', options: ['是', '否', '未知'] },
      { key: 'vendor', fieldId: 'vendor', label: '服务商及账号', type: 'text', section: '维护信息', max: 300, placeholder: '如 阿里云 / root@xxx' },
      { key: 'owner', fieldId: 'owner', label: '负责人', type: 'owner' },
      { key: 'note', fieldId: 'note', label: '备注', type: 'textarea', section: '补充说明', max: 1000, wide: true, placeholder: '绑定的业务、续费注意事项等' }
    ]
  },
  {
    key: 'ecommerce',
    title: '电商采集申请',
    subtitle: '对标详情页 / 集合页采集',
    description: '提交采集需求，采集团队按对标页、范围、数量与交付时间执行。',
    icon: 'cart',
    accent: 'blue',
    successText: '已提交，采集任务已进入「待采集」',
    table: ECOMMERCE_TABLE,
    defaults: { status: '待采集' },
    fields: [
      { key: 'task', fieldId: 'task', label: '任务名称', type: 'text', required: true, max: 200, wide: true, section: '基本信息', placeholder: '如 XX旗舰店 秋季新品 20款' },
      { key: 'platform', fieldId: 'platform', label: '来源平台', type: 'select', required: true, section: '任务信息', options: ['淘宝', '天猫', '京东', '拼多多', '抖音', '小红书', '1688', '亚马逊', '独立站', '其他'] },
      { key: 'pageType', fieldId: 'pageType', label: '页面类型', type: 'select', required: true, options: ['商品详情页', '集合页（分类/列表）', '搜索结果页', '店铺首页', '活动专题页', '其他'] },
      { key: 'site', fieldId: 'site', label: '上架站点', type: 'text', required: true, max: 200, placeholder: '如 亚马逊美国站 / Shopify-US' },
      { key: 'due', fieldId: 'due', label: '交付日期', type: 'date' },
      { key: 'refUrl', fieldId: 'refUrl', label: '对标链接', type: 'textarea', required: true, section: '采集内容', max: 2000, rows: 2, wide: true, placeholder: '粘贴要对标的页面地址；多个链接换行分隔' },
      { key: 'scope', fieldId: 'scope', label: '采集范围', type: 'text', required: true, max: 500, wide: true, placeholder: '如 标题+主图+价格+SKU规格（不要评价）' },
      { key: 'amounts', fieldId: 'amounts', label: '期望上架金额', type: 'amountList', section: '上架金额', wide: true, totalFieldId: 'amountTotal', maxEntries: 30, help: '一个任务要上架多个商品时，点「+ 添加一条金额」逐个填，合计会自己算' },
      { key: 'qty', fieldId: 'qty', label: '采集数量', type: 'number', placeholder: '多少个 SKU / 商品' },
      { key: 'priority', fieldId: 'priority', label: '优先级', type: 'select', options: ['高', '中', '低'] },
      { key: 'owner', fieldId: 'owner', label: '负责人', type: 'owner', section: '归属与备注' },
      { key: 'note', fieldId: 'note', label: '备注', type: 'textarea', max: 1000, placeholder: '特殊要求、禁区、参考图说明等' }
    ]
  }
];

export const APPLY_FORM_MAP = new Map(APPLY_FORMS.map((form) => [form.key, form]));

/** 下发给前端的目录（不含 baseId / tableId / fieldId 等内部标识） */
export function publicFormCatalog() {
  return APPLY_FORMS.map((form) => ({
    key: form.key,
    title: form.title,
    subtitle: form.subtitle,
    description: form.description,
    icon: form.icon,
    accent: form.accent,
    successText: form.successText,
    fieldCount: form.fields.length,
    requiredCount: form.fields.filter((f) => f.required).length,
    tableViewUrl: form.table.viewUrl,
    fields: form.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: Boolean(field.required),
      options: field.options || null,
      placeholder: field.placeholder || '',
      help: field.help || '',
      max: field.max || 0,
      rows: field.rows || 0,
      section: field.section || '',
      maxEntries: field.maxEntries || 0,
      wide: Boolean(field.wide)
    }))
  }));
}

/**
 * 调用钉钉 AI 表格 MCP 网关上的一个工具。
 * 该网关是 stateless 的 JSON-RPC over HTTP，可返回 JSON 或 SSE。
 */
export async function callAitableTool(toolName, args, { timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args }
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`AI 表格网关返回 HTTP ${response.status}`);
  }

  const payload = parseRpcPayload(raw);
  if (payload?.error) {
    throw new Error(payload.error.message || 'AI 表格网关返回错误');
  }

  const result = payload?.result || {};
  const structured = result.structuredContent || null;
  if (structured) {
    if (String(structured.status || '') !== 'success') {
      const detail = structured.error?.message || structured.summary || '写入失败';
      throw new Error(detail);
    }
    return structured.data || {};
  }

  const text = Array.isArray(result.content)
    ? result.content.map((item) => item?.text || '').join('')
    : '';
  if (result.isError) {
    throw new Error(text || 'AI 表格工具执行失败');
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function parseRpcPayload(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const value = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!value || value === '[DONE]') continue;
    try {
      return JSON.parse(value);
    } catch {
      /* 继续找下一条 */
    }
  }
  return null;
}

/** 把负责人（钉钉人员字段）构造成 AI 表格要求的对象数组 */
export function buildOwnerCell(user) {
  const userId = String(user?.dingtalkUserId || '').trim();
  const corpId = String(user?.dingtalkCorpId || '').trim();
  if (!userId || !corpId) return null;
  return [{ userId, corpId }];
}

/**
 * 往指定表里写一条记录。
 * @param {object} table RESOURCE_EXPIRY_TABLE / ECOMMERCE_TABLE
 * @param {Record<string, unknown>} cells 以 fieldId 为 key 的单元格值
 */
export async function createAitableRecord(table, cells) {
  const data = await callAitableTool('create_records', {
    baseId: table.baseId,
    tableId: table.tableId,
    records: [{ cells }]
  });
  const recordIds = data?.newRecordIds || [];
  return { recordId: recordIds[0] || '', clientToken: data?.clientToken || '' };
}
