import { apiGet, apiPost } from './request';
import { safeJsonParse } from '@utils/format';
import type {
  ApiResp,
  ApplyPayload,
  Order,
  OrderAction,
  OrderListQuery,
  OrderStats,
  OrderSummary,
} from './types';

/**
 * 申请新证书订单
 * @param captchaToken 当 CERT_CAPTCHA_ENABLED=true 时必填
 * @returns 订单 UUID；ACME 推进在后台执行，失败原因经订单详情展示
 */
export async function applyCert(
  payload: ApplyPayload,
  captchaToken?: string,
): Promise<{ uuid: string }> {
  const body: any = { ...payload };
  if (captchaToken) body.captcha_token = captchaToken;
  const data = await apiPost<ApiResp>('/apply/', body);
  if (data.flags === 0) {
    return { uuid: data.order as string };
  }
  throw new Error(data.texts || '申请失败');
}

/** 查询申请配额与本月已申请数 */
export async function fetchApplyQuota(): Promise<{
  flags: number;
  texts?: string;
  monthly_limit: number;
  month_used: number;
  quota: number;
  active_certs: number;
}> {
  return await apiGet('/apply/quota');
}

/**
 * 获取订单列表（服务端过滤 + 分页）
 * 返回摘要字段，不含 cert / keys 原文；需要原文时用 getOrder 或下载接口。
 */
export async function listOrders(
  params?: OrderListQuery,
): Promise<{ items: OrderSummary[]; total: number; page: number; page_size: number }> {
  const data = await apiGet<ApiResp>('/order/', { id: 'all', ...(params || {}) });
  if (data.flags !== 0) throw new Error(data.texts || '获取订单列表失败');
  const d = data as any;
  return {
    items: (d.order || []) as OrderSummary[],
    total: Number(d.total ?? 0),
    page: Number(d.page ?? 1),
    page_size: Number(d.page_size ?? 20),
  };
}

/** 获取订单状态统计（覆盖全部订单，而非当前页） */
export async function fetchOrderStats(): Promise<OrderStats> {
  const data = await apiGet<ApiResp>('/order/stats');
  if (data.flags !== 0) throw new Error(data.texts || '获取订单统计失败');
  const d = data as any;
  return {
    total: Number(d.stats?.total ?? 0),
    pending: Number(d.stats?.pending ?? 0),
    verifying: Number(d.stats?.verifying ?? 0),
    signed: Number(d.stats?.signed ?? 0),
    expired: Number(d.stats?.expired ?? 0),
    failed: Number(d.stats?.failed ?? 0),
  };
}

/**
 * 获取单个订单
 * @param silent 后台轮询时为 true：失败不弹全局 toast
 */
export async function getOrder(uuid: string, silent = false): Promise<Order> {
  const data = await apiGet<ApiResp>('/order/', { id: uuid }, { silent });
  if (data.flags !== 0) throw new Error(data.texts || '获取订单失败');
  const raw = data.order as OrderSummary & { cert?: string; keys?: string; data?: string };
  return {
    ...raw,
    main: safeJsonParse(raw.main) || {},
    list: safeJsonParse(raw.list) || [],
    data: safeJsonParse(raw.data),
  };
}

/**
 * 证书吊销原因（RFC 5280 / RFC 8555 §7.6）
 * 参考：https://datatracker.ietf.org/doc/html/rfc5280#section-5.3.1
 */
export enum RevokeReason {
  Unspecified = 0, // 未指定
  KeyCompromise = 1, // 密钥泄露
  CACompromise = 2, // CA 泄露
  AffiliationChanged = 3, // 从属关系变更
  Superseded = 4, // 已被新证书取代
  CessationOfOperation = 5, // 停止运营
  CertificateHold = 6, // 证书被暂停
  PrivilegeWithdrawn = 9, // 权限被撤销
}

/** 吊销原因选项（用于 UI 下拉框） */
export const REVOKE_REASON_OPTIONS: Array<{
  value: RevokeReason;
  label: string;
  desc: string;
}> = [
  { value: RevokeReason.Unspecified, label: '未指定 (0)', desc: '没有特定原因（默认选项）' },
  { value: RevokeReason.KeyCompromise, label: '密钥泄露 (1)', desc: '证书的私钥已被泄露或疑似泄露' },
  { value: RevokeReason.AffiliationChanged, label: '从属关系变更 (3)', desc: '证书主体的从属关系已变更' },
  { value: RevokeReason.Superseded, label: '已被取代 (4)', desc: '证书已被新签发的证书取代' },
  { value: RevokeReason.CessationOfOperation, label: '停止运营 (5)', desc: '不再使用该证书保护的服务' },
  { value: RevokeReason.PrivilegeWithdrawn, label: '权限撤销 (9)', desc: '证书持有者的相关权限已被撤销' },
];

/**
 * 执行订单操作
 * - ca_get/ca_key 会通过 data.order 返回证书/密钥原文
 * - ca_del 吊销时可传 revoke_reason（RFC 5280 原因码）
 * - 其他仅返回操作结果
 */
export async function operateOrder(
  uuid: string,
  action: OrderAction,
  domainName?: string,
  opts?: { revokeReason?: RevokeReason },
): Promise<string> {
  const params: Record<string, any> = { id: uuid, op: action };
  if (domainName) params.cd = domainName;
  if (action === 'ca_del' && opts?.revokeReason !== undefined) {
    params.reason = opts.revokeReason;
  }
  const data = await apiGet<ApiResp>('/order/', params);
  if (data.flags !== 0) throw new Error(data.texts || '操作失败');
  return (data.order as string) || '';
}
