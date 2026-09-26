// 同源部署（前端与后端同域走 nginx）时留空即可；跨端口/跨域调试时可通过
// window.__TIDESAIL_API_BASE__ 覆盖，例如：
//   <script>window.__TIDESAIL_API_BASE__ = 'http://42.193.159.241:9989';</script>
function resolveApiBaseUrl() {
  const override = typeof window !== 'undefined' ? window.__TIDESAIL_API_BASE__ : '';
  if (override) {
    return String(override).replace(/\/+$/, '');
  }

  return '';
}

export const API_BASE_URL = resolveApiBaseUrl();
