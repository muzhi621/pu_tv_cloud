/** GET/PUT /api/config —— 与终端 RemoteConfigService 的主接口。 */
import {
  ConfigError, expandIptvChannels, expandVodSites, MAX_DOCUMENT_BYTES, normalizeSections,
  viewDocument,
} from '../../_lib/contract.js';
import { applyBoundBundle } from '../../_lib/bundle.js';
import {
  deviceScope, handle, HttpError, optionsHandler, readJsonBody, requireAuth, send,
} from '../../_lib/http.js';
import {
  isBlocked, markPushed, read, readBundles, readLibrary, touchDevice, updateDevice, write,
} from '../../_lib/storage.js';

export const onRequestOptions = optionsHandler;

const clone = (value) => JSON.parse(JSON.stringify(value));

/** 被管理员拉黑的设备不再接受任何配置请求（「删除」purge 不会拉黑）。 */
async function rejectBlocked(env, id) {
  if (!id) return;
  if (await isBlocked(env, id)) {
    throw new HttpError(403, 'device_blocked', '该设备已被云端移除，请联系管理员解除拉黑');
  }
}

/** 读库失败（存储抖动）时按「没有库」处理：配置接口不能因此不可用。 */
async function safeReadLibrary(env) {
  try {
    return await readLibrary(env);
  } catch (_) {
    return null;
  }
}

/** 读套餐库失败同样不能影响下发：退化成「没有默认套餐」。 */
async function safeReadBundles(env) {
  try {
    return await readBundles(env);
  } catch (_) {
    return null;
  }
}

/**
 * 新终端第一次上线时套用「默认套餐」。
 *
 * 老流程给新设备复制全局模板，模板里没选源就是一片空白——重装 APK 换了
 * deviceId 之后又会重演一次。默认套餐把这件事变成一次显式选择：管理员在
 * 套餐卡片上点「设为默认」，之后任何新设备上线都直接有内容。
 *
 * 失败一律吞掉：绑不上就退回模板，不能让首屏配置请求 500。
 */
async function autoBindDefaultBundle(env, deviceId, item) {
  if (!deviceId || !item || !item.isNew || item.packageId) return item;
  const bundles = await safeReadBundles(env);
  const defaultId = bundles && bundles.defaultBundleId;
  if (!defaultId) return item;
  try {
    await updateDevice(env, deviceId, { packageId: defaultId });
    return { ...item, packageId: defaultId };
  } catch (_) {
    return item;
  }
}

function referencesLibrary(sections) {
  const iptv = (sections && sections.iptv) || {};
  const vod = (sections && sections.vod) || {};
  return (Array.isArray(iptv.packageIds) && iptv.packageIds.length > 0)
    || (Array.isArray(vod.sourceIds) && vod.sourceIds.length > 0)
    || (Array.isArray(vod.siteIds) && vod.siteIds.length > 0);
}

/**
 * 设备引用了全局资源库时，把设备文档「追平」到库的最新 revision。
 *
 * 只在确实有引用且未锁定时才写入，避免给每台无关设备无端 bump revision；
 * 只更新 revision 标记，不把展开后的频道落盘——否则设备文档会重复存几百 KB，
 * 且库下次改动时旧频道会残留在文档里（展开结果不再有出处）。
 * 写失败（并发 409 / 存储抖动）必须吞掉：GET 只是顺带追平，不能因此 500。
 */
async function catchUpLibrary(env, document, deviceId, library) {
  if (!deviceId || !library) return document;
  const sections = document.sections || {};
  const iptv = sections.iptv || {};
  if (iptv.lockLibrary === true) return document;
  if (!referencesLibrary(sections)) return document;
  if ((iptv.libraryRevision ?? 0) === library.revision) return document;
  try {
    const next = clone(sections);
    next.iptv = { ...(next.iptv || {}), libraryRevision: library.revision };
    next.vod = { ...(next.vod || {}), libraryRevision: library.revision };
    // 追平不是人工编辑：不写快照，避免把 100 条回滚历史上限挤爆。
    return await write(env, next, document.revision, deviceId, { snapshot: false });
  } catch (_) {
    return document;
  }
}

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    await requireAuth(request, env, 'read');
    const { id, meta } = deviceScope(request);
    await rejectBlocked(env, id);
    // 设备文档与全局资源库互不依赖，并发读：终端每 3 分钟心跳一次，两次 KV
    // 往返串行会直接叠加到首屏延迟。library 读到后透传给 catchUp/viewDocument，
    // 避免下游重复读取。
    const [document0, library] = await Promise.all([read(env, id), safeReadLibrary(env)]);
    // 每次成功拉取即视为「上线」，不额外做心跳请求。
    let item = id ? await touchDevice(env, id, meta) : null;
    // 新设备首次上线：有默认套餐就直接绑定，终端首帧即拿到完整内容。
    item = await autoBindDefaultBundle(env, id, item);
    let document = document0;

    // 套餐优先：设备绑了套餐就以套餐为准。文档落后于套餐当前版本时在这里重渲染，
    // revision 自然 +1，终端带 since 的 304 判定随即失效并拿到新内容。
    // 放在资源库追平之前：套餐本身只存 id 引用，追平完再展开才是最新库内容。
    const bound = await applyBoundBundle(env, document, id, item);
    document = bound.document;

    // 库有新版本时先追平设备 revision，再做 304 判定，终端才不会漏掉新频道。
    // library 已在开头与 document 并发读好，这里直接复用。
    document = await catchUpLibrary(env, document, id, library);

    const url = new URL(request.url);
    const since = (url.searchParams.get('since') || '').trim();
    const inm = (request.headers.get('If-None-Match') || '').trim().replace(/^"|"$/g, '');
    if ((since && since === String(document.revision))
        || (inm && inm === String(document.revision))) {
      return send({ env, request, status: 304, document });
    }
    // 编辑器要编辑套餐库，带 ?withPackages=1 才返回完整频道；终端只拿展开后的
    // channels + 套餐元数据，避免 15 分钟一次的心跳重复传几百 KB。
    const view = viewDocument(document, url.searchParams.get('withPackages') === '1', library);
    return send({
      env, request, status: 200, body: view, document,
      headers: id ? { 'X-Device-Id': id } : {},
    });
  });
}

/**
 * 锁定设备的自包含快照：lockLibrary=true 表示「以后不跟库变」，
 * 但设备自己未必有完整内容，所以服务端用库展开一次写进设备文档。
 *
 * IPTV 落 channels/groups，TVBox 落 sources/sites —— 两者锁定时语义一致：
 * 之后 expandVodSites / expandIptvChannels 看到 lockLibrary 就不再读库。
 */
async function freezeLockedChannels(env, sections) {
  const iptv = sections.iptv;
  const vod = sections.vod;
  const needIptv = iptv && iptv.lockLibrary === true
    && !(Array.isArray(iptv.channels) && iptv.channels.length)
    && Array.isArray(iptv.packageIds) && iptv.packageIds.length > 0;
  const needVod = vod && vod.lockLibrary === true
    && !(Array.isArray(vod.sites) && vod.sites.length)
    && Array.isArray(vod.sourceIds) && vod.sourceIds.length > 0;
  if (!needIptv && !needVod) return sections;

  const library = await safeReadLibrary(env);
  if (!library) return sections;

  if (needIptv) {
    // 复用展开逻辑，但把 lockLibrary 临时置 false，才能读到库里的套餐。
    const probe = { ...sections, iptv: { ...iptv, lockLibrary: false } };
    const expanded = expandIptvChannels(probe, library);
    sections.iptv.channels = expanded.iptv.channels;
    sections.iptv.groups = expanded.iptv.groups;
  }
  if (needVod) {
    const probe = { ...sections, vod: { ...vod, lockLibrary: false } };
    const expanded = expandVodSites(probe, library);
    sections.vod.sources = expanded.vod.sources;
    sections.vod.sites = expanded.vod.sites;
  }
  if (sections.iptv) sections.iptv.libraryRevision = library.revision;
  if (sections.vod) sections.vod.libraryRevision = library.revision;
  return sections;
}

export async function onRequestPut(context) {
  return handle(context, async ({ env, request }) => {
    await requireAuth(request, env, 'write');
    const { id } = deviceScope(request);
    await rejectBlocked(env, id);
    const body = await readJsonBody(request);
    if (typeof body.sections !== 'object' || body.sections === null || Array.isArray(body.sections)) {
      throw new ConfigError('请求体必须包含 sections 对象');
    }
    let ifMatch = (request.headers.get('If-Match') || '').trim().replace(/^"|"$/g, '');
    if (!ifMatch && Number.isInteger(body.expectedRevision)) {
      ifMatch = String(body.expectedRevision);
    }
    if (!ifMatch || !/^\d+$/.test(ifMatch)) {
      throw new ConfigError('缺少 If-Match（或 expectedRevision），拒绝覆盖未知版本');
    }
    let [sections, warnings] = normalizeSections(body.sections);
    sections = await freezeLockedChannels(env, sections);

    const bytes = new TextEncoder().encode(JSON.stringify(sections)).length;
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw new ConfigError(
        `配置文档 ${Math.round(bytes / 1024)} KB 超过 ${Math.round(MAX_DOCUMENT_BYTES / 1024)} KB 上限；`
        + '请精简 IPTV 频道数量或减少分组',
      );
    }
    const document = await write(env, sections, Number(ifMatch), id);
    if (id) {
      // 记录「最近下发」；这是展示用的元数据，失败不能影响已经成功的配置写入。
      try { await markPushed(env, id, document.revision); } catch (_) { /* 忽略 */ }
    }
    const response = {
      revision: document.revision,
      updatedAt: document.updatedAt,
      warnings,
      deviceId: id,
    };
    if (!(env.CONFIG_READ_TOKEN || '').trim()) response.devMode = true;
    return send({ env, request, status: 200, body: response, document });
  });
}
