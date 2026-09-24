#!/usr/bin/env node
// 汐构项目监督agent：读取项目状态列表，做停滞/临近节点/优先级判断，
// 生成结构化 JSON + 钉钉简报 markdown，并按规则触发短信预警。
//
// 用法：
//   node scripts/xigou-supervisor-brief.mjs [选项]
//
// 选项：
//   --data=<path>      改用本地 JSON 文件作为项目数据源（离线测试用）；不传则从数据库的
//                       项目管理模块读取，和管理中枢“项目管理”面板、数据大屏共用同一份数据
//   --date=<YYYY-MM-DD> 以指定日期作为“今天”，默认取系统当前日期，便于测试
//   --send-sms         真正发送停滞预警短信（需配置短信网关环境变量），默认只是预演不发送
//   --send-dingtalk    真正发送钉钉工作通知（需配置钉钉应用环境变量），默认只是预演不发送
//   --out-dir=<path>   简报输出目录，默认 data/reports
//
// 本脚本不做任何技术方案判断，只按固定规则整理“今天该推进什么”，
// 具体开发工作仍由对应项目团队 / 其他执行 agent 负责。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { toUtcMidnight, daysBetween, formatDate, classifyProjects } from '../backend/src/project-status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MAX_TODAY_TASKS = 12;

function parseArgs(argv) {
  const args = { sendSms: false, sendDingtalk: false };
  for (const raw of argv) {
    const [key, value] = raw.replace(/^--/, '').split(/=(.*)/s);
    if (key === 'data') args.dataPath = value;
    else if (key === 'date') args.date = value;
    else if (key === 'out-dir') args.outDir = value;
    else if (key === 'send-sms') args.sendSms = true;
    else if (key === 'send-dingtalk') args.sendDingtalk = true;
  }
  return args;
}

// data/xigou-projects.json (the --data= offline-testing format) predates the
// projects table and still uses snake_case field names; classifyProjects()
// (backend/src/project-status.js) speaks the camelCase shape listProjects()
// returns, so this converts once at load time rather than adapting on every read.
function snakeToCamelProject(row) {
  return {
    name: row.name,
    status: row.status,
    priority: row.priority,
    lastUpdate: row.last_update,
    nextMilestone: row.next_milestone,
    nextMilestoneDate: row.next_milestone_date,
    note: row.note,
    ownerPhone: row.owner_phone
  };
}

async function loadProjectsFromFile(dataPath) {
  const raw = await readFile(dataPath, 'utf8');
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.projects;
  if (!Array.isArray(list)) {
    throw new Error(`项目数据文件格式不对：${dataPath} 需要是数组，或包含 projects 数组字段。`);
  }
  return list.map(snakeToCamelProject);
}

function renderMarkdown(date, brief) {
  const lines = [`# 汐构今日推进清单 · ${date}`, ''];

  lines.push('## 🔴 停滞预警');
  if (brief.stalled.length === 0) lines.push('- 暂无停滞项目');
  else for (const s of brief.stalled) lines.push(`- 【${s.name}】${s.reason}`);
  lines.push('');

  lines.push('## 今日任务');
  if (brief.todayTasks.length === 0) lines.push('- 暂无待推进任务');
  else for (const t of brief.todayTasks) {
    const marker = t.isNearMilestone ? '<font color="#FF4D4F">[临近节点]</font> ' : '';
    lines.push(`- 【${t.name}】${marker}${t.task}`);
  }
  lines.push('');

  lines.push('## 本周待推进');
  if (brief.backlog.length === 0) lines.push('- 暂无积压任务');
  else for (const b of brief.backlog) lines.push(`- 【${b.name}】${b.task}`);

  if (brief.dataIssues.length > 0) {
    lines.push('', '## ⚠️ 数据缺失');
    for (const issue of brief.dataIssues) lines.push(`- 【${issue.name}】${issue.issue}`);
  }

  return lines.join('\n');
}

// One shared DB session for the whole run (db.js's pool is a module-level
// singleton — opening/closing it more than once per process leaves the second
// user holding a dead pool). SMS/DingTalk config is best-effort and falls back
// to .env if MySQL isn't reachable; the project list is not optional unless
// --data was given, so its failure is surfaced to the caller.
async function loadFromDatabase({ needProjects }) {
  const config = {
    sms: {
      provider: process.env.SMS_PROVIDER || 'aliyun',
      accessKeyId: process.env.ALIYUN_SMS_ACCESS_KEY_ID || '',
      accessKeySecret: process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || '',
      signName: process.env.ALIYUN_SMS_SIGN_NAME || '',
      templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE || ''
    },
    dingtalk: {
      appKey: process.env.DINGTALK_NOTIFY_APP_KEY || '',
      appSecret: process.env.DINGTALK_NOTIFY_APP_SECRET || '',
      agentId: process.env.DINGTALK_NOTIFY_AGENT_ID || '',
      userIds: process.env.DINGTALK_NOTIFY_USER_IDS || '',
      deptIds: process.env.DINGTALK_NOTIFY_DEPT_IDS || ''
    }
  };
  let projects = null;
  let projectsError = null;
  let pool;
  try {
    const dbModule = await import('../backend/src/db.js');
    pool = dbModule.getPool();
    const settings = await dbModule.listSystemSettings();
    if (settings.smsProvider) config.sms.provider = settings.smsProvider;
    if (settings.smsAccessKeyId) config.sms.accessKeyId = settings.smsAccessKeyId;
    if (settings.smsSignName) config.sms.signName = settings.smsSignName;
    if (settings.smsTemplateCode) config.sms.templateCode = settings.smsTemplateCode;
    if (settings.smsAccessKeySecret) config.sms.accessKeySecret = await dbModule.getDecryptedSystemSetting('smsAccessKeySecret');
    if (settings.dingtalkNotifyAppKey) config.dingtalk.appKey = settings.dingtalkNotifyAppKey;
    if (settings.dingtalkNotifyAgentId) config.dingtalk.agentId = settings.dingtalkNotifyAgentId;
    if (settings.dingtalkNotifyUserIds) config.dingtalk.userIds = settings.dingtalkNotifyUserIds;
    if (settings.dingtalkNotifyDeptIds) config.dingtalk.deptIds = settings.dingtalkNotifyDeptIds;
    if (settings.dingtalkNotifyAppSecret) config.dingtalk.appSecret = await dbModule.getDecryptedSystemSetting('dingtalkNotifyAppSecret');
    if (needProjects) {
      projects = await dbModule.listProjects();
    }
  } catch (error) {
    console.warn(`[配置] 未能连接数据库读取管理中枢的自动化通知配置，回退到 .env：${error.message}`);
    if (needProjects) projectsError = error;
  } finally {
    await pool?.end().catch(() => {});
  }
  return { config, projects, projectsError };
}

async function loadState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return { date: null, smsSentProjects: [] };
  }
}

async function saveState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

// ---- 短信预警：阿里云短信服务（Dysmsapi）RPC 签名 ----
// 未经真实凭证验证；接入前请先用单个号码小流量测试，再放开 --send-sms。
function aliyunPercentEncode(str) {
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

async function sendSmsAliyun({ sms, phone, message, dryRun }) {
  const { accessKeyId, accessKeySecret, signName, templateCode } = sms;
  const templateParamKey = process.env.ALIYUN_SMS_TEMPLATE_PARAM_KEY || 'content';

  if (!accessKeyId || !accessKeySecret || !signName || !templateCode) {
    return { sent: false, reason: '缺少短信网关配置（管理中枢 → 自动化通知，或 .env 的 ALIYUN_SMS_*），短信未发送' };
  }
  if (!phone) {
    return { sent: false, reason: '项目未配置负责人手机号（ownerPhone），短信未发送' };
  }
  if (dryRun) {
    return { sent: false, reason: '预演模式（未加 --send-sms），未实际发送', preview: message };
  }

  const params = {
    AccessKeyId: accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: 'cn-hangzhou',
    SignName: signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ [templateParamKey]: message.slice(0, 40) }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25'
  };

  const sortedKeys = Object.keys(params).sort();
  const canonicalized = sortedKeys.map(k => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(params[k])}`).join('&');
  const stringToSign = `GET&${aliyunPercentEncode('/')}&${aliyunPercentEncode(canonicalized)}`;
  const signature = crypto.createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
  const query = `${canonicalized}&Signature=${aliyunPercentEncode(signature)}`;

  const body = await new Promise((resolve, reject) => {
    https.get(`https://dysmsapi.aliyuncs.com/?${query}`, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });

  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = { Message: body }; }
  return { sent: parsed.Code === 'OK', reason: parsed.Message || parsed.Code || '未知响应', raw: parsed };
}

async function sendSms({ sms, phone, message, dryRun }) {
  const provider = (sms.provider || 'aliyun').toLowerCase();
  if (provider === 'aliyun') return sendSmsAliyun({ sms, phone, message, dryRun });
  return { sent: false, reason: `短信服务商 ${provider} 暂未实现，目前只支持 aliyun，请先手动发送或补充实现` };
}

// ---- 钉钉工作通知：企业内部应用 ----
// 需要在钉钉开放平台为该应用开通“企业内部应用”消息发送权限，
// 和现有 SSO 登录用的 DingTalk OAuth 应用不一定是同一个应用/权限范围。
async function getDingtalkAccessToken(dingtalk) {
  const { appKey, appSecret } = dingtalk;
  if (!appKey || !appSecret) return null;
  const body = await new Promise((resolve, reject) => {
    https.get(`https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  return parsed.errcode === 0 ? parsed.access_token : null;
}

async function sendDingtalkNotification({ dingtalk, markdown, dryRun }) {
  const { appKey, appSecret, agentId, userIds, deptIds } = dingtalk;
  if (!appKey || !appSecret || !agentId || (!userIds && !deptIds)) {
    return { sent: false, reason: '缺少钉钉工作通知配置（管理中枢 → 自动化通知，或 .env 的 DINGTALK_NOTIFY_*），工作通知未发送' };
  }
  if (dryRun) {
    return { sent: false, reason: '预演模式（未加 --send-dingtalk），未实际发送' };
  }

  // 钉钉工作通知失败（网络问题、返回非 JSON 等）不能让 main() 整体 reject——
  // 那样后面停滞项目的短信预警循环就会被跳过，即使两者毫无关系。
  try {
    const accessToken = await getDingtalkAccessToken(dingtalk);
    if (!accessToken) return { sent: false, reason: '获取钉钉 access_token 失败，请检查 AppKey/AppSecret 配置' };

    const payload = JSON.stringify({
      agent_id: agentId,
      userid_list: userIds || undefined,
      dept_id_list: deptIds || undefined,
      to_all_user: false,
      msg: { msgtype: 'markdown', markdown: { title: '汐构今日推进清单', text: markdown } }
    });

    const body = await new Promise((resolve, reject) => {
      const req = https.request(`https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${accessToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    let parsed;
    try { parsed = JSON.parse(body); } catch { return { sent: false, reason: `钉钉接口返回了非预期内容：${body.slice(0, 200)}` }; }
    return { sent: parsed.errcode === 0, reason: parsed.errmsg || '未知响应', raw: parsed };
  } catch (error) {
    return { sent: false, reason: `钉钉工作通知发送失败：${error.message}` };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(ROOT, args.outDir || 'data/reports');
  const statePath = path.resolve(ROOT, 'data/xigou-supervisor-state.json');

  const todayTs = args.date ? toUtcMidnight(args.date) : toUtcMidnight(new Date().toISOString());
  if (todayTs === null) throw new Error(`--date 格式不对：${args.date}，需要 YYYY-MM-DD`);
  const date = formatDate(todayTs);

  const useFile = Boolean(args.dataPath);
  const { config, projects: dbProjects, projectsError } = await loadFromDatabase({ needProjects: !useFile });
  if (!useFile && projectsError) {
    throw new Error(`无法从数据库读取项目数据（管理中枢 → 项目管理）：${projectsError.message}。也可以用 --data=<path> 指定本地 JSON 文件离线运行。`);
  }
  const projects = useFile ? await loadProjectsFromFile(path.resolve(ROOT, args.dataPath)) : dbProjects;
  const brief = classifyProjects(projects, todayTs, { maxTodayTasks: MAX_TODAY_TASKS });
  const jsonOutput = { date, stalled: brief.stalled, today_tasks: brief.todayTasks, backlog: brief.backlog, data_issues: brief.dataIssues };
  const markdown = renderMarkdown(date, brief);

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, `xigou-brief-${date}.json`), JSON.stringify(jsonOutput, null, 2), 'utf8');
  await writeFile(path.join(outDir, `xigou-brief-${date}.md`), markdown, 'utf8');

  console.log(JSON.stringify(jsonOutput, null, 2));
  console.log('\n---\n');
  console.log(markdown);

  // 分发：钉钉完整简报发给项目负责人/管理层群；短信只用于停滞预警，同一项目同一天最多一条。
  const dingtalkResult = await sendDingtalkNotification({ dingtalk: config.dingtalk, markdown, dryRun: !args.sendDingtalk });
  console.log(`\n[钉钉工作通知] ${dingtalkResult.sent ? '已发送' : '未发送'} - ${dingtalkResult.reason}`);

  const state = await loadState(statePath);
  if (state.date !== date) { state.date = date; state.smsSentProjects = []; }
  const smsResults = [];
  for (const s of brief.stalled) {
    if (state.smsSentProjects.includes(s.name)) {
      smsResults.push({ name: s.name, sent: false, reason: '今天已经发过短信，跳过' });
      continue;
    }
    const project = projects.find(p => p.name === s.name);
    const message = `【汐构监督】${s.name} 已停滞 ${s.days} 天，请及时跟进。`;
    const result = await sendSms({ sms: config.sms, phone: project?.ownerPhone, message, dryRun: !args.sendSms });
    smsResults.push({ name: s.name, ...result });
    if (result.sent) state.smsSentProjects.push(s.name);
  }
  await saveState(statePath, state);
  for (const r of smsResults) console.log(`[短信预警] ${r.name}: ${r.sent ? '已发送' : '未发送'} - ${r.reason}`);
}

main().catch(error => {
  console.error('汐构监督agent执行失败：', error.message);
  process.exitCode = 1;
});
