/**
 * /api/devices —— 上线终端注册表与管理接口。
 *
 * GET  列出所有连接过的设备（在线/离线状态、别名、上线时间、revision、最近下发），
 *      同时返回已拉黑的设备 id 列表与在线判定窗口。
 * POST 管理动作，支持单台 deviceId 或多台 deviceIds 批量：
 *      rename    改别名
 *      comment   备注
 *      delete    移除（软删除，仅隐藏，可 restore）
 *      restore   恢复显示
 *      purge     彻底删除 + 拉黑（终端再上线会被 403 拒绝）
 *      unblock   解除拉黑，允许重新登记
 *      reset     把该设备配置重置为当前全局模板，生成新 revision
 *      push      显式下发：即使内容没改也生成新 revision，触发终端下次心跳取新配置
 *
 * 在线判定：客户端 v3.0.14 起前台每 15 分钟同步一次配置，云端以 lastSeen
 * 距今是否超过 CONFIG_ONLINE_WINDOW_MINUTES（默认 30 分钟）兜底判定。
 */
import { ConfigError } from '../../_lib/contract.js';
import {
  deviceScope, handle, optionsHandler, readJsonBody, requireAuth, send,
} from '../../_lib/http.js';
import {
  deleteDevice, isBlocked, listBlocked, listDevices, markPushed,
  normalizeDeviceId, onlineWindowMinutes, purgeDevice, read as readConfig,
  resetDevice, restoreDevice, unblockDevice, updateDevice, write as writeConfig,
} from '../../_lib/storage.js';

export const onRequestOptions = optionsHandler;

const ACTIONS = new Set(['rename', 'comment', 'delete', 'restore', 'purge', 'unblock', 'reset', 'push']);

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'read');
    const [devices, blocked] = await Promise.all([listDevices(env), listBlocked(env)]);
    return send({
      env, request, status: 200,
      body: {
        devices,
        total: devices.length,
        online: devices.filter((item) => item.online).length,
        blocked,
        onlineWindowMinutes: onlineWindowMinutes(env),
      },
    });
  });
}

function targetIds(body, request) {
  const rawList = Array.isArray(body.deviceIds) ? body.deviceIds : [];
  const single = body.deviceId || new URL(request.url).searchParams.get('deviceId');
  const raws = rawList.length ? rawList : (single ? [single] : []);
  if (!raws.length) throw new ConfigError('缺少 deviceId 或 deviceIds');
  if (raws.some((item) => typeof item !== 'string')) {
    throw new ConfigError('deviceId / deviceIds 必须是字符串');
  }
  const ids = [...new Set(raws.map((item) => normalizeDeviceId(item)).filter(Boolean))];
  if (!ids.length) throw new ConfigError('缺少合法的 deviceId');
  if (ids.length > 50) throw new ConfigError('一次最多操作 50 台设备');
  return ids;
}

async function runAction(env, action, id, body) {
  switch (action) {
    case 'rename': {
      const item = await updateDevice(env, id, { alias: body.alias || '' });
      return { device: item };
    }
    case 'comment': {
      const item = await updateDevice(env, id, { comment: body.comment || '' });
      return { device: item };
    }
    case 'delete':
      return deleteDevice(env, id);
    case 'restore':
      return restoreDevice(env, id);
    case 'purge':
      return purgeDevice(env, id);
    case 'unblock':
      return unblockDevice(env, id);
    case 'reset': {
      const document = await resetDevice(env, id);
      return { deviceId: id, revision: document.revision, resetToTemplate: true };
    }
    case 'push': {
      if (await isBlocked(env, id)) throw new ConfigError(`设备 ${id} 已被拉黑，请先解除`);
      const current = await readConfig(env, id);
      const sections = JSON.parse(JSON.stringify(current.sections));
      const document = await writeConfig(env, sections, current.revision, id);
      await markPushed(env, id, document.revision);
      return {
        deviceId: id,
        revision: document.revision,
        pushedAt: document.updatedAt,
        note: '终端将在下次同步（前台约 15 分钟内）拉取此 revision',
      };
    }
    default:
      throw new ConfigError(`不支持的动作 ${action}`);
  }
}

export async function onRequestPost(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'write');
    const body = await readJsonBody(request);
    const action = String(body.action || '').trim();
    if (!ACTIONS.has(action)) {
      throw new ConfigError(`action 必须是 ${[...ACTIONS].join(' / ')} 之一`);
    }
    const ids = targetIds(body, request);
    const results = [];
    for (const id of ids) {
      try {
        results.push({ deviceId: id, ok: true, ...(await runAction(env, action, id, body)) });
      } catch (error) {
        results.push({ deviceId: id, ok: false, error: (error && error.message) || '操作失败' });
      }
    }
    return send({
      env, request, status: 200,
      body: {
        action,
        total: results.length,
        failed: results.filter((item) => !item.ok).length,
        results,
      },
    });
  });
}

/** 便于 /health 之类复用：从请求里取设备 id（不校验则允许为空）。 */
export const currentDeviceId = deviceScope;
