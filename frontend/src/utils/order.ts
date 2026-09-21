import type { OrderSummary } from '@api/types';

/**
 * 订单业务状态分类（UI 显示级别，对后端 flag 做派生）
 *
 * - pending   待验证（flag 0/1/2 且时间 ≤ 7 天）
 * - verifying 验证中（flag 3/4）
 * - signed    已签发且未过期（flag 5 且剩余天数 > 0）
 * - expired   已过期（flag 5 且到期）
 * - failed    已失效（flag = -1，或 flag 0/1/2 超过 7 天未验证视为失效）
 */
export type OrderStatus =
  | 'pending'
  | 'verifying'
  | 'signed'
  | 'expired'
  | 'failed';

/** 过期宽限：flag 0/1/2 超过该天数未完成验证，视为已失效 */
export const PENDING_EXPIRE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 判断 flag=5 的已签发证书是否已过期
 * 规则：next 字段（下次续期/到期时间）存在且早于当前时间
 */
export function isSignedExpired(o: OrderSummary): boolean {
  if (o.flag !== 5) return false;
  if (!o.next) return false;
  return o.next < Date.now();
}

/**
 * 判断待验证订单（flag 0/1/2）是否因超时被视为已失效
 * 规则：距订单创建时间（time）超过 PENDING_EXPIRE_DAYS 天
 */
export function isPendingTimeout(o: OrderSummary): boolean {
  if (o.flag < 0 || o.flag > 2) return false;
  if (!o.time) return false;
  return Date.now() - o.time > PENDING_EXPIRE_DAYS * DAY_MS;
}

/** 派生当前订单的 UI 业务状态 */
export function classifyFlag(o: OrderSummary): OrderStatus {
  if (o.flag === -1) return 'failed';
  if (o.flag === 5) return isSignedExpired(o) ? 'expired' : 'signed';
  if (o.flag === 3 || o.flag === 4) return 'verifying';
  // 0/1/2
  if (isPendingTimeout(o)) return 'failed';
  return 'pending';
}

/** 剩余天数（到期日-当前），负数代表已过期 */
export function remainDays(next: number | undefined | null): number {
  if (!next) return 0;
  return Math.ceil((next - Date.now()) / DAY_MS);
}

/** 已过期多久（以天计算），保证为正整数 */
export function expiredDays(next: number | undefined | null): number {
  if (!next) return 0;
  const diff = Date.now() - next;
  if (diff <= 0) return 0;
  return Math.floor(diff / DAY_MS);
}
