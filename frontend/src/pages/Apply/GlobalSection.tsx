import { useEffect } from 'react';
import { Segmented, Switch } from 'antd';
import { Cpu, Shield, ZapOff } from 'lucide-react';
import SectionHeader from '@components/Layout/SectionHeader';
import { SIGN_OPTIONS, TYPE_OPTIONS } from '@utils/constants';
import styles from './Apply.module.css';

export interface GlobalSectionProps {
  ca: string;
  autoRenew: boolean;
  encryption: string;
  /** 当前启用的 CA 标识；为空时展示全部（bootstrap 未返回该字段时的兼容行为） */
  caSigns?: string[];
  onChange: (key: string, value: any) => void;
}

export default function GlobalSection({
  ca,
  autoRenew,
  encryption,
  caSigns,
  onChange,
}: GlobalSectionProps) {
  // 仅在 bootstrap 明确返回列表时过滤，避免旧版本响应导致选项全空
  const options = caSigns?.length
    ? SIGN_OPTIONS.filter((o) => caSigns.includes(o.value))
    : SIGN_OPTIONS;

  // 默认厂商可能已被管理员关闭，此时自动切到首个可用项，避免提交时被后端拒绝
  useEffect(() => {
    if (options.length === 0) return;
    if (!options.some((o) => o.value === ca)) {
      onChange('ca', options[0].value);
    }
  }, [ca, options, onChange]);

  return (
    <div className={styles.section}>
      <SectionHeader
        title="全局设置"
        subtitle="选择证书厂商、加密算法和自动续期选项"
      />

      {/* 厂商大卡片 Radio */}
      <div className={styles.field}>
        <label className={styles.fieldLabel}>
          <Shield size={13} /> 证书厂商
        </label>
        <div className={styles.caGrid}>
          {options.map((opt) => (
            <button
              type="button"
              key={opt.value}
              onClick={() => onChange('ca', opt.value)}
              className={[
                styles.caCard,
                ca === opt.value && styles.caCardActive,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className={styles.caCardTitle}>{opt.label}</div>
              <div className={styles.caCardDesc}>{opt.desc}</div>
              {ca === opt.value && (
                <div className={styles.caCardMark}>✓</div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 算法 */}
      <div className={styles.field}>
        <label className={styles.fieldLabel}>
          <Cpu size={13} /> 加密算法
        </label>
        <Segmented
          options={TYPE_OPTIONS.map((t) => ({
            label: (
              <div className={styles.algoOption}>
                <span className={styles.algoName}>{t.label}</span>
                <span className={styles.algoDesc}>{t.desc}</span>
              </div>
            ),
            value: t.value,
          }))}
          value={encryption}
          onChange={(v) => onChange('encryption', v)}
          block
          size="large"
        />
      </div>

      {/* 自动续期 */}
      <div className={styles.field}>
        <div className={styles.renewRow}>
          <div>
            <div className={styles.renewTitle}>
              <ZapOff size={14} /> 自动续期
            </div>
            <div className={styles.renewDesc}>
              到期前 7 天自动续期证书，避免中断服务
            </div>
          </div>
          <Switch
            checked={autoRenew}
            onChange={(c) => onChange('auto_renew', c)}
          />
        </div>
      </div>
    </div>
  );
}
