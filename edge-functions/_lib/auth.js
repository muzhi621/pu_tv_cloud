/**
 * 编辑器管理员账号与会话。
 *
 * ## 为什么要有账号
 * 编辑器过去靠手填「读令牌 / 写令牌」连接，而 CONFIG_EDITOR_PRELOAD=1 的部署
 * 会把两个令牌直接注入页面——任何打开该域名的人都能拿到写权限。改成
 * 「账号 + 密码 → 会话」之后：
 *   - 浏览器只拿到会话令牌，真实写令牌永不下发到前端；
 *   - 会话有有效期、可登出、改密码时全部失效；
 *   - 登录成功后前端自动带出默认 API 地址并加载全部数据，操作者不用再记令牌。
 *
 * **终端不受影响**：终端仍然用 CONFIG_READ_TOKEN 直连。鉴权在
 * http.requireAuth 里先比真实令牌（常量时间），不是令牌才当作会话去查。
 *
 * ## 账号来源（单管理员）
 *   1. KV/Blob 里的 `auth_account`（首次登录时由环境变量初始化，之后以它为准）；
 *   2. 环境变量 CONFIG_ADMIN_USER / CONFIG_ADMIN_PASSWORD。
 * 环境变量**只在 KV 里还没有账号时**生效：否则每次重新部署都会把用户在页面上
 * 改过的密码重置回环境变量里的值。
 *
 * ## 几个刻意的取舍
 * - 会话是「KV 里的一张表」而不是无状态签名令牌：改密码必须能让所有旧会话立即
 *   失效，签名令牌在过期前做不到这一点（除非再引一层版本号查询，反而更绕）。
 * - 会话校验每次多读一次账号记录（epoch 比对）。编辑器请求量以「人手点击」计，
 *   这点开销可以忽略。
 * - 失败限流是全局计数而不是按 IP：边缘运行时拿不到可靠的真实 IP，按全局锁定
 *   对单管理员场景够用，也堵住了无限撞库。
 */

import { readMeta, writeMeta } from './storage.js';

export const AUTH_ACCOUNT_KEY = 'auth_account';
export const AUTH_SESSIONS_KEY = 'auth_sessions';
export const AUTH_GUARD_KEY = 'auth_guard';

/**
 * PBKDF2-SHA256 迭代次数。
 *
 * **必须 ≤ 100000**：EdgeOne 运行时的 WebCrypto 对 deriveBits 的迭代次数有硬上限，
 * 120000 会直接抛平台错误 `Error: Param Invalid`（实测 100000 通过、200000 失败），
 * 而 `loadAccount` 在首次登录时就要算一次哈希并落 KV，于是整个登录接口 500。
 * 这个错误没有堆栈、只有一句平台文案，曾经把问题指向 KV 写入，实际是算法参数。
 *
 * 10 万次在 V8 上约 60~80ms，对单管理员账号够用；盐 16 字节、摘要 32 字节不变。
 */
const PBKDF2_ITERATIONS = 100000;
/** 运行时上限（实测值）。旧账号若记着更大的数，校验时会明确报错而不是 500 空错误。 */
export const PBKDF2_MAX_ITERATIONS = 100000;
const SALT_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;
const MAX_SESSIONS = 20;
const DEFAULT_SESSION_HOURS = 12;
const MAX_SESSION_HOURS = 24 * 7;
/** 连续失败次数与锁定时长：单管理员场景，5 次 / 5 分钟足够。 */
const MAX_GUARD_FAILS = 5;
const GUARD_LOCK_MS = 5 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_USER = 'admin';

/* ---------------- 基础工具 ---------------- */

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return toHex(buffer);
}

function subtle() {
  const crypto = globalThis.crypto;
  if (!crypto || !crypto.subtle) {
    throw new Error('运行时不支持 WebCrypto（crypto.subtle），无法校验密码');
  }
  return crypto.subtle;
}

/** 常量时间比较：长度不同也走完整循环，避免用响应时间推断内容。 */
export function safeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  let diff = left.length ^ right.length;
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function sha256Hex(text) {
  const digest = await subtle().digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

async function pbkdf2Hex(password, saltHex, iterations) {
  const key = await subtle().importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await subtle().deriveBits(
    {
      name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256',
    },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

function sessionHours(env) {
  const raw = Number((env && env.CONFIG_SESSION_HOURS) || DEFAULT_SESSION_HOURS);
  if (!Number.isFinite(raw)) return DEFAULT_SESSION_HOURS;
  return Math.min(Math.max(Math.round(raw), 1), MAX_SESSION_HOURS);
}

/* ---------------- 账号 ---------------- */

async function buildAccount(user, password, epoch = 1) {
  const salt = randomHex(SALT_BYTES);
  const hash = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
  return {
    user,
    salt,
    hash,
    iterations: PBKDF2_ITERATIONS,
    epoch,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeAccount(raw) {
  return {
    user: String(raw.user || DEFAULT_USER),
    salt: String(raw.salt || ''),
    hash: String(raw.hash || ''),
    iterations: Number(raw.iterations) || PBKDF2_ITERATIONS,
    epoch: Number(raw.epoch) || 1,
    updatedAt: raw.updatedAt || '',
  };
}

/** 读账号；KV 里没有时用环境变量初始化一次。返回 null 表示「还没配置账号」。 */
export async function loadAccount(env) {
  const stored = await readMeta(env, AUTH_ACCOUNT_KEY);
  if (stored && typeof stored === 'object' && stored.hash && stored.salt) {
    return normalizeAccount(stored);
  }
  const user = String((env && env.CONFIG_ADMIN_USER) || '').trim() || DEFAULT_USER;
  const password = String((env && env.CONFIG_ADMIN_PASSWORD) || '');
  if (!password) return null;
  // 密码太短的环境变量同样不接受：与其让弱口令上线，不如明确报「未初始化」。
  if (password.length < MIN_PASSWORD_LENGTH) return null;
  const account = await buildAccount(user, password);
  await writeMeta(env, AUTH_ACCOUNT_KEY, account);
  return account;
}

export async function verifyPassword(account, password) {
  if (!account || !account.salt || !account.hash) return false;
  if (Number(account.iterations) > PBKDF2_MAX_ITERATIONS) {
    // 只可能来自早期版本（或手改的 KV）：运行时算不了这么大的迭代，
    // 与其抛平台文案，不如给出「删掉 auth_account 重新初始化」的明确指引。
    throw new Error(
      `账号记录的 PBKDF2 迭代次数 ${account.iterations} 超出运行时上限`
      + ` ${PBKDF2_MAX_ITERATIONS}，请删除存储里的 auth_account 后重新部署初始化`,
    );
  }
  const candidate = await pbkdf2Hex(String(password || ''), account.salt, account.iterations);
  return safeEqual(candidate, account.hash);
}

/** 登录页用：告诉前端「服务端配没配账号」，不泄露用户名。 */
export async function authStatus(env) {
  const stored = await readMeta(env, AUTH_ACCOUNT_KEY);
  if (stored && typeof stored === 'object' && stored.hash) {
    return { initialized: true, source: 'stored' };
  }
  const password = String((env && env.CONFIG_ADMIN_PASSWORD) || '');
  if (password.length >= MIN_PASSWORD_LENGTH) {
    return { initialized: true, source: 'env' };
  }
  return {
    initialized: false,
    source: 'none',
    hint: '设置环境变量 CONFIG_ADMIN_PASSWORD（至少 8 位；可另设 CONFIG_ADMIN_USER，默认 admin）后重新部署',
  };
}

/* ---------------- 会话 ---------------- */

async function readSessions(env) {
  const table = await readMeta(env, AUTH_SESSIONS_KEY);
  if (!table || typeof table !== 'object' || typeof table.sessions !== 'object' || !table.sessions) {
    return {};
  }
  return table.sessions;
}

export async function createSession(env, account) {
  const token = randomHex(SESSION_TOKEN_BYTES);
  // 表里存的是 token 的摘要而不是 token 本身：万一 KV 被读到，也无法据此登录。
  const id = (await sha256Hex(token)).slice(0, 32);
  const now = Date.now();
  const expiresAt = now + sessionHours(env) * 3600 * 1000;

  const current = await readSessions(env);
  const sessions = {};
  for (const [key, item] of Object.entries(current)) {
    if (item && Number(item.exp) > now) sessions[key] = item;
  }
  sessions[id] = { user: account.user, exp: expiresAt, epoch: account.epoch };
  // KV 单值有上限，而「登录一次加一条」会一路涨到写不进去：只留最近 20 条。
  const trimmed = Object.entries(sessions)
    .sort((a, b) => (Number(b[1].exp) || 0) - (Number(a[1].exp) || 0))
    .slice(0, MAX_SESSIONS);
  await writeMeta(env, AUTH_SESSIONS_KEY, {
    sessions: Object.fromEntries(trimmed),
    updatedAt: new Date().toISOString(),
  });
  return { token, user: account.user, expiresAt };
}

/** 校验会话令牌；无效/过期/密码已改一律返回 null。 */
export async function lookupSession(env, token) {
  const value = String(token || '');
  if (value.length < 32) return null;
  const id = (await sha256Hex(value)).slice(0, 32);
  const sessions = await readSessions(env);
  const item = sessions[id];
  if (!item) return null;
  if (!(Number(item.exp) > Date.now())) return null;
  // 改密码会让 epoch 前进：旧会话即使没到期也必须失效，否则「改完密码旧设备
  // 还能继续用」就是安全漏洞。
  const account = await readMeta(env, AUTH_ACCOUNT_KEY);
  if (!account || Number(account.epoch) !== Number(item.epoch)) return null;
  return { user: String(item.user || ''), expiresAt: Number(item.exp) };
}

export async function revokeSession(env, token) {
  const value = String(token || '');
  if (!value) return;
  const id = (await sha256Hex(value)).slice(0, 32);
  const sessions = await readSessions(env);
  if (!sessions[id]) return;
  delete sessions[id];
  await writeMeta(env, AUTH_SESSIONS_KEY, {
    sessions,
    updatedAt: new Date().toISOString(),
  });
}

async function revokeAllSessions(env) {
  await writeMeta(env, AUTH_SESSIONS_KEY, {
    sessions: {},
    updatedAt: new Date().toISOString(),
  });
}

/* ---------------- 失败限流 ---------------- */

export async function guardState(env) {
  const guard = await readMeta(env, AUTH_GUARD_KEY);
  const until = Number(guard && guard.until) || 0;
  return {
    locked: until > Date.now(),
    until,
    fails: Number(guard && guard.fails) || 0,
    retryAfterSeconds: until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0,
  };
}

export async function noteLoginFailure(env) {
  const guard = (await readMeta(env, AUTH_GUARD_KEY)) || {};
  const fails = (Number(guard.fails) || 0) + 1;
  const locked = fails >= MAX_GUARD_FAILS;
  const until = locked ? Date.now() + GUARD_LOCK_MS : 0;
  await writeMeta(env, AUTH_GUARD_KEY, {
    // 锁定后把计数归零：解锁时从干净状态重新计数，否则下一次失败立刻又锁。
    fails: locked ? 0 : fails,
    until,
    updatedAt: new Date().toISOString(),
  });
  return { fails, locked, until };
}

export async function clearLoginFailures(env) {
  await writeMeta(env, AUTH_GUARD_KEY, {
    fails: 0,
    until: 0,
    updatedAt: new Date().toISOString(),
  });
}

/* ---------------- 改密码 ---------------- */

export async function changePassword(env, account, oldPassword, newPassword) {
  if (!(await verifyPassword(account, oldPassword))) {
    return { ok: false, reason: 'bad_password' };
  }
  const next = String(newPassword || '');
  if (next.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: 'weak_password', minLength: MIN_PASSWORD_LENGTH };
  }
  if (safeEqual(next, String(oldPassword || ''))) {
    return { ok: false, reason: 'same_password' };
  }
  const updated = await buildAccount(account.user, next, (Number(account.epoch) || 1) + 1);
  await writeMeta(env, AUTH_ACCOUNT_KEY, updated);
  // 改完密码所有会话作废：编辑器会引导重新登录。
  await revokeAllSessions(env);
  return { ok: true };
}

export const AUTH_LIMITS = {
  minPasswordLength: MIN_PASSWORD_LENGTH,
  maxSessions: MAX_SESSIONS,
  defaultSessionHours: DEFAULT_SESSION_HOURS,
  maxGuardFails: MAX_GUARD_FAILS,
};
