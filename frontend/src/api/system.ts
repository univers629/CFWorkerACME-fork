/**
 * 系统级接口：
 *   - GET  /bootstrap   → 初始化/数据源探测结果
 *   - POST /setup       → 系统初始化
 *
 * 其它管理类接口（如 /admin/*）请放在独立模块中。
 */

import { apiGet, apiPost } from './request';

export interface BootstrapInfo {
  initialized: boolean;
  site_title: string;
  site_host: string;
  mail_enabled: boolean;
  db_source: 'd1' | 'mysql' | 'prisma' | 'unset';
  db_ok: boolean;
  db_error?: string;
  register_allow: boolean;
  register_code_required: boolean;
  cert_captcha: {
    enabled: boolean;
    provider: string;
    site_key: string;
  };
  /**
   * 登录 / 注册 / 找回密码发送邮件验证码的人机验证开关。
   * 与 cert_captcha 共用同一套 provider / site_key 凭证。
   */
  base_captcha: {
    enabled: boolean;
    provider: string;
    site_key: string;
  };
  /** 当前启用、可供用户选择的 CA 标识；未列出的厂商不展示 */
  ca_signs?: string[];
  /**
   * 初始化安全模式（后端返回）：
   *   preset —— 已用 ADMIN_MAIL/ADMIN_PASS 自动建好管理员，向导不开放
   *   token  —— 向导开放，但提交时必须带 SETUP_TOKEN
   *   locked —— 未做任何安全配置，初始化接口拒绝服务
   */
  setup_mode?: 'preset' | 'token' | 'locked';
  setup_error?: string;
}

/**
 * 获取系统初始化/运行状态。
 * 该接口**不鉴权**，可在应用启动阶段安全调用。
 */
export async function fetchBootstrap(): Promise<BootstrapInfo> {
  return await apiGet<BootstrapInfo>('/bootstrap');
}

export interface SetupPayload {
  site_host: string;
  admin_mail: string;
  /** SHA256(明文密码) 的十六进制字符串；由前端计算 */
  admin_pass: string;
  site_title: string;
  mail_enabled: boolean;
  mail_keys?: string;
  mail_send?: string;
  /** 初始化令牌：仅当后端处于 token 模式时必填（对应环境变量 SETUP_TOKEN） */
  setup_token?: string;
}

/** 提交初始化表单（只可调用一次） */
export async function submitSetup(payload: SetupPayload) {
  return await apiPost('/setup', payload);
}
