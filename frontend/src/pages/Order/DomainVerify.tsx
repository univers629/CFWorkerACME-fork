import { useState } from 'react';
import { Button } from 'antd';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, Globe, PlayCircle } from 'lucide-react';
import SectionHeader from '@components/Layout/SectionHeader';
import StatusPulse from '@components/molecules/StatusPulse';
import Pill from '@components/atoms/Pill';
import CodeInline from '@components/atoms/CodeInline';
import CopyButton from '@components/molecules/CopyButton';
import type { Order, DomainItem } from '@api/types';
import { AUTH_MAP, FLAG_PULSE, FLAG_MAP } from '@utils/constants';
import styles from './Order.module.css';

export interface DomainVerifyProps {
  order: Order;
  onVerifySingle: (name: string) => void;
}

export default function DomainVerify({
  order,
  onVerifySingle,
}: DomainVerifyProps) {
  const list = order.list || [];
  const pendingCount = list.filter((d) => d.flag !== undefined && d.flag < 3).length;

  return (
    <div className={styles.verifyCard}>
      <SectionHeader
        icon={<Globe size={16} />}
        title={`域名验证 (${list.length} 个)`}
        subtitle={pendingCount > 0 ? `${pendingCount} 个待处理` : '全部已处理'}
      />

      <div className={styles.domainPanels}>
        {list.map((d, i) => (
          <DomainPanel
            key={i}
            domain={d}
            orderFlag={order.flag}
            onVerify={() => onVerifySingle(d.name)}
          />
        ))}
      </div>
    </div>
  );
}

function DomainPanel({
  domain,
  orderFlag,
  onVerify,
}: {
  domain: DomainItem;
  orderFlag: number;
  onVerify: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const flag = domain.flag ?? 0;
  const pulseStatus = FLAG_PULSE[flag] || 'pending';
  /**
   * 可验证的判定：
   *   - 订单仍处于待验证(2)或验证中(3)阶段；
   *   - 该域名自身尚未通过(flag < 4)。
   * 仅按域名自身 flag===2 判定会让已进入验证中的域名失去按钮，
   * 而验证是针对整张订单执行的，因此这里放宽到订单级状态。
   */
  const isVerifiable = (orderFlag === 2 || orderFlag === 3) && flag < 4;
  const isDone = flag >= 4;
  const isWeb = domain.type === 'web-self';

  const recordName = `_acme-challenge.${domain.name.replace(/^\*\./, '')}`;
  const recordType = domain.type === 'dns-auto' ? 'CNAME' : 'TXT';
  const recordValue =
    domain.type === 'dns-auto' ? domain.auto || '-' : domain.auth || '-';

  // http-01 的验证材料：token 为文件名，auth 为文件内容
  const webPath = `http://${domain.name.replace(/^\*\./, '')}/.well-known/acme-challenge/${domain.token || '<token>'}`;
  const webContent = domain.auth || '-';

  return (
    <div className={styles.domainPanel}>
      <button
        type="button"
        className={styles.domainPanelHead}
        onClick={() => setExpanded(!expanded)}
      >
        <div className={styles.domainPanelLeft}>
          <StatusPulse status={pulseStatus} size={8} />
          <CodeInline color={domain.name.startsWith('*') ? 'accent' : 'brand'}>
            {domain.name}
          </CodeInline>
          <Pill variant="neutral" size="xs">
            {AUTH_MAP[domain.type] || domain.type}
          </Pill>
          <Pill
            variant={
              flag === 5
                ? 'ok'
                : flag < 0
                  ? 'err'
                  : flag >= 3
                    ? 'lemon'
                    : 'info'
            }
            size="xs"
          >
            {FLAG_MAP[flag] || '等待中'}
          </Pill>
        </div>
        <motion.div
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <ChevronRight size={16} className={styles.domainPanelArrow} />
        </motion.div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className={styles.domainPanelBody}
          >
            <div className={styles.domainPanelInner}>
              {isWeb ? (
                <>
                  <div className={styles.hint}>
                    请在网站根目录下创建验证文件以完成验证：
                  </div>
                  <div className={styles.dnsTable}>
                    <DnsRow label="文件路径" value={webPath} mono />
                    <DnsRow label="文件内容" value={webContent} mono />
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.hint}>
                    请在您的 DNS 提供商中添加以下记录以完成验证：
                  </div>
                  <div className={styles.dnsTable}>
                    <DnsRow label="记录类型" value={recordType} />
                    <DnsRow label="记录名称" value={recordName} />
                    <DnsRow label="记录值" value={recordValue} mono />
                    <DnsRow
                      label="验证命令"
                      value={`nslookup -q=${recordType} ${recordName}`}
                      mono
                    />
                  </div>
                  {domain.type === 'dns-auto' && (
                    <div className={styles.hint}>
                      注意：该名称上不能同时存在 TXT 记录。同名 TXT 会遮蔽 CNAME，
                      使 CA 读不到验证值并一直停在「验证中」；如有请先删除该 TXT。
                    </div>
                  )}
                </>
              )}

              <div className={styles.domainActions}>
                <Button
                  type="primary"
                  icon={<PlayCircle size={14} />}
                  onClick={onVerify}
                  disabled={!isVerifiable}
                >
                  {isDone
                    ? '已完成'
                    : isVerifiable
                      ? '触发验证'
                      : '耐心等待...'}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DnsRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className={styles.dnsRow}>
      <div className={styles.dnsLabel}>{label}</div>
      <div className={styles.dnsValue}>
        <code className={mono ? styles.dnsValueMono : styles.dnsValueText}>
          {value}
        </code>
        <CopyButton text={value} successMsg={`${label}已复制`} size={13} />
      </div>
    </div>
  );
}
