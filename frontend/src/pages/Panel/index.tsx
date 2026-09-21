import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Skeleton, Empty } from 'antd';
import {
  Activity,
  Bell,
  FileStack,
  PlusCircle,
  UserCog,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import PageShell from '@components/Layout/PageShell';
import SectionHeader from '@components/Layout/SectionHeader';
import TerminalPrompt from '@components/molecules/TerminalPrompt';
import StatCard from '@components/molecules/StatCard';
import Pill from '@components/atoms/Pill';
import StatusPulse from '@components/molecules/StatusPulse';
import Kaomoji from '@components/molecules/Kaomoji';
import { useAuthStore } from '@stores/useAuthStore';
import { fetchOrderStats, listOrders } from '@api/order';
import type { OrderStats, OrderSummary } from '@api/types';
import { classifyFlag } from '@utils/order';
import MessageList from './MessageList';
import styles from './Panel.module.css';

const EMPTY_STATS: OrderStats = {
  total: 0,
  pending: 0,
  verifying: 0,
  signed: 0,
  expired: 0,
  failed: 0,
};

/**
 * 生成简单的 sparkline（最近 7 天每天的订单数）。
 * 基于当前页订单，仅作趋势示意。
 */
function makeTrend(orders: OrderSummary[], filter: (o: OrderSummary) => boolean): number[] {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const buckets = new Array(7).fill(0);
  for (const o of orders) {
    if (!filter(o)) continue;
    const diff = Math.floor((now - (o.time || 0)) / dayMs);
    if (diff >= 0 && diff < 7) buckets[6 - diff] += 1;
  }
  return buckets;
}

export default function Panel() {
  const email = useAuthStore((s) => s.email);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<OrderStats>(EMPTY_STATS);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [trend, setTrend] = useState<Record<string, number[]>>({});

  const load = async () => {
    setLoading(true);
    try {
      // 统计需要覆盖全部订单，列表只取最近 8 条用于消息区
      const [s, list] = await Promise.all([
        fetchOrderStats(),
        listOrders({ page: 1, page_size: 8 }),
      ]);
      setStats(s);
      const items = list.items || [];
      setOrders(items);
      setTrend({
        pending: makeTrend(items, (o) => classifyFlag(o) === 'pending'),
        verifying: makeTrend(items, (o) => classifyFlag(o) === 'verifying'),
        signed: makeTrend(items, (o) => classifyFlag(o) === 'signed'),
        expired: makeTrend(items, (o) => classifyFlag(o) === 'expired'),
        failed: makeTrend(items, (o) => classifyFlag(o) === 'failed'),
      });
    } catch {
      setStats(EMPTY_STATS);
      setOrders([]);
      setTrend({});
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const recentOrders = useMemo(() => {
    return [...orders].sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 8);
  }, [orders]);

  return (
    <PageShell>
      {/* 顶部问候 */}
      <motion.div
        className={styles.greet}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <TerminalPrompt
          user={email?.split('@')[0] || 'guest'}
          host="certhub"
          path="~/panel"
          suffix={
            <span className={styles.greetSuffix}>
              welcome back <Kaomoji mood="welcome" inline size={14} />
            </span>
          }
        />
      </motion.div>

      {/* 主网格 */}
      <div className={styles.mainGrid}>
        {/* 左：证书总览（占 2/3） */}
        <section className={styles.overview}>
          <SectionHeader
            icon={<Activity size={18} />}
            title="证书总览"
            subtitle={`共 ${stats.total} 个订单`}
            extra={
              <Pill
                variant="neutral"
                size="xs"
                icon={<StatusPulse status="success" size={6} />}
              >
                实时刷新
              </Pill>
            }
          />

          {loading ? (
            <div className={styles.statGrid}>
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton.Button
                  key={i}
                  active
                  block
                  style={{ height: 110 }}
                />
              ))}
            </div>
          ) : (
            <div className={styles.statGrid}>
              <StatCard
                title="待验证"
                value={stats.pending}
                icon={<FileStack size={16} />}
                status="pending"
                accent="lavender"
                trend={trend.pending}
              />
              <StatCard
                title="验证中"
                value={stats.verifying}
                icon={<Activity size={16} />}
                status="verifying"
                accent="lemon"
                trend={trend.verifying}
              />
              <StatCard
                title="已签发"
                value={stats.signed}
                icon={<FileStack size={16} />}
                status="success"
                accent="brand"
                trend={trend.signed}
              />
              <StatCard
                title="已过期"
                value={stats.expired}
                icon={<FileStack size={16} />}
                status="expired"
                accent="accent"
                trend={trend.expired}
              />
              <StatCard
                title="已失效"
                value={stats.failed}
                icon={<FileStack size={16} />}
                status="failed"
                accent="accent"
                trend={trend.failed}
              />
            </div>
          )}
        </section>

        {/* 右：快速操作（1/3） */}
        <aside className={styles.quickActions}>
          <SectionHeader
            icon={<PlusCircle size={18} />}
            title="快速操作"
            compact
          />
          <Link to="/apply" className={`${styles.quickBtn} ${styles.quickBtnPrimary}`}>
            <PlusCircle size={18} />
            <div className={styles.quickBtnText}>
              <div className={styles.quickBtnTitle}>申请新证书</div>
              <div className={styles.quickBtnDesc}>创建一个新的证书订单</div>
            </div>
          </Link>
          <Link to="/certs" className={styles.quickBtn}>
            <FileStack size={18} />
            <div className={styles.quickBtnText}>
              <div className={styles.quickBtnTitle}>查看所有订单</div>
              <div className={styles.quickBtnDesc}>浏览全部证书列表</div>
            </div>
          </Link>
          <Link to="/account" className={styles.quickBtn}>
            <UserCog size={18} />
            <div className={styles.quickBtnText}>
              <div className={styles.quickBtnTitle}>账号设置</div>
              <div className={styles.quickBtnDesc}>ACME 私钥、API Token、密码管理</div>
            </div>
          </Link>
        </aside>
      </div>

      {/* 消息通知 */}
      <section className={styles.messages}>
        <SectionHeader
          icon={<Bell size={18} />}
          title="消息通知"
          subtitle="最近 8 条订单动态"
        />
        {loading ? (
          <Skeleton active />
        ) : recentOrders.length > 0 ? (
          <MessageList orders={recentOrders} />
        ) : (
          <div className={styles.empty}>
            <Kaomoji mood="empty" size={36} />
            <Empty
              description="还没有任何订单"
              imageStyle={{ display: 'none' }}
            />
          </div>
        )}
      </section>
    </PageShell>
  );
}
