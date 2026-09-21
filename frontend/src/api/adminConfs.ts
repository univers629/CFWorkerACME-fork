/**
 * 管理员 - 系统管理 API
 */
import { apiGet, apiPost, http } from './request';

export interface AdminConfsResp {
  flags: number;
  texts?: string;
  /**
   * 所有配置的快照：
   *   - 普通项返回 string
   *   - 敏感项返回 { configured: boolean }
   */
  items: Record<string, any>;
  secret_keys: string[];
}

export async function fetchAdminConfs(): Promise<AdminConfsResp> {
  return await apiGet<AdminConfsResp>('/admin/confs');
}

export async function saveAdminConf(name: string, data: any) {
  const res = await http.put(`/admin/confs/${encodeURIComponent(name)}`, {
    data,
  });
  return res.data;
}

export async function deleteAdminConf(name: string) {
  const res = await http.delete(`/admin/confs/${encodeURIComponent(name)}`);
  return res.data;
}

export async function testMail(to: string) {
  return await apiPost('/admin/confs/mail/test', { to });
}

export async function testCaptcha(token: string) {
  return await apiPost('/admin/confs/captcha/test', { token });
}

/** 发送一条 Telegram 测试消息（验证 Bot Token 与 Chat ID） */
export async function testTelegram() {
  return await apiPost('/admin/confs/telegram/test', {});
}

export interface DcvCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DcvTestResp {
  flags: number;
  texts?: string;
  checks?: DcvCheck[];
}

/** 校验 DCV 配置（Token 有效性 / Zone 权限 / DCV_AGENT 归属 / DNS 读取） */
export async function testDcv(): Promise<DcvTestResp> {
  return (await apiPost('/admin/confs/dcv/test', {})) as DcvTestResp;
}
