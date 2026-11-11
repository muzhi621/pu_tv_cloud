/**
 * EdgeOne KV 存储层：current + 不可变快照 + revision 乐观锁。
 *
 * 与 cloud/storage.py 的行为对齐，但后端换成 EdgeOne Pages KV：
 *   config_current              当前完整文档
 *   config_snapshot_000000NN    每次写入的不可变快照
 *   config_revisions            最近 100 条快照索引（避免 KV list 分页）
 *
 * 重要：KV 是「中心存储 + 边缘缓存」的最终一致性模型，其他边缘节点最长
 * 60 秒后才读到新值。写入节点立即生效，因此单人编辑 + If-Match 乐观锁可用；
 * 多节点并发写没有跨节点 CAS，个人规模足够，多写入者场景不要依赖它。
 * 免费版单值 1 MB / 账户 1 GB，本项目单份配置只有几 KB。
 */
import { buildDocument, ConfigError, nowIso, seedDocument } from './contract.js';

const KEY_CURRENT = 'config_current';
const KEY_INDEX = 'config_revisions';
const MAX_HISTORY = 100;

const snapshotKey = (revision) => `config_snapshot_${String(revision).padStart(8, '0')}`;

export class Conflict extends Error {
  constructor(current) {
    super('配置已被其他设备修改');
    this.name = 'Conflict';
    this.current = current;
  }
}

/** KV 命名空间在 EdgeOne 里是「全局变量名」，不在 context.env 上。 */
function kvStore(env) {
  const name = (env && env.CONFIG_KV_BINDING) || 'PURETV_KV';
  const fromGlobal = globalThis[name];
  const fromBinding = typeof PURETV_KV !== 'undefined' ? PURETV_KV : null;
  const store = fromGlobal || fromBinding;
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') {
    throw new Error(`KV 命名空间未绑定：请在 EdgeOne 控制台把命名空间绑定到变量名 ${name}`);
  }
  return store;
}

export async function read(env) {
  const kv = kvStore(env);
  let document = await kv.get(KEY_CURRENT, 'json');
  if (!document) {
    document = seedDocument();
    await kv.put(KEY_CURRENT, JSON.stringify(document));
  }
  return document;
}

export async function write(env, sections, expectedRevision) {
  const kv = kvStore(env);
  const current = (await kv.get(KEY_CURRENT, 'json')) || seedDocument();
  if (current.revision !== expectedRevision) throw new Conflict(current);

  const document = buildDocument(sections, expectedRevision + 1, nowIso());
  const payload = JSON.stringify(document);
  // 先写不可变快照，再切换 current，避免 current 指向不存在的历史。
  await kv.put(snapshotKey(document.revision), payload);
  await kv.put(KEY_CURRENT, payload);

  const index = (await kv.get(KEY_INDEX, 'json')) || [];
  index.unshift({
    revision: document.revision,
    updatedAt: document.updatedAt,
    size: new TextEncoder().encode(payload).length,
  });
  await kv.put(KEY_INDEX, JSON.stringify(index.slice(0, MAX_HISTORY)));
  return document;
}

export async function revisions(env, limit = 20) {
  const kv = kvStore(env);
  const n = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 20, MAX_HISTORY));
  const index = (await kv.get(KEY_INDEX, 'json')) || [];
  return index.slice(0, n);
}

export async function readRevision(env, revision) {
  const kv = kvStore(env);
  return (await kv.get(snapshotKey(revision), 'json')) || null;
}

export async function rollback(env, revision) {
  const snapshot = await readRevision(env, revision);
  if (!snapshot) throw new ConfigError(`找不到 revision ${revision} 的快照`);
  const current = await read(env);
  return write(env, snapshot.sections, current.revision);
}
