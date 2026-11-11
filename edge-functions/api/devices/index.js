/**
 * /api/devices —— 上线终端注册表。
 *
 * GET  列出设备（别名 / 首次与最后上线 / App 版本 / 当前 revision）
 * POST 管理动作：rename（改别名）、delete（移除注册项）、reset（把该设备配置
 *      重置为当前全局模板，生成该设备的新 revision）
 *
 * 设计说明：「上线」以最后一次成功拉取配置为准，终端不额外发心跳，
 * 因此设备多了也不会给云端增加任何请求量。
 */
import { ConfigError } from '../../_lib/contract.js';
import {
  deviceScope, handle, optionsHandler, readJsonBody, requireAuth, send,
} from '../../_lib/http.js';
import {
  deleteDevice, listDevices, resetDevice, updateDevice, normalizeDeviceId,
} from '../../_lib/storage.js';

export const onRequestOptions = optionsHandler;

export async function onRequestGet(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'read');
    const devices = await listDevices(env);
    return send({ env, request, status: 200, body: { devices, total: devices.length } });
  });
}

const targetId = (body, request) => {
  const raw = body.deviceId || new URL(request.url).searchParams.get('deviceId');
  const id = normalizeDeviceId(raw);
  if (!id) throw new ConfigError('缺少 deviceId');
  return id;
};

export async function onRequestPost(context) {
  return handle(context, async ({ env, request }) => {
    requireAuth(request, env, 'write');
    const body = await readJsonBody(request);
    const action = String(body.action || '').trim();
    const id = targetId(body, request);

    if (action === 'rename') {
      const item = await updateDevice(env, id, { alias: body.alias || '' });
      return send({ env, request, status: 200, body: { device: item } });
    }
    if (action === 'delete') {
      const result = await deleteDevice(env, id);
      return send({ env, request, status: 200, body: result });
    }
    if (action === 'reset') {
      const document = await resetDevice(env, id);
      return send({
        env, request, status: 200, document,
        body: { deviceId: id, revision: document.revision, resetToTemplate: true },
      });
    }
    throw new ConfigError('action 必须是 rename / delete / reset 之一');
  });
}

/** 便于 /health 之类复用：从请求里取设备 id（不校验则允许为空）。 */
export const currentDeviceId = deviceScope;
