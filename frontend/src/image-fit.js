// 凭证图片「自适应压缩」：把浏览器能解码的任意图片（PNG / JPEG / WebP / HEIC / GIF / BMP…）
// 压到指定字节上限以内，统一输出 JPEG；PNG 源优先尝试「无损缩放」保持清晰度。
//
// 抽成独立模块的目的：核心排序/取舍逻辑是纯函数，可以在 node:test 里注入假的
// decode/encode 做确定性测试，不必依赖真实 canvas。

export const DEFAULT_MAX_DIMENSION = 2400;
const DEFAULT_SCALES = [1, 0.85, 0.7, 0.55, 0.4, 0.3];
const DEFAULT_QUALITIES = [0.92, 0.85, 0.78, 0.7, 0.62, 0.55];
// 无损（PNG）重编码很慢，档位少一点，够用就行。
export const LOSSLESS_PLAN = { scales: [1, 0.7, 0.5, 0.35], qualities: [1, 1, 1, 1] };

// 生成「从大到小」的候选压缩档，长边不超过 maxDimension。
export function fitPlan(width, height, options = {}) {
  const maxDimension = options.maxDimension || DEFAULT_MAX_DIMENSION;
  const scales = options.scales || DEFAULT_SCALES;
  const qualities = options.qualities || DEFAULT_QUALITIES;
  const base = Math.min(1, maxDimension / Math.max(width, height));
  const plan = [];
  for (let index = 0; index < scales.length; index += 1) {
    const stepWidth = Math.max(1, Math.round(width * base * scales[index]));
    const stepHeight = Math.max(1, Math.round(height * base * scales[index]));
    if (plan.some(step => step.width === stepWidth && step.height === stepHeight)) continue;
    plan.push({ width: stepWidth, height: stepHeight, quality: qualities[Math.min(index, qualities.length - 1)] });
  }
  return plan;
}

// 浏览器解码：优先 createImageBitmap（快），退化到 <img>。都不支持时直接抛错，
// 调用方会把「压缩不了」翻译成给用户看的提示，而不是静默失败。
async function defaultDecode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch { /* 换 <img> 再试一次 */ }
  }
  if (typeof Image !== 'function' || typeof URL?.createObjectURL !== 'function') {
    throw new Error('当前浏览器不支持图片压缩。');
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片无法解码。'));
      image.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

// 浏览器编码：画到 canvas 再导出。白底是为了避免透明 PNG 转 JPEG 后透明区发黑。
function defaultEncode(source, width, height, { type, quality }) {
  if (typeof document?.createElement !== 'function') return null;
  const canvas = document.createElement('canvas');
  if (typeof canvas.getContext !== 'function' || typeof canvas.toBlob !== 'function') return null;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  return new Promise(resolve => {
    canvas.toBlob(blob => resolve(blob && blob.size ? blob : null), type, quality);
  });
}

// 按档位从大到小试，返回第一个不超过 limit 的 Blob；全都不行则返回最小的那个
// （调用方自行判断是否接受，避免出现「压完反而更大」的静默错误）。
export async function shrinkImageToLimit(file, limit, options = {}) {
  const decode = options.decode || defaultDecode;
  const encode = options.encode || defaultEncode;
  const type = options.type || 'image/jpeg';
  const source = await decode(file);
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  if (!width || !height) throw new Error('图片尺寸无法识别。');
  let best = null;
  for (const step of fitPlan(width, height, options)) {
    const blob = await encode(source, step.width, step.height, { type, quality: step.quality });
    if (!blob || !blob.size) continue;
    if (!best || blob.size < best.size) best = blob;
    if (blob.size <= limit) return blob;
  }
  return best;
}
