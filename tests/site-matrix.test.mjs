// 站点矩阵保存策略测试。
//
// 核心回归：「保存成功后本地对象不能被服务端副本替换掉」。
// 老实现 `groups = payload.groups` 会让用户正在编辑的入口变成孤儿对象，
// 表现为「保存了但没展示 / 怎么填都存不上」。这里用**引用相等**把这个根因钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSavePayload,
  commitSavePayload,
  createSiteMatrixState,
  isCompleteGroup,
  isCompleteSite,
  normalizeSiteForSave,
  pendingSummary,
  primeSiteMatrixState
} from '../frontend/src/site-matrix.js';

const serverGroupsFixture = () => ([
  { id: 105, name: '核心业务', description: '日常业务', sites: [
    { id: 782, name: '主站', url: 'https://a.com', iconUrl: '', description: '', tags: [] }
  ] }
]);

test('isCompleteSite：缺名称或地址都算「没填完」', () => {
  assert.equal(isCompleteSite({ name: 'A', url: 'https://a' }), true);
  assert.equal(isCompleteSite({ name: '  ', url: 'https://a' }), false);
  assert.equal(isCompleteSite({ name: 'A', url: '' }), false);
  assert.equal(isCompleteSite(null), false);
  assert.equal(isCompleteGroup({ name: '一组' }), true);
  assert.equal(isCompleteGroup({ name: '' }), false);
});

test('normalizeSiteForSave：字段白名单 + 标签/权限归一（脏数据不落库）', () => {
  const out = normalizeSiteForSave({
    name: ' 运营后台 ', url: ' https://x.com ', iconUrl: ' https://x/i.png ',
    description: ' 说明 ', tags: 'a，b,,c', visibility: '乱填',
    allowedRoles: ['admin', 'member', 'admin', '游客'], allowedUserIds: ['7', 7, 'abc', -3],
    快照: '不该出现'
  });
  assert.deepEqual(out, {
    name: '运营后台', url: 'https://x.com', iconUrl: 'https://x/i.png', description: '说明',
    tags: ['a', 'b', 'c'], visibility: 'all', allowedRoles: ['admin', 'member'], allowedUserIds: [7]
  });
  assert.equal('快照' in out, false, '前端临时字段不能传给后端');
});

test('回归：新增入口未填完时保存 → 本地对象必须留在 groups 里（引用不变）', () => {
  const state = createSiteMatrixState();
  const fresh = { name: '', url: '', tags: [], visibility: 'all', allowedRoles: [], allowedUserIds: [] };
  const groups = [{ id: 105, name: '核心业务', description: '', sites: [
    { id: 782, name: '主站', url: 'https://a.com', tags: [] },
    fresh
  ] }];
  primeSiteMatrixState(groups, state);

  const { groups: payload, pending, order } = buildSavePayload(groups, state);
  assert.equal(payload[0].sites.length, 1, '没填完的新入口不应提交给后端');
  assert.equal(pending.sites, 1, '并且要如实计入「未入库」');

  // 服务端返回的权威副本里没有这个入口（被后端过滤掉了）——这是老实现的触发条件
  commitSavePayload(order, serverGroupsFixture(), state);

  assert.equal(groups[0].sites.length, 2, '本地不能因为服务端副本而丢掉它');
  assert.equal(groups[0].sites[1], fresh, '必须是同一个对象引用，否则用户后续输入写进孤儿对象');
  assert.equal(groups[0].sites[0].id, 782, '已存在入口的 id 应被回填');

  // 模拟用户接着把名称/地址填完 → 下一次保存必须带上它
  fresh.name = '新后台';
  fresh.url = 'https://new.example.com';
  const next = buildSavePayload(groups, state);
  assert.equal(next.groups[0].sites.length, 2, '填完后应进入 payload');
  assert.equal(next.groups[0].sites[1].url, 'https://new.example.com');
  assert.equal(next.pending.sites, 0);
  assert.notEqual(JSON.stringify(next.groups), JSON.stringify(payload), 'payload 变化才能触发自动保存');
});

test('payload 无变化时签名不变（自动保存应跳过，避免无意义的全表重建）', () => {
  const state = createSiteMatrixState();
  const groups = [{ name: 'G', description: '', sites: [{ name: 'A', url: 'https://a', tags: [] }] }];
  primeSiteMatrixState(groups, state);
  const first = JSON.stringify(buildSavePayload(groups, state).groups);
  assert.equal(first, state.signature, '载入后签名应与当前 payload 一致 → 无改动时不提交');
  groups[0].sites[0].name = 'A2';
  assert.notEqual(JSON.stringify(buildSavePayload(groups, state).groups), state.signature);
});

test('回归：已保存入口被清空重填时，先用上次的值占位，别让后端全表重建把它删了', () => {
  const state = createSiteMatrixState();
  const site = { name: '主站', url: 'https://a.com', iconUrl: 'https://a/i.png', description: 'x', tags: ['业务'] };
  const groups = [{ name: '核心业务', description: '', sites: [site] }];
  primeSiteMatrixState(groups, state);

  site.url = '';                       // 用户正在重填
  const { groups: payload, pending } = buildSavePayload(groups, state);
  assert.equal(payload[0].sites.length, 1, '该入口仍要出现在 payload 里');
  assert.equal(payload[0].sites[0].url, 'https://a.com', '用上次保存成功的值占位');
  assert.equal(payload[0].sites[0].iconUrl, 'https://a/i.png', '其它字段也要一起保留');
  assert.equal(pending.preserved, 1);

  site.url = 'https://b.com';          // 填完
  const after = buildSavePayload(groups, state);
  assert.equal(after.groups[0].sites[0].url, 'https://b.com', '填完后按新值提交');
  assert.equal(after.pending.preserved, 0);
});

test('未命名分组不会被提交，但仍留在本地（且不误报已保存）', () => {
  const state = createSiteMatrixState();
  const groups = [
    { name: '核心业务', description: '', sites: [] },
    { name: '', description: '', sites: [{ name: 'A', url: 'https://a', tags: [] }] }
  ];
  primeSiteMatrixState(groups, state);
  const { groups: payload, pending } = buildSavePayload(groups, state);
  assert.equal(payload.length, 1, '未命名分组不入库');
  assert.equal(pending.groups, 1);
  assert.match(pendingSummary(pending), /分组还没命名/, '要说人话告知用户');
});

test('pendingSummary：多种未入库情况都要说清楚，全部正常时返回空串', () => {
  assert.equal(pendingSummary({ sites: 0, groups: 0, preserved: 0 }), '');
  const text = pendingSummary({ sites: 2, groups: 1, preserved: 3 });
  assert.match(text, /2 个新入口/);
  assert.match(text, /1 个分组/);
  assert.match(text, /3 处改动/);
});

test('commitSavePayload：没有服务端对应项时不能抛错（宽容降级）', () => {
  const state = createSiteMatrixState();
  const groups = [{ name: 'G', description: '', sites: [{ name: 'A', url: 'https://a', tags: [] }] }];
  primeSiteMatrixState(groups, state);
  const { order } = buildSavePayload(groups, state);
  commitSavePayload(order, [], state);
  assert.equal(groups[0].sites[0].id, undefined);
  commitSavePayload([], undefined, state);
});
