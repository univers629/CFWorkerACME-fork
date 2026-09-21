import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import type { OrderSummary } from '@api/types';
import { fmtRelative, shortenId, summarizeDomains } from '@utils/format';
import { FLAG_MAP, FLAG_PULSE } from '@utils/constants';
import { safeJsonParse } from '@utils/format';
import StatusPulse from '@components/molecules/StatusPulse';
import Pill from '@components/atoms/Pill';
import CodeInline from '@components/atoms/CodeInline';
import styles from './Panel.module.css';

export interface MessageListProps {
  orders: OrderSummary[];
}

export default function MessageList({ orders }: MessageListProps) {
  return (
    <ul className={styles.timeline}>
      {orders.map((o) => {
        const domainList = safeJsonParse<Array<{ name: string }>>(o.list) || [];
        const domains = summarizeDomains(domainList, 24);
        const pulseStatus = FLAG_PULSE[o.flag] || 'pending';

        return (
          <li key={o.uuid} className={styles.timelineItem}>
            <span className={styles.timelineLine} />
            <span className={styles.timelineDot}>
              <StatusPulse status={pulseStatus} size={8} />
            </span>

            <div className={styles.timelineContent}>
              <div className={styles.timelineMeta}>
                <Pill
                  variant={
                    o.flag === 5
                      ? 'ok'
                      : o.flag === -1
                        ? 'err'
                        : o.flag >= 3
                          ? 'lemon'
                          : 'info'
                  }
                  size="xs"
                >
                  {FLAG_MAP[o.flag] || '未知'}
                </Pill>
                <span className={styles.timelineTime}>
                  {fmtRelative(o.time)}
                </span>
                <CodeInline>
                  {shortenId(o.uuid)}
                </CodeInline>
              </div>

              <div className={styles.timelineBody}>
                <span className={styles.timelineDomains}>{domains}</span>
                {o.text && (
                  <span className={styles.timelineText}>· {o.text}</span>
                )}
              </div>
            </div>

            <Link
              to={`/order/${o.uuid}`}
              className={styles.timelineAction}
              aria-label="查看详情"
              title="查看详情"
            >
              <ExternalLink size={14} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
