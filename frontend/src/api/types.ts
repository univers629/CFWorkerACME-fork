/* ============================================================
 * API 类型定义
 * ============================================================ */

/** 通用响应 */
export interface ApiResp<T = any> {
  flags: number; // 0 表示成功
  texts?: string; // 提示文案
  // 其他额外字段（由各接口补充）
  [key: string]: any;
  _data?: T;
}

/** 域名条目（申请时） */
export interface DomainItem {
  name: string;
  wild: boolean;
  root: boolean;
  type: 'dns-self' | 'dns-auto' | 'web-self';
  isIP?: boolean;
  // 后端返回额外字段
  flag?: number;
  text?: string;
  auth?: string;
  auto?: string;
  /** web-self（http-01）的挑战令牌，用于拼接验证文件路径与内容 */
  token?: string;
}

/** 证书主体 */
export interface CertSubject {
  C?: string;
  S?: string;
  ST?: string;
  O?: string;
  OU?: string;
}

/** 申请表单 */
export interface ApplyPayload {
  domains: DomainItem[];
  globals: {
    ca: string;
    auto_renew: boolean;
    encryption: string;
  };
  subject: CertSubject;
}

/**
 * 订单摘要（列表接口返回结构）
 * 不含 cert / keys / data 原文，仅给出是否存在的标记。
 */
export interface OrderSummary {
  uuid: string;
  mail: string;
  sign: string;
  type: string;
  auto: boolean | number;
  flag: number;
  time: number;
  next: number;
  main: string; // JSON 字符串
  list: string; // JSON 字符串（DomainItem[]）
  text: string;
  has_cert: boolean | number;
  has_keys: boolean | number;
}

/** 订单列表查询参数 */
export interface OrderListQuery {
  page?: number;
  page_size?: number;
  /** 派生状态过滤：all / signed / expired / pending / failed */
  status?: string;
  /** 域名关键字 */
  q?: string;
}

/** 订单状态统计（首页概览用，覆盖全部订单而非当前页） */
export interface OrderStats {
  total: number;
  pending: number;
  verifying: number;
  signed: number;
  expired: number;
  failed: number;
}

/** 订单详情（解析后）；cert / keys 仅详情接口返回 */
export interface Order extends Omit<OrderSummary, 'main' | 'list'> {
  main: CertSubject;
  list: DomainItem[];
  cert?: string;
  keys?: string;
  data?: any;
}

/** 订单操作 */
export type OrderAction =
  | 'verify'
  | 'reload'
  | 'modify'
  | 'cancel'
  | 'single'
  | 'process'
  | 'ca_get'
  | 'ca_key'
  | 're_new'
  | 'rm_key'
  | 'ca_del';

/** Nonce 响应 */
export interface NonceResp {
  nonce: string;
  flags?: number;
  texts?: string;
}

/** 用户数据 */
export interface UserInfo {
  mail: string;
  keys?: string;
  apis?: string;
}
