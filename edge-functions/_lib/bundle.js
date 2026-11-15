/**
 * 套餐 → 设备文档的渲染与追平。
 *
 * 只有一处真相：套餐库。设备文档是「套餐在这一刻的渲染结果」，用
 * sections.bundleStamp 记住渲染自哪一版。GET /api/config 和编辑器的
 * 「下发」都走这里，避免两条路径产出不同结果。
 */
import { bundleStampMatches, sectionsFromBundle } from './contract.js';
import { readBundles, write } from './storage.js';

/** 按 id 找套餐；读库失败或套餐已删都返回 null（调用方保持原文档）。 */
export async function findBundle(env, id) {
  const wanted = String(id || '').trim();
  if (!wanted) return null;
  try {
    const bundles = await readBundles(env);
    return (bundles.items || []).find((item) => item && item.id === wanted) || null;
  } catch (_) {
    return null;
  }
}

/**
 * 设备绑定了套餐、且文档不是该套餐的当前版本时，用套餐整份重建。
 *
 * 返回 { document, applied }：
 *   applied=false 表示「无需动」（没绑、套餐不存在、已经是最新版）。
 * 写失败（并发 409 / 存储抖动）一律吞掉——GET 只是顺带追平，不能让终端 500；
 * 这次没追平，下一次心跳（3 分钟）还会再来。
 *
 * 用 snapshot:false：套餐变更导致的追平不是人工编辑，不应占用 100 条回滚历史。
 */
export async function applyBoundBundle(env, document, deviceId, item) {
  if (!deviceId || !item || !item.packageId) return { document, applied: false };
  const bundle = await findBundle(env, item.packageId);
  if (!bundle) return { document, applied: false };
  if (bundleStampMatches(document.sections, bundle)) return { document, applied: false };
  try {
    const next = await write(
      env, sectionsFromBundle(bundle), document.revision, deviceId, { snapshot: false },
    );
    return { document: next, applied: true };
  } catch (_) {
    return { document, applied: false };
  }
}
