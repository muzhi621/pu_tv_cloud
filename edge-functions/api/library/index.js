/**
 * GET/PUT /api/library —— 全局资源库（IPTV 源/套餐 + TVBox 源/站点）。
 *
 * 设计目标：设备文档只保存 id 引用，源与频道只在库里存一份。
 * - 改库不写任何设备文档，设备下次 GET /api/config 时懒触发重算；
 * - 想让某台设备「冻结」在当前内容，把设备侧 lockLibrary 置 true 即可。
 *
 * PUT 要求 If-Match（或 body.expectedRevision）与配置文档一致，避免并发覆盖；
 * 响应里的 affectedDevices 只统计「未锁定且引用了本次涉及 id」的设备台数。
 */
import {
  ConfigError, MAX_LIBRARY_BYTES, normalizeLibrary,
} from '../../_lib/contract.js';
import {
  handle, optionsHandler, readJsonBody, requireAuth, send,
} from '../../_lib/http.js';
import {
  countAffectedDevices, readLibrary, writeLibrary,
} from '../../_lib/storage.js';

export const onRequestOptions = optionsHandler;

/** 收集库内所有可能被设备引用的 id（含旧库，删掉的 id 同样会影响设备）。 */
function libraryRefs(library) {
  const iptv = (library && library.iptv) || {};
  const vod = (library && library.vod) || {};
  return {
    packageIds: (Array.isArray(iptv.packages) ? iptv.packages : []).map((pkg) => pkg.id),
    sourceIds: (Array.isArray(vod.sources) ? vod.sources : []).map((item) => item.id),
    siteIds: (Array.isArray(vod.sites) ? vod.sites : []).map((item) => item.id),
  };
}

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'read');
    const library = await readLibrary(env);
    return send({
      env, request, status: 200, body: library, document: library,
    });
  });
}

export async function onRequestPut(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'write');
    const body = await readJsonBody(request);

    let ifMatch = (request.headers.get('If-Match') || '').trim().replace(/^"|"$/g, '');
    if (!ifMatch && Number.isInteger(body.expectedRevision)) {
      ifMatch = String(body.expectedRevision);
    }
    if (!ifMatch || !/^\d+$/.test(ifMatch)) {
      throw new ConfigError('缺少 If-Match（或 expectedRevision），拒绝覆盖未知版本');
    }

    const [library, warnings] = normalizeLibrary(body);
    const bytes = new TextEncoder().encode(JSON.stringify(library)).length;
    if (bytes > MAX_LIBRARY_BYTES) {
      throw new ConfigError(
        `资源库 ${Math.round(bytes / 1024)} KB 超过 ${Math.round(MAX_LIBRARY_BYTES / 1024)} KB 上限；`
        + '请精简套餐频道数或拆分成多个套餐',
      );
    }

    const previous = await readLibrary(env);
    const document = await writeLibrary(env, library, Number(ifMatch));

    // 新旧 id 都算「受影响」：被删掉的套餐/站点同样会让引用了它的设备下一跳变化。
    const before = libraryRefs(previous);
    const after = libraryRefs(document);
    const affectedDevices = await countAffectedDevices(env, {
      packageIds: [...new Set([...before.packageIds, ...after.packageIds])],
      sourceIds: [...new Set([...before.sourceIds, ...after.sourceIds])],
      siteIds: [...new Set([...before.siteIds, ...after.siteIds])],
    });

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
