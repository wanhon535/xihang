// 凭证图片「自适应压缩」核心算法测试。
//
// 这里注入假的 decode / encode，只测「档位怎么排、取哪一个结果」的纯逻辑，
// 不依赖真实 canvas —— 页面级集成（命名、提示、payload）在
// ledger-attachment-paste.test.mjs 里覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitPlan, shrinkImageToLimit, DEFAULT_MAX_DIMENSION, LOSSLESS_PLAN } from '../frontend/src/image-fit.js';

const fakeBlob = size => ({ size });

const makeAdapter = (width, height, bytesPerPixel) => {
  const calls = [];
  return {
    calls,
    decode: async () => ({ width, height }),
    encode: async (source, w, h, { type, quality }) => {
      calls.push({ width: w, height: h, type, quality });
      return fakeBlob(Math.round(w * h * bytesPerPixel));
    }
  };
};

test('fitPlan：长边不超过 maxDimension，档位严格变小且不重复', () => {
  const plan = fitPlan(6000, 4000);
  assert.equal(plan[0].width, DEFAULT_MAX_DIMENSION, '首档应把长边压到 2400');
  assert.equal(plan[0].height, 1600, '等比缩放，短边按比例');
  for (let i = 1; i < plan.length; i += 1) {
    assert.ok(plan[i].width <= plan[i - 1].width, '档位应单调不增');
  }
  const seen = new Set(plan.map(step => `${step.width}x${step.height}`));
  assert.equal(seen.size, plan.length, '不应出现重复尺寸（重复档位是白算）');
  assert.ok(plan.every(step => step.quality > 0 && step.quality <= 1), '质量系数应在 (0,1]');
});

test('fitPlan：小图不放大，也不缩过头', () => {
  const plan = fitPlan(800, 600);
  assert.deepEqual([plan[0].width, plan[0].height], [800, 600], '本来就小于上限时保持原始尺寸');
});

test('fitPlan：支持自定义档位（无损缩放用更少的档）', () => {
  const plan = fitPlan(6000, 4000, { maxDimension: 2400, ...LOSSLESS_PLAN });
  assert.equal(plan.length, LOSSLESS_PLAN.scales.length, '档位数应与传入的 scales 一致');
  assert.equal(plan[0].quality, 1, '无损档质量系数应为 1');
});

test('shrinkImageToLimit：从大到小试，返回第一个不超限的结果', () => {
  // 2400×1600，每像素 1 字节 → 3.84MB > 3MiB；0.85 档 → 2.77MB 合格。
  const adapter = makeAdapter(6000, 4000, 1);
  const limit = 3 * 1024 * 1024;
  return shrinkImageToLimit({ size: 9_000_000 }, limit, adapter).then(blob => {
    assert.ok(blob.size <= limit, '结果必须在限额内');
    assert.equal(adapter.calls.length, 2, '应在第二档就停下，不做无谓的重编码');
    assert.deepEqual([adapter.calls[1].width, adapter.calls[1].height], [2040, 1360], '第二档应是首档的 0.85');
  });
});

test('shrinkImageToLimit：档位全用上仍压不下时，返回最小的那个（调用方再判断）', () => {
  // 每像素 200 字节 = 极端不压缩的编码器，全部档位都不可能进 3 MiB。
  const adapter = makeAdapter(4000, 3000, 200);
  const limit = 3 * 1024 * 1024;
  return shrinkImageToLimit({ size: 48_000_000 }, limit, adapter).then(blob => {
    assert.ok(blob, '应返回兜底结果，而不是 null');
    assert.ok(blob.size > limit, '确实压不下（这是预期，用于验证调用方会拒收）');
    assert.equal(adapter.calls.length, fitPlan(4000, 3000).length, '应把所有档位都试完');
  });
});

test('shrinkImageToLimit：尺寸拿不到时明确报错（不能静默返回空）', async () => {
  await assert.rejects(
    () => shrinkImageToLimit({ size: 10 }, 1024, { decode: async () => ({ width: 0, height: 0 }), encode: async () => fakeBlob(1) }),
    /尺寸无法识别/
  );
});
