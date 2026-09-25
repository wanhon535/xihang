// 钉钉知识库只读同步：只拉取文档的标题/链接/更新时间做成列表，点击跳转回钉钉查看
// 正文——不搬运、不缓存文档内容本身。接口参考：
//   GET /v2.0/wiki/workspaces  获取知识库列表（返回每个知识库的 rootNodeId）
//   GET /v2.0/wiki/nodes       按 parentNodeId 分页获取子节点，递归即可拿到全部文档
// 这两个接口都要求传 operatorId（钉钉知识库的权限是按人授权的，应用本身的
// access_token 不代表能看到全部内容，只代表能"以这个人的视角"去看）。
import { getAccessToken, callOpenApi } from './dingtalk-api.js';

const MAX_NODES_PER_WORKSPACE = 300;

export async function syncDingTalkWiki({ appKey, appSecret, operatorId, db }) {
  if (!appKey || !appSecret) {
    throw new Error('尚未配置知识库同步应用的 AppKey/AppSecret。');
  }
  if (!operatorId) {
    throw new Error('尚未配置知识库同步的操作人 unionId。');
  }

  const accessToken = await getAccessToken(appKey, appSecret);
  const workspaces = await listWorkspaces(accessToken, operatorId);

  const docs = [];
  for (const workspace of workspaces) {
    if (!workspace.rootNodeId) continue;
    const nodes = await collectNodes(accessToken, operatorId, workspace.rootNodeId);
    for (const node of nodes) {
      if (node.type !== 'FILE') continue;
      docs.push({
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.name || '',
        nodeId: node.nodeId,
        name: node.name || '',
        url: node.url || '',
        modifiedTime: node.modifiedTime ? new Date(node.modifiedTime) : null
      });
    }
  }

  await db.replaceDingTalkDocs(docs);
  return { workspaces: workspaces.length, docs: docs.length };
}

async function listWorkspaces(accessToken, operatorId) {
  const workspaces = [];
  let nextToken;

  do {
    const payload = await callOpenApi('/v2.0/wiki/workspaces', accessToken, {
      operatorId,
      maxResults: 30,
      nextToken
    });
    workspaces.push(...(payload.workspaces || []));
    nextToken = payload.nextToken;
  } while (nextToken && workspaces.length < 300);

  return workspaces;
}

// Nodes can be folders (hasChildren) or files; we walk the tree breadth-first
// and cap the total per workspace so one huge space can't hang a sync run.
async function collectNodes(accessToken, operatorId, rootNodeId) {
  const collected = [];
  const queue = [rootNodeId];

  while (queue.length && collected.length < MAX_NODES_PER_WORKSPACE) {
    const parentNodeId = queue.shift();
    let nextToken;

    do {
      const payload = await callOpenApi('/v2.0/wiki/nodes', accessToken, {
        parentNodeId,
        operatorId,
        maxResults: 50,
        nextToken
      });
      for (const node of payload.nodes || []) {
        collected.push(node);
        if (node.hasChildren) queue.push(node.nodeId);
      }
      nextToken = payload.nextToken;
    } while (nextToken && collected.length < MAX_NODES_PER_WORKSPACE);
  }

  return collected;
}
