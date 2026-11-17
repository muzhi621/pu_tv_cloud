/**
 * GET/PUT/POST /api/bundles —— 全局下发套餐库。
 *
 * 套餐 = 一份具名、可复用的完整配置：导航栏 + 启动/退出弹窗 + IPTV 源与分组
 * + TVBox 源与站点。终端只绑一个套餐 id，不再逐台维护 sections。
 *
 * GET   读套餐库（编辑器用；终端永远从 /api/config 拿展开后的结果）
 * PUT   整库覆盖，If-Match 乐观锁
 * POST  动作：把某个套餐下发到某台设备（绑定 + 立即渲染 + 记录下发时间）
 */
import {
  ConfigError, MAX_DOCUMENT_BYTES, normalizeBundles,
} from '../../_lib/contract.js';
import { applyBoundBundle, findBundle } from '../../_lib/bundle.js';
import {
  handle, HttpError, optionsHandler, readJsonBody, requireAuth, send,
} from '../../_lib/http.js';
import {
  countBundleDevices, isBlocked, listDevices, markPushed, read, readBundles,
  updateDevice, writeBundles,
} from '../../_lib/storage.js';

export const onRequestOptions = optionsHandler;

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    await requireAuth(request, env, 'read');
    const bundles = await readBundles(env);
    // 附带每台绑定数：编辑器列表直接显示「3 台设备在用」，不用再请求一次。
    const devices = await listDevices(env);
    const usage = {};
    for (const device of devices) {
      if (!device.packageId) continue;
      usage[device.packageId] = (usage[device.packageId] || 0) + 1;
    }
    return send({
      env,
      request,
      status: 200,
      body: { ...bundles, usage },
      document: bundles,
    });
  });
}

export async function onRequestPut(context) {
  return handle(context, async ({ env, request }) => {
    await requireAuth(request, env, 'write');
    const body = await readJsonBody(request);

    let ifMatch = (request.headers.get('If-Match') || '').trim().replace(/^"|"$/g, '');
    if (!ifMatch && Number.isInteger(body.expectedRevision)) {
      ifMatch = String(body.expectedRevision);
    }
    if (!ifMatch || !/^\d+$/.test(ifMatch)) {
      throw new ConfigError('缺少 If-Match（或 expectedRevision），拒绝覆盖未知版本');
    }

    const [bundles, warnings] = normalizeBundles(body);
    const bytes = new TextEncoder().encode(JSON.stringify(bundles)).length;
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw new ConfigError(
        `套餐库 ${Math.round(bytes / 1024)} KB 超过 ${Math.round(MAX_DOCUMENT_BYTES / 1024)} KB 上限；`
        + '套餐里存的是源引用与少量内联内容，请把大块频道移进资源库',
      );
    }

    const previous = await readBundles(env);
    const document = await writeBundles(env, bundles, Number(ifMatch));
    const ids = [...new Set([
      ...(previous.items || []).map((item) => item.id),
      ...(document.items || []).map((item) => item.id),
    ])];
    const affectedDevices = await countBundleDevices(env, ids);

    const response = {
      revision: document.revision,
      updatedAt: document.updatedAt,
      warnings,
      affectedDevices,
    };
    if (!(env.CONFIG_WRITE_TOKEN || env.CONFIG_READ_TOKEN || '').trim()) response.devMode = true;
    return send({ env, request, status: 200, body: response, document });
  });
}

/**
 * POST —— 一次性完成「绑定套餐 + 立即下发」。
 *
 * body: { deviceId, bundleId, alias? }
 *   bundleId 为空串表示解除绑定（设备回到独立配置，内容保持当前不动）。
 */
export async function onRequestPost(context) {
  return handle(context, async ({ env, request }) => {
    await requireAuth(request, env, 'write');
    const body = await readJsonBody(request);
    const deviceId = String(body.deviceId || '').trim();
    const bundleId = String(body.bundleId || '').trim();
    if (!deviceId) throw new ConfigError('缺少 deviceId');
    if (await isBlocked(env, deviceId)) {
      throw new HttpError(403, 'device_blocked', '该设备已被移除，请先解除拉黑');
    }

    if (bundleId) {
      const bundle = await findBundle(env, bundleId);
      if (!bundle) throw new ConfigError(`找不到套餐 ${bundleId}`);
    }

    // 绑定（或解绑）后立即渲染一次，用户点完「下发」不用等 3 分钟心跳。
    const item = await updateDevice(env, deviceId, { packageId: bundleId });
    const before = await read(env, deviceId);
    const { document, applied } = await applyBoundBundle(env, before, deviceId, item);
    await markPushed(env, deviceId, document.revision);
    return send({
      env,
      request,
      status: 200,
      body: {
        deviceId,
        bundleId,
        revision: document.revision,
        applied,
        // applied=false 且绑了套餐，说明文档本来就是这个套餐的最新版。
        upToDate: !!bundleId && !applied,
      },
      document,
    });
  });
}
