/**
 * 存储层：优先 KV，KV 不可用时自动回退到 Blob。
 *
 * 键位布局（两种后端完全一致，便于随时切换）：
 *   config_current                    全局模板文档（新设备的初始配置来源）
 *   config_snapshot_000000NN          全局写入快照
 *   config_revisions                  全局快照索引
 *   device_<id>_current               某台设备的独立完整文档
 *   device_<id>_snapshot_000000NN     该设备的快照
 *   device_<id>_revisions             该设备的快照索引
 *   devices_index                     设备注册表（别名 / 上线时间 / 版本 / revision）
 *
 * 「每设备完整独立」语义：不带 deviceId 的请求读写全局模板；带 deviceId 的请求读写
 * 该设备自己的完整文档。设备首次上线时自动以当前全局模板深拷贝一份（revision 0），
 * 之后两者互不影响；改全局不会覆盖已有设备，需要编辑器里逐台改或重置设备。
 *
 * 为什么要有 Blob 兜底：EdgeOne KV 需申请审核并绑定变量名，而 Blob 是
 * getStore("名字") 即用即得，首次调用自动建命名空间。KV 审批期间靠 Blob 即可运行。
 *
 * 一致性：Blob 统一用强一致读，保证写后立刻读到新 revision，ETag / If-Match
 * 乐观锁才有意义；两者都没有跨节点 CAS，多写入者并发仍可能出现 409，重试即可。
 *
 * 可通过 CONFIG_STORAGE=kv|blob 强制指定后端（默认 auto：有 KV 用 KV）。
 */
import { buildDocument, ConfigError, nowIso, seedDocument } from './contract.js';

const KEY_CURRENT = 'config_current';
const KEY_INDEX = 'config_revisions';
const KEY_SNAPSHOT = (revision) => `config_snapshot_${String(revision).padStart(8, '0')}`;
const KEY_DEVICES = 'devices_index';
const MAX_HISTORY = 100;
const MAX_DEVICES = 200;
const DEFAULT_BLOB_NAMESPACE = 'pu_tv_cloud';
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const clone = (value) => JSON.parse(JSON.stringify(value));

export class Conflict extends Error {
  constructor(current) {
    super('配置已被其他设备修改');
    this.name = 'Conflict';
    this.current = current;
  }
}

/** 没有任何可用存储时抛出，HTTP 层映射成 503 并给出可执行的修复提示。 */
export class StorageUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageUnavailable';
  }
}

/** 校验并返回规范化的设备 id；空值表示「全局模板」，非法值直接 400。 */
export function normalizeDeviceId(raw) {
  const value = (raw || '').trim();
  if (!value) return null;
  if (!DEVICE_ID_RE.test(value)) {
    throw new ConfigError('deviceId 只能包含字母、数字、下划线或连字符，最长 64 位');
  }
  return value;
}

function scopeKeys(deviceId) {
  if (!deviceId) {
    return { current: KEY_CURRENT, index: KEY_INDEX, snapshot: KEY_SNAPSHOT };
  }
  const prefix = `device_${deviceId}_`;
  return {
    current: `${prefix}current`,
    index: `${prefix}revisions`,
    snapshot: (revision) => `${prefix}snapshot_${String(revision).padStart(8, '0')}`,
  };
}

/** KV 命名空间在 EdgeOne 里是「全局变量名」，不在 context.env 上。 */
function kvBinding(env) {
  const name = ((env && env.CONFIG_KV_BINDING) || 'PURETV_KV').trim();
  const candidates = [globalThis[name]];
  try {
    // 某些运行时把绑定挂成同名词法变量，用 typeof 探测不会抛 ReferenceError。
    if (typeof PURETV_KV !== 'undefined') candidates.push(PURETV_KV);
  } catch (_) { /* 未声明则忽略 */ }
  return candidates.find((c) => c && typeof c.get === 'function' && typeof c.put === 'function') || null;
}

let blobModule = null; // null=未加载/不可用；object=已加载模块

/**
 * 取 Blob Store。
 * - 测试和本地脚本可通过 globalThis.__PURETV_BLOB_STORE__ 注入内存实现。
 * - 生产环境由平台注入凭证（process.env.PAGES_BLOB_STS_ENV），SDK 自动认证。
 */
async function blobStore(env) {
  const injected = globalThis.__PURETV_BLOB_STORE__;
  if (injected) return injected;

  const namespace = ((env && env.CONFIG_BLOB_NAMESPACE) || '').trim() || DEFAULT_BLOB_NAMESPACE;
  if (!blobModule) {
    try {
      blobModule = await import('@edgeone/pages-blob');
    } catch (error) {
      throw new StorageUnavailable(
        `Blob SDK 未安装（${error && error.message}）：请在项目 package.json 保留 `
        + '@edgeone/pages-blob 依赖，并把安装命令设为 npm install',
      );
    }
  }
  if (typeof blobModule.getStore !== 'function') {
    throw new StorageUnavailable('Blob SDK 缺少 getStore 导出，请检查 @edgeone/pages-blob 版本');
  }
  try {
    return blobModule.getStore({ name: namespace, consistency: 'strong' });
  } catch (error) {
    throw new StorageUnavailable(
      `Blob 命名空间 ${namespace} 不可用（${error && error.message}）：`
      + 'Blob 只能在 Makers Functions 运行时内自动认证，本地脚本需额外提供 projectId 与 token',
    );
  }
}

/** 统一适配层：getJSON / put，KV 与 Blob 行为一致。 */
async function backend(env) {
  const forced = ((env && env.CONFIG_STORAGE) || 'auto').trim().toLowerCase();

  if (forced !== 'blob') {
    const kv = kvBinding(env);
    if (kv) {
      return {
        kind: 'kv',
        async getJSON(key) {
          const value = await kv.get(key, 'json');
          return value == null ? null : value;
        },
        async put(key, value) {
          await kv.put(key, value);
        },
      };
    }
    if (forced === 'kv') {
      throw new StorageUnavailable(
        'CONFIG_STORAGE=kv，但未检测到 KV 绑定：请把命名空间绑定到变量名 PURETV_KV，或改用 CONFIG_STORAGE=blob',
      );
    }
  }

  const store = await blobStore(env);
  return {
    kind: 'blob',
    async getJSON(key) {
      const value = await store.get(key, { type: 'json', consistency: 'strong' });
      return value == null ? null : value;
    },
    async put(key, value) {
      await store.set(key, value);
    },
  };
}

/** 供 /health 使用：报告当前实际生效的后端，失败不抛异常。 */
export async function describeStorage(env) {
  try {
    const db = await backend(env);
    return { backend: db.kind === 'kv' ? 'edgeone-kv' : 'edgeone-blob', ok: true };
  } catch (error) {
    return { backend: 'none', ok: false, error: error && error.message };
  }
}

/**
 * 读取配置文档。
 * - 全局：不存在时写 seed。
 * - 设备：不存在时以当前全局模板深拷贝一份（revision 0），此后完全独立。
 */
export async function read(env, deviceId = null) {
  const db = await backend(env);
  const keys = scopeKeys(deviceId);
  let document = await db.getJSON(keys.current);
  if (!document) {
    if (deviceId) {
      const template = (await db.getJSON(KEY_CURRENT)) || seedDocument();
      // 不能从 0 开始：终端首次启动会带 since=0，revision 0 会命中 304 而拿不到
      // 新设备复制出来的配置（尤其是模板已开启云端接管时）。从 1 起保证首包必达。
      const initial = Math.max(1, (template.revision || 0) + 1);
      document = buildDocument(clone(template.sections), initial, nowIso());
    } else {
      document = seedDocument();
    }
    await db.put(keys.current, JSON.stringify(document));
  }
  return document;
}

export async function write(env, sections, expectedRevision, deviceId = null) {
  const db = await backend(env);
  const keys = scopeKeys(deviceId);
  let current = await db.getJSON(keys.current);
  if (!current) {
    if (deviceId) {
      const template = (await db.getJSON(KEY_CURRENT)) || seedDocument();
      current = buildDocument(clone(template.sections),
        Math.max(1, (template.revision || 0) + 1), nowIso());
    } else {
      current = seedDocument();
    }
  }
  if (current.revision !== expectedRevision) throw new Conflict(current);

  const document = buildDocument(sections, expectedRevision + 1, nowIso());
  const payload = JSON.stringify(document);
  // 先写不可变快照，再切换 current，避免 current 指向不存在的历史。
  await db.put(keys.snapshot(document.revision), payload);
  await db.put(keys.current, payload);

  const index = (await db.getJSON(keys.index)) || [];
  index.unshift({
    revision: document.revision,
    updatedAt: document.updatedAt,
    size: new TextEncoder().encode(payload).length,
  });
  await db.put(keys.index, JSON.stringify(index.slice(0, MAX_HISTORY)));

  if (deviceId) {
    const devices = (await db.getJSON(KEY_DEVICES)) || [];
    const item = devices.find((entry) => entry.id === deviceId);
    if (item) {
      item.revision = document.revision;
      item.editedAt = document.updatedAt;
      await db.put(KEY_DEVICES, JSON.stringify(devices));
    }
  }
  return document;
}

export async function revisions(env, limit = 20, deviceId = null) {
  const db = await backend(env);
  const n = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 20, MAX_HISTORY));
  const index = (await db.getJSON(scopeKeys(deviceId).index)) || [];
  return index.slice(0, n);
}

export async function readRevision(env, revision, deviceId = null) {
  const db = await backend(env);
  return (await db.getJSON(scopeKeys(deviceId).snapshot(revision))) || null;
}

export async function rollback(env, revision, deviceId = null) {
  const snapshot = await readRevision(env, revision, deviceId);
  if (!snapshot) throw new ConfigError(`找不到 revision ${revision} 的快照`);
  const current = await read(env, deviceId);
  return write(env, snapshot.sections, current.revision, deviceId);
}

/* ---------------- 设备注册表 ---------------- */

/**
 * 终端每次拉配置时登记/刷新上线信息。「上线」= 最后一次成功拉取，不额外做心跳，
 * 因此不会给云端带来任何额外流量。
 */
export async function touchDevice(env, deviceId, meta = {}) {
  if (!deviceId) return null;
  const db = await backend(env);
  const devices = (await db.getJSON(KEY_DEVICES)) || [];
  const now = nowIso();
  let item = devices.find((entry) => entry.id === deviceId);
  if (!item) {
    item = {
      id: deviceId,
      alias: '',
      firstSeen: now,
      lastSeen: now,
      appVersion: '',
      model: '',
      revision: 0,
      editedAt: '',
    };
    devices.unshift(item);
  }
  item.lastSeen = now;
  if (meta.appVersion) item.appVersion = String(meta.appVersion).slice(0, 64);
  if (meta.model) item.model = String(meta.model).slice(0, 64);
  if (meta.deviceAlias && !item.alias) item.alias = String(meta.deviceAlias).slice(0, 64);
  const doc = await db.getJSON(scopeKeys(deviceId).current);
  if (doc) item.revision = doc.revision;
  await db.put(KEY_DEVICES, JSON.stringify(devices.slice(0, MAX_DEVICES)));
  return item;
}

export async function listDevices(env) {
  const db = await backend(env);
  return (await db.getJSON(KEY_DEVICES)) || [];
}

export async function updateDevice(env, deviceId, patch = {}) {
  const db = await backend(env);
  const devices = (await db.getJSON(KEY_DEVICES)) || [];
  const item = devices.find((entry) => entry.id === deviceId);
  if (!item) throw new ConfigError(`找不到设备 ${deviceId}`);
  if (typeof patch.alias === 'string') item.alias = patch.alias.trim().slice(0, 64);
  await db.put(KEY_DEVICES, JSON.stringify(devices));
  return item;
}

/** 删除只移除注册项；该设备的文档与快照保留，重新上线时会恢复显示。 */
export async function deleteDevice(env, deviceId) {
  const db = await backend(env);
  const devices = (await db.getJSON(KEY_DEVICES)) || [];
  const next = devices.filter((entry) => entry.id !== deviceId);
  if (next.length === devices.length) throw new ConfigError(`找不到设备 ${deviceId}`);
  await db.put(KEY_DEVICES, JSON.stringify(next));
  return { id: deviceId, removed: true };
}

/** 把某台设备的配置重置为当前全局模板，生成该设备的新 revision。 */
export async function resetDevice(env, deviceId) {
  const template = await read(env, null);
  const current = await read(env, deviceId);
  return write(env, clone(template.sections), current.revision, deviceId);
}
