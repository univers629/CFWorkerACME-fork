import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { App, Button, Empty, Input, Pagination, Segmented, Skeleton } from 'antd';
import {
  ArrowRight,
  Archive,
  Clock,
  Copy,
  Download,
  FileLock2,
  FileStack,
  Key,
  KeyRound,
  LayoutGrid,
  List,
  Plus,
  Search,
  Shield,
  ShieldOff,
  Trash2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import PageShell from '@components/Layout/PageShell';
import SectionHeader from '@components/Layout/SectionHeader';
import TerminalPrompt from '@components/molecules/TerminalPrompt';
import EmptyState from '@components/molecules/EmptyState';
import StatusPulse from '@components/molecules/StatusPulse';
import ConfirmIdContent from '@components/molecules/ConfirmIdContent';
import RevokeReasonSelect from '@components/molecules/RevokeReasonSelect';
import Pill from '@components/atoms/Pill';
import { useCopy } from '@hooks/useCopy';
import { listOrders, operateOrder, RevokeReason } from '@api/order';
import type { OrderSummary } from '@api/types';
import {
  FLAG_MAP,
  SIGN_SHORT_MAP,
  TYPE_MAP,
} from '@utils/constants';
import {
  downloadAsFile,
  fmtDate,
  fmtRelative,
  safeJsonParse,
} from '@utils/format';
import { classifyFlag, expiredDays, remainDays, type OrderStatus } from '@utils/order';
import { randomKaomoji } from '@utils/kaomoji';
import { handleDownloadZip, handleDownloadPfx } from '@utils/certDownload';
import styles from './Certs.module.css';

type View = 'card' | 'list';
type FilterType = 'all' | 'active' | 'pending' | 'expired' | 'failed';

const FILTER_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: '已签发', value: 'active' },
  { label: '处理中', value: 'pending' },
  { label: '已过期', value: 'expired' },
  { label: '已失效', value: 'failed' },
];

/** 由 OrderStatus 映射到色彩 token（背景条/Pill） */
const STATUS_COLOR: Record<OrderStatus, string> = {
  pending: 'info',
  verifying: 'info',
  signed: 'ok',
  expired: 'warn',
  failed: 'err',
};

/** OrderStatus → StatusPulse 状态 */
const STATUS_PULSE: Record<
  OrderStatus,
  'pending' | 'verifying' | 'success' | 'failed' | 'expired'
> = {
  pending: 'pending',
  verifying: 'verifying',
  signed: 'success',
  expired: 'expired',
  failed: 'failed',
};

/** OrderStatus → 中文标签 */
const STATUS_TEXT: Record<OrderStatus, string> = {
  pending: '待验证',
  verifying: '验证中',
  signed: '已签发',
  expired: '已过期',
  failed: '已失效',
};

export default function Certs() {
  const { message, modal } = App.useApp();
  const { copy } = useCopy();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [view, setView] = useState<View>('card');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);

  const load = async (opts?: {
    page?: number;
    pageSize?: number;
    filter?: FilterType;
    query?: string;
  }) => {
    const p = opts?.page ?? page;
    const size = opts?.pageSize ?? pageSize;
    const f = opts?.filter ?? filter;
    const q = (opts?.query ?? query).trim();
    setLoading(true);
    try {
      const res = await listOrders({
        page: p,
        page_size: size,
        // 后端状态名与 UI 标签的映射：active → signed
        status: f === 'all' ? undefined : f === 'active' ? 'signed' : f,
        q: q || undefined,
      });
      setOrders(res.items || []);
      setTotal(res.total);
    } catch {
      setOrders([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 变更筛选或搜索后回到第一页重新查询 */
  const applyFilter = (next: { filter?: FilterType; query?: string }) => {
    const f = next.filter ?? filter;
    const q = next.query ?? query;
    if (next.filter !== undefined) setFilter(f);
    if (next.query !== undefined) setQuery(q);
    setPage(1);
    load({ page: 1, filter: f, query: q });
  };

  const handleDownload = async (uuid: string, type: 'cert' | 'key') => {
    try {
      const content = await operateOrder(
        uuid,
        type === 'cert' ? 'ca_get' : 'ca_key',
      );
      if (!content) {
        message.warning('证书或密钥不存在');
        return;
      }
      downloadAsFile(
        content,
        `${uuid}.${type === 'cert' ? 'crt' : 'pem'}`,
      );
      message.success('下载成功 ✨');
    } catch {
      /* 拦截器已 toast */
    }
  };

  /**
   * 通用“危险操作”弹窗：
   * - requireConfirmId: 强制用户输入完整订单号后才可确认
   * - pickRevokeReason: 吊销证书时额外展示“吊销原因”选择器
   */
  const openDangerConfirm = (opts: {
    title: string;
    tip?: string;
    uuid: string;
    okText: string;
    pickRevokeReason?: boolean;
    run: (reason?: RevokeReason) => Promise<void>;
  }) => {
    let matched = false;
    let reason: RevokeReason = RevokeReason.Unspecified;
    const instance = modal.confirm({
      title: opts.title,
      icon: null,
      okText: opts.okText,
      cancelText: '取消',
      width: 520,
      okButtonProps: { danger: true, disabled: true },
      content: (
        <div>
          <ConfirmIdContent
            expectId={opts.uuid}
            hint={opts.tip}
            onMatchChange={(m) => {
              matched = m;
              instance.update({
                okButtonProps: { danger: true, disabled: !m },
              });
            }}
          />
          {opts.pickRevokeReason && (
            <RevokeReasonSelect
              onChange={(r) => {
                reason = r;
                instance.update({
                  okButtonProps: { danger: true, disabled: !matched },
                });
              }}
            />
          )}
        </div>
      ),
      onOk: async () => {
        try {
          await opts.run(opts.pickRevokeReason ? reason : undefined);
        } catch {
          /* 拦截器已 toast */
        }
      },
    });
  };

  const handleDelete = (uuid: string) => {
    openDangerConfirm({
      title: '确认删除订单？',
      tip: '该订单的所有信息（证书、私钥、验证记录）将被永久删除，此操作不可恢复。请输入完整订单 ID 以确认。',
      uuid,
      okText: '确认删除',
      run: async () => {
        await operateOrder(uuid, 'cancel');
        message.success(`订单已删除 ${randomKaomoji('success')}`);
        load();
      },
    });
  };

  const handleRemoveKey = (uuid: string) => {
    openDangerConfirm({
      title: '确认清空私钥？',
      tip: '私钥清空后将无法再下载，也无法使用私钥续期/吊销证书；证书本身仍可保留。此操作不可恢复，请先确保已保存本地副本，并输入完整订单 ID 以确认。',
      uuid,
      okText: '确认清空',
      run: async () => {
        await operateOrder(uuid, 'rm_key');
        message.success(`私钥已清空 ${randomKaomoji('success')}`);
        load();
      },
    });
  };

  const handleRevoke = (uuid: string) => {
    openDangerConfirm({
      title: '确认吊销证书？',
      tip: '吊销后该证书会被 CA 标记为无效，使用该证书的服务都将无法正常工作。此操作不可恢复，请输入完整订单 ID 并选择吊销原因。',
      uuid,
      okText: '确认吊销',
      pickRevokeReason: true,
      run: async (reason) => {
        await operateOrder(uuid, 'ca_del', undefined,
          reason !== undefined ? { revokeReason: reason } : undefined);
        message.success(`证书已吊销 ${randomKaomoji('success')}`);
        load();
      },
    });
  };

  return (
    <PageShell>
      {/* 终端提示 */}
      <div className={styles.greet}>
        <TerminalPrompt
          host="certhub"
          path="~/certs"
          suffix={<span className={styles.cmdText}>ls -la</span>}
        />
      </div>

      {/* 标题 + 操作 */}
      <SectionHeader
        icon={<FileStack size={18} />}
        title="证书列表"
        subtitle={`共 ${total} 个订单`}
        extra={
          <Link to="/apply">
            <Button type="primary" icon={<Plus size={16} />}>
              申请新证书
            </Button>
          </Link>
        }
      />

      {/* 工具栏 */}
      <div className={styles.toolbar}>
        <Input
          placeholder="搜索域名或订单号..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onPressEnter={() => applyFilter({ query })}
          prefix={<Search size={14} className={styles.searchIcon} />}
          className={styles.search}
          allowClear
        />

        <Segmented
          value={filter}
          onChange={(v) => applyFilter({ filter: v as FilterType })}
          options={FILTER_OPTIONS}
          className={styles.filter}
        />

        <Segmented
          value={view}
          onChange={(v) => setView(v as View)}
          options={[
            { value: 'card', icon: <LayoutGrid size={14} /> },
            { value: 'list', icon: <List size={14} /> },
          ]}
        />
      </div>

      {/* 内容区 */}
      {loading ? (
        <div className={styles.cardGrid}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton.Button
              key={i}
              active
              block
              style={{ height: 180, borderRadius: 18 }}
            />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className={styles.emptyWrap}>
          <EmptyState
            mood="empty"
            title={total === 0 ? '还没有证书呢...' : '没有匹配的结果'}
            description={
              total === 0
                ? '申请第一张证书，开启 HTTPS 之旅'
                : '试试调整搜索条件或筛选项'
            }
            size="lg"
            action={
              total === 0 ? (
                <Link to="/apply">
                  <Button type="primary" size="large" icon={<Plus size={16} />}>
                    申请证书
                  </Button>
                </Link>
              ) : undefined
            }
          />
        </div>
      ) : (
        <AnimatePresence mode="wait">
          {view === 'card' ? (
            <motion.div
              key="card"
              className={styles.cardGrid}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {orders.map((o, i) => (
                <OrderCard
                  key={o.uuid}
                  order={o}
                  index={i}
                  onCopyId={() => copy(o.uuid, '订单 ID 已复制')}
                  onDownloadCert={() => handleDownload(o.uuid, 'cert')}
                  onDownloadKey={() => handleDownload(o.uuid, 'key')}
                  onDownloadZip={() => handleDownloadZip(o.uuid, message)}
                  onDownloadPfx={() => handleDownloadPfx(o.uuid, message)}
                  onDelete={() => handleDelete(o.uuid)}
                  onRemoveKey={() => handleRemoveKey(o.uuid)}
                  onRevoke={() => handleRevoke(o.uuid)}
                />
              ))}
            </motion.div>
          ) : (
            <motion.div
              key="list"
              className={styles.listWrap}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {orders.map((o, i) => (
                <OrderRow
                  key={o.uuid}
                  order={o}
                  index={i}
                  onCopyId={() => copy(o.uuid, '订单 ID 已复制')}
                  onDownloadCert={() => handleDownload(o.uuid, 'cert')}
                  onDownloadZip={() => handleDownloadZip(o.uuid, message)}
                  onDownloadPfx={() => handleDownloadPfx(o.uuid, message)}
                  onDelete={() => handleDelete(o.uuid)}
                  onRemoveKey={() => handleRemoveKey(o.uuid)}
                  onRevoke={() => handleRevoke(o.uuid)}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {/* 分页：服务端分页，仅在超过一页时显示 */}
      {!loading && total > pageSize && (
        <div className={styles.pager}>
          <Pagination
            current={page}
            pageSize={pageSize}
            total={total}
            showSizeChanger
            pageSizeOptions={[10, 20, 50]}
            size="small"
            onChange={(p, size) => {
              setPage(p);
              setPageSize(size);
              load({ page: p, pageSize: size });
            }}
          />
        </div>
      )}
    </PageShell>
  );
}

/* ============================================================
 * 卡片组件
 * ============================================================ */

interface OrderCardProps {
  order: OrderSummary;
  index: number;
  onCopyId: () => void;
  onDownloadCert: () => void;
  onDownloadKey: () => void;
  onDownloadZip: () => void;
  onDownloadPfx: () => void;
  onDelete: () => void;
  onRemoveKey: () => void;
  onRevoke: () => void;
}

/** 证书状态尾巴文案：已签发显示剩余天数；已过期显示过期时长 */
function renderExpiryBadge(order: OrderSummary, status: OrderStatus) {
  if (status === 'signed') {
    const days = remainDays(order.next);
    const isExpiring = days <= 14;
    return (
      <Pill
        variant={isExpiring ? 'warn' : 'neutral'}
        size="xs"
        className={isExpiring ? 'anim-wiggle' : ''}
      >
        剩 {days > 0 ? days : 0} 天
      </Pill>
    );
  }
  if (status === 'expired') {
    const days = expiredDays(order.next);
    let text = '已过期';
    if (days >= 30) text = `已过期 ${Math.floor(days / 30)} 个月`;
    else if (days > 0) text = `已过期 ${days} 天`;
    return (
      <Pill variant="warn" size="xs">
        {text}
      </Pill>
    );
  }
  return null;
}

function OrderCard({
  order,
  index,
  onCopyId,
  onDownloadCert,
  onDownloadKey,
  onDownloadZip,
  onDownloadPfx,
  onDelete,
  onRemoveKey,
  onRevoke,
}: OrderCardProps) {
  const list = safeJsonParse<Array<{ name: string; wild?: boolean }>>(order.list) || [];
  const status = classifyFlag(order);
  const pulseStatus = STATUS_PULSE[status];
  const colorVariant = STATUS_COLOR[status] as any;
  const isSigned = status === 'signed';
  const isExpired = status === 'expired';
  const hasKey = !!order.has_keys;
  const canRevoke = (isSigned || isExpired) && hasKey;

  return (
    <motion.div
      className={`${styles.card} ${styles[`card-${colorVariant}`]}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.3 }}
      whileHover={{ y: -4 }}
    >
      <div className={styles.cardBar} />

      <div className={styles.cardHead}>
        <div className={styles.cardStatus}>
          <StatusPulse status={pulseStatus} size={8} />
          <Pill variant={colorVariant} size="xs" solid={isSigned}>
            {STATUS_TEXT[status] || FLAG_MAP[order.flag] || '未知'}
          </Pill>
        </div>
        <div className={styles.uuidRow}>
          <span className={styles.uuidFull} title={order.uuid}>{order.uuid}</span>
          <button
            type="button"
            className={styles.uuidCopyBtn}
            onClick={onCopyId}
            title="复制订单 ID"
          >
            <Copy size={12} />
          </button>
        </div>
      </div>

      <div className={styles.cardDomains}>
        {list.slice(0, 3).map((d, i) => (
          <div key={i} className={styles.domainLine}>
            <span className={styles.domainDot}>
              {d.wild ? '✦' : '•'}
            </span>
            <span className={styles.domainName}>{d.name}</span>
          </div>
        ))}
        {list.length > 3 && (
          <div className={styles.domainMore}>
            +{list.length - 3} 更多...
          </div>
        )}
      </div>

      <div className={styles.cardMeta}>
        <span className={styles.metaItem}>
          <Shield size={12} /> {SIGN_SHORT_MAP[order.sign] || order.sign}
        </span>
        <span className={styles.metaDot}>·</span>
        <span className={styles.metaItem}>
          <Key size={12} /> {TYPE_MAP[order.type] || order.type}
        </span>
      </div>

      <div className={styles.cardFoot}>
        <div className={styles.cardTime}>
          <Clock size={12} />
          <span>{fmtRelative(order.time)}</span>
          {renderExpiryBadge(order, status)}
        </div>
        <div className={styles.cardActions}>
          {(isSigned || isExpired) && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onDownloadCert}
              title="下载证书"
            >
              <Download size={14} />
            </button>
          )}
          {isSigned && hasKey && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onDownloadZip}
              title="下载 ZIP（证书 + 密钥 + 说明）"
            >
              <Archive size={14} />
            </button>
          )}
          {isSigned && hasKey && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onDownloadPfx}
              title="下载 PFX（随机 12 位密码）"
            >
              <FileLock2 size={14} />
            </button>
          )}
          {(isSigned || isExpired) && hasKey && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onDownloadKey}
              title="下载私钥"
            >
              <KeyRound size={14} />
            </button>
          )}
          {canRevoke && (
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.iconBtnWarn}`}
              onClick={onRevoke}
              title="吊销证书"
            >
              <ShieldOff size={14} />
            </button>
          )}
          {(isSigned || isExpired) && hasKey && (
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.iconBtnWarn}`}
              onClick={onRemoveKey}
              title="清空私钥"
            >
              <Key size={14} />
            </button>
          )}
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
            onClick={onDelete}
            title="删除订单"
          >
            <Trash2 size={14} />
          </button>
          <Link to={`/order/${order.uuid}`} className={styles.viewBtn}>
            查看 <ArrowRight size={12} />
          </Link>
        </div>
      </div>
    </motion.div>
  );
}

/* ============================================================
 * 列表行组件
 * ============================================================ */

function OrderRow({
  order,
  index,
  onCopyId,
  onDownloadCert,
  onDownloadZip,
  onDownloadPfx,
  onDelete,
  onRemoveKey,
  onRevoke,
}: {
  order: OrderSummary;
  index: number;
  onCopyId: () => void;
  onDownloadCert: () => void;
  onDownloadZip: () => void;
  onDownloadPfx: () => void;
  onDelete: () => void;
  onRemoveKey: () => void;
  onRevoke: () => void;
}) {
  const list = safeJsonParse<Array<{ name: string }>>(order.list) || [];
  const status = classifyFlag(order);
  const pulseStatus = STATUS_PULSE[status];
  const colorVariant = STATUS_COLOR[status] as any;
  const isSigned = status === 'signed';
  const isExpired = status === 'expired';
  const hasKey = !!order.has_keys;
  const canRevoke = (isSigned || isExpired) && hasKey;

  return (
    <motion.div
      className={styles.listRow}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.03, duration: 0.3 }}
    >
      <div className={styles.listStatus}>
        <StatusPulse status={pulseStatus} size={8} />
      </div>
      <div className={styles.listStatusPill}>
        <Pill variant={colorVariant} size="xs" solid={isSigned}>
          {STATUS_TEXT[status] || FLAG_MAP[order.flag]}
        </Pill>
      </div>
      <div className={styles.uuidRow}>
        <span className={styles.uuidFull} title={order.uuid}>{order.uuid}</span>
        <button
          type="button"
          className={styles.uuidCopyBtn}
          onClick={onCopyId}
          title="复制订单 ID"
        >
          <Copy size={12} />
        </button>
      </div>
      <div className={styles.listDomain}>
        {list.map((d) => d.name).join(', ')}
      </div>
      <div className={styles.listMeta}>
        <span>{SIGN_SHORT_MAP[order.sign]}</span>
        <span className={styles.metaDot}>·</span>
        <span>{TYPE_MAP[order.type]}</span>
        {renderExpiryBadge(order, status)}
      </div>
      <div className={styles.listTime}>{fmtDate(order.time)}</div>
      <div className={styles.listActions}>
        {(isSigned || isExpired) && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onDownloadCert}
            title="下载证书"
          >
            <Download size={14} />
          </button>
        )}
        {isSigned && hasKey && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onDownloadZip}
            title="下载 ZIP"
          >
            <Archive size={14} />
          </button>
        )}
        {isSigned && hasKey && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onDownloadPfx}
            title="下载 PFX"
          >
            <FileLock2 size={14} />
          </button>
        )}
        {canRevoke && (
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.iconBtnWarn}`}
            onClick={onRevoke}
            title="吊销证书"
          >
            <ShieldOff size={14} />
          </button>
        )}
        {(isSigned || isExpired) && hasKey && (
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.iconBtnWarn}`}
            onClick={onRemoveKey}
            title="清空私钥"
          >
            <Key size={14} />
          </button>
        )}
        <button
          type="button"
          className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
          onClick={onDelete}
          title="删除订单"
        >
          <Trash2 size={14} />
        </button>
        <Link to={`/order/${order.uuid}`} className={styles.viewBtn}>
          <ArrowRight size={14} />
        </Link>
      </div>
    </motion.div>
  );
}
