/**
 * 存储层：优先 KV，KV 不可用时自动回退到 Blob。
 *
 * 键位布局（两种后端完全一致，便于随时切换）：
 *   config_current              当前完整文档
 *   config_snapshot_000000NN    每次写入的不可变快照
 *   config_revisions            最近 100 条快照索引（避免 list 分页）
 *
 * 为什么要有 Blob 兜底：
 *   EdgeOne 的 KV 需要在控制台「存储 → KV → 立即申请」并经审核开通、再手工绑定
 *   变量名；而 Blob 是 getStore("名字") 即用即得，首次调用平台自动建命名空间。
 *   在 KV 审批下来之前，服务靠 Blob 就能完整跑起来。
 *
 * 一致性：
 *   - KV 与 Blob 默认都是最终一致（其他边缘节点最长 60s 读到旧值）。
 *   - Blob 支持按次强一致读，本文件统一用 { consistency: 'strong' }，保证写后
 *     立刻读到新 revision，ETag / If-Match 乐观锁才有意义。代价是每次多几十毫秒。
 *   - 两者都没有跨节点 CAS，read-then-write 之间仍有极小竞争窗口：单人编辑足够，
 *     多写入者并发保存时后写者会拿到 409 并需要重试合并。
 *
 * 可通过环境变量 CONFIG_STORAGE=kv|blob 强制指定后端（默认 auto：有 KV 用 KV）。
 */
import { buildDocument, ConfigError, nowIso, seedDocument } from './contract.js';

const KEY_CURRENT = 'config_current';
const KEY_INDEX = 'config_revisions';
const MAX_HISTORY = 100;
const DEFAULT_BLOB_NAMESPACE = 'pu_tv_cloud';

const snapshotKey = (revision) => `config_snapshot_${String(revision).padStart(8, '0')}`;

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
 * - 生产环境由平台注入凭证（process.env.PAGES_BLOB_STS_ENV），SDK 自动认证，
 *   这里只需要命名空间名；命名空间不存在时平台会在首次写入时自动创建。
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
  // 强一致：写入后立刻能读到新 revision，否则 If-Match 乐观锁会误判。
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

export async function read(env) {
  const db = await backend(env);
  let document = await db.getJSON(KEY_CURRENT);
  if (!document) {
    document = seedDocument();
    await db.put(KEY_CURRENT, JSON.stringify(document));
  }
  return document;
}

export async function write(env, sections, expectedRevision) {
  const db = await backend(env);
  const current = (await db.getJSON(KEY_CURRENT)) || seedDocument();
  if (current.revision !== expectedRevision) throw new Conflict(current);

  const document = buildDocument(sections, expectedRevision + 1, nowIso());
  const payload = JSON.stringify(document);
  // 先写不可变快照，再切换 current，避免 current 指向不存在的历史。
  await db.put(snapshotKey(document.revision), payload);
  await db.put(KEY_CURRENT, payload);

  const index = (await db.getJSON(KEY_INDEX)) || [];
  index.unshift({
    revision: document.revision,
    updatedAt: document.updatedAt,
    size: new TextEncoder().encode(payload).length,
  });
  await db.put(KEY_INDEX, JSON.stringify(index.slice(0, MAX_HISTORY)));
  return document;
}

export async function revisions(env, limit = 20) {
  const db = await backend(env);
  const n = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 20, MAX_HISTORY));
  const index = (await db.getJSON(KEY_INDEX)) || [];
  return index.slice(0, n);
}

export async function readRevision(env, revision) {
  const db = await backend(env);
  return (await db.getJSON(snapshotKey(revision))) || null;
}

export async function rollback(env, revision) {
  const snapshot = await readRevision(env, revision);
  if (!snapshot) throw new ConfigError(`找不到 revision ${revision} 的快照`);
  const current = await read(env);
  return write(env, snapshot.sections, current.revision);
}
