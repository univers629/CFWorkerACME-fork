import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, Form, Spin, Tag } from 'antd';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Globe,
  Send,
  Settings2,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import PageShell from '@components/Layout/PageShell';
import TerminalPrompt from '@components/molecules/TerminalPrompt';
import Kaomoji from '@components/molecules/Kaomoji';
import Pill from '@components/atoms/Pill';
import CodeInline from '@components/atoms/CodeInline';
import CertCaptcha from '@components/molecules/CertCaptcha';
import { applyCert, fetchApplyQuota } from '@api/order';
import type { ApplyPayload, DomainItem } from '@api/types';
import { useBootstrapStore } from '@stores/useBootstrapStore';
import {
  SIGN_MAP,
  SIGN_SHORT_MAP,
  TYPE_MAP,
} from '@utils/constants';
import DomainSection from './DomainSection';
import GlobalSection from './GlobalSection';
import SubjectSection from './SubjectSection';
import styles from './Apply.module.css';

interface DomainRowForm {
  id: string;
  domain: string;
  wildcard: boolean;
  includeRoot: boolean;
  verification: 'dns-self' | 'dns-auto' | 'web-self';
  isIP: boolean;
}

interface FormState {
  domains: DomainRowForm[];
  ca: string;
  auto_renew: boolean;
  encryption: string;
  subject: {
    country?: string;
    province?: string;
    city?: string;
    organization?: string;
    unit?: string;
  };
}

const DEFAULT_DOMAIN = (): DomainRowForm => ({
  id: Math.random().toString(36).slice(2),
  domain: '',
  wildcard: false,
  includeRoot: true,
  verification: 'dns-self',
  isIP: false,
});

const STEPS = [
  { key: 'domain', title: '域名配置', icon: <Globe size={16} /> },
  { key: 'global', title: '全局设置', icon: <Settings2 size={16} /> },
  { key: 'subject', title: '主体信息', icon: <UserCheck size={16} /> },
];

export default function Apply() {
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const bootstrap = useBootstrapStore((s) => s.info);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // 人机验证 token（仅在后端开启时必填）
  const captchaEnabled = !!bootstrap?.cert_captcha?.enabled;
  const [captchaToken, setCaptchaToken] = useState('');

  // 配额 / 月度上限
  const [quotaInfo, setQuotaInfo] = useState<{
    monthly_limit: number;
    month_used: number;
    quota: number;
    active_certs: number;
  } | null>(null);

  useEffect(() => {
    fetchApplyQuota()
      .then((r) => {
        if (r.flags === 0) {
          setQuotaInfo({
            monthly_limit: r.monthly_limit,
            month_used: r.month_used,
            quota: r.quota,
            active_certs: r.active_certs,
          });
        }
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  const [state, setState] = useState<FormState>({
    domains: [DEFAULT_DOMAIN()],
    ca: 'google-trust',
    auto_renew: true,
    encryption: 'eccp256',
    subject: {},
  });

  const updateDomains = (domains: DomainRowForm[]) =>
    setState((s) => ({ ...s, domains }));

  const updateGlobal = (k: string, v: any) =>
    setState((s) => ({ ...s, [k]: v } as FormState));

  const updateSubject = (k: string, v: string) =>
    setState((s) => ({
      ...s,
      subject: { ...s.subject, [k]: v },
    }));

  // 计算预览域名列表
  const previewDomains = useMemo(() => {
    const result: string[] = [];
    for (const d of state.domains) {
      if (!d.domain) continue;
      if (!d.wildcard || d.includeRoot) result.push(d.domain);
      if (d.wildcard) result.push(`*.${d.domain}`);
    }
    return result;
  }, [state.domains]);

  const validDomains = previewDomains.length > 0;

  const validateStep = (idx: number): boolean => {
    if (idx === 0) {
      if (!validDomains) {
        message.warning('请至少填写一个有效域名');
        return false;
      }
      // 简单格式校验：不允许包含空格/中文/非法字符，避免 ACME 服务端拒绝
      const DOMAIN_RE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
      const IP_RE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
      for (const d of state.domains) {
        const v = (d.domain || '').trim();
        if (!v) {
          message.error('存在空的域名输入');
          return false;
        }
        if (d.isIP) {
          if (!IP_RE.test(v)) {
            message.error(`IP 地址格式非法："${v}"`);
            return false;
          }
        } else if (!DOMAIN_RE.test(v)) {
          message.error(`域名格式非法："${v}"（不能包含空格/中文/特殊字符）`);
          return false;
        }
      }
    }
    return true;
  };

  const next = () => {
    if (!validateStep(step)) return;
    if (step < STEPS.length - 1) setStep(step + 1);
  };

  const prev = () => {
    if (step > 0) setStep(step - 1);
  };

  const handleSubmit = async () => {
    if (!validateStep(0)) return;
    // captcha 必填校验 ----------------------------------
    if (captchaEnabled && !captchaToken) {
      message.warning('请先完成人机验证');
      return;
    }
    // 客户端配额/月度软校验（最终以服务端返回为准） -------------
    if (quotaInfo) {
      if (
        quotaInfo.monthly_limit > 0 &&
        quotaInfo.month_used >= quotaInfo.monthly_limit
      ) {
        message.error('本月证书申请次数已达上限');
        return;
      }
      if (
        quotaInfo.quota >= 0 &&
        quotaInfo.active_certs >= quotaInfo.quota
      ) {
        message.error('已达到证书配额上限');
        return;
      }
    }
    setSubmitting(true);
    try {
      // 组装 payload（统一去除空格 + 转小写，避免 ACME 服务端拒绝）
      const domainList: DomainItem[] = [];
      for (const d of state.domains) {
        const name = (d.domain || '').trim().toLowerCase();
        if (!name) continue;
        if (d.isIP) {
          // IP证书：不支持通配符，验证方式强制web-self
          domainList.push({
            name,
            wild: false,
            root: false,
            type: 'web-self',
            isIP: true,
          });
        } else {
          if (!d.wildcard || d.includeRoot) {
            domainList.push({
              name,
              wild: false,
              root: d.includeRoot,
              type: d.verification,
            });
          }
          if (d.wildcard) {
            domainList.push({
              name: `*.${name}`,
              wild: true,
              root: d.includeRoot,
              type: d.verification,
            });
          }
        }
      }

      const payload: ApplyPayload = {
        domains: domainList,
        globals: {
          ca: state.ca,
          auto_renew: state.auto_renew,
          encryption: state.encryption,
        },
        subject: {
          C: state.subject.country,
          S: state.subject.province,
          ST: state.subject.city,
          O: state.subject.organization,
          OU: state.subject.unit,
        },
      };

      const { uuid, warning } = await applyCert(
        payload,
        captchaEnabled ? captchaToken : undefined,
      );
      if (warning) {
        // 后端已创建订单，但 ACME 推进失败：用弹窗展示完整错误原因，确认后展示订单详情
        modal.error({
          title: '证书申请提交成功，但处理失败',
          content: (
            <div>
              <div style={{ marginBottom: 8 }}>请根据以下错误原因调整并重新提交：</div>
              <div
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: 12,
                  padding: 10,
                  borderRadius: 8,
                  background: 'rgba(255, 77, 79, 0.08)',
                  color: 'var(--text-1)',
                  border: '1px solid rgba(255, 77, 79, 0.3)',
                }}
              >
                {warning}
              </div>
            </div>
          ),
          okText: '查看订单',
          onOk: () => navigate(`/order/${uuid}`),
          width: 560,
        });
      } else {
        message.success('申请提交成功 ✨');
        setTimeout(() => navigate(`/order/${uuid}`), 600);
      }
    } catch (e: any) {
      message.error(e?.texts || e?.message || '申请失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageShell>
      <div className={styles.greet}>
        <TerminalPrompt
          host="certhub"
          path="~/apply"
          suffix={<span className={styles.cmdText}>new cert</span>}
        />
      </div>

      {/* 步骤指示器 */}
      <div className={styles.steps}>
        {STEPS.map((s, i) => (
          <button
            type="button"
            key={s.key}
            className={[
              styles.stepItem,
              i === step && styles.stepActive,
              i < step && styles.stepDone,
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => i <= step && setStep(i)}
          >
            <span className={styles.stepIcon}>
              {i < step ? <CheckCircle2 size={14} /> : s.icon}
            </span>
            <span className={styles.stepNum}>0{i + 1}</span>
            <span className={styles.stepTitle}>{s.title}</span>
          </button>
        ))}
      </div>

      {/* 主内容区（70/30 分栏） */}
      <div className={styles.mainArea}>
        <div className={styles.formArea}>
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.25 }}
            >
              {step === 0 && (
                <DomainSection
                  domains={state.domains}
                  onChange={updateDomains}
                  defaultRow={DEFAULT_DOMAIN}
                />
              )}
              {step === 1 && (
                <GlobalSection
                  ca={state.ca}
                  autoRenew={state.auto_renew}
                  encryption={state.encryption}
                  caSigns={bootstrap?.ca_signs}
                  onChange={updateGlobal}
                />
              )}
              {step === 2 && (
                <SubjectSection
                  subject={state.subject}
                  onChange={updateSubject}
                />
              )}
            </motion.div>
          </AnimatePresence>

          {/* 人机验证（仅在后端开启时渲染） ---------------------- */}
          {captchaEnabled && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                borderRadius: 10,
                border: '1px dashed var(--line-dashed)',
                background: 'var(--bg-panel-soft, transparent)',
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 6 }}>
                请先完成人机验证
              </div>
              <CertCaptcha onToken={setCaptchaToken} />
            </div>
          )}

          {/* 底部导航按钮 */}
          <div className={styles.navBar}>
            <Button
              onClick={prev}
              disabled={step === 0}
              icon={<ArrowLeft size={14} />}
              size="large"
            >
              上一步
            </Button>
            {step < STEPS.length - 1 ? (
              <Button
                type="primary"
                onClick={next}
                size="large"
                iconPosition="end"
                icon={<ArrowRight size={14} />}
              >
                下一步
              </Button>
            ) : (
              <Button
                type="primary"
                onClick={handleSubmit}
                loading={submitting}
                size="large"
                icon={<Send size={14} />}
                disabled={captchaEnabled && !captchaToken}
              >
                提交申请
              </Button>
            )}
          </div>
        </div>

        {/* 右侧实时预览 */}
        <aside className={styles.preview}>
          <div className={styles.previewCard}>
            <div className={styles.previewHeader}>
              <Sparkles size={14} />
              <span>实时预览</span>
            </div>

            <div className={styles.previewSection}>
              <div className={styles.previewLabel}>申请域名</div>
              {previewDomains.length === 0 ? (
                <div className={styles.previewEmpty}>
                  <Kaomoji mood="empty" inline size={12} /> 暂无域名
                </div>
              ) : (
                <ul className={styles.previewList}>
                  {previewDomains.map((d, i) => (
                    <li key={i}>
                      <CodeInline color="brand">{d}</CodeInline>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className={styles.previewSection}>
              <div className={styles.previewLabel}>全局设置</div>
              <div className={styles.previewRow}>
                <span className={styles.previewKey}>厂商</span>
                <Pill variant="lavender" size="xs">
                  {SIGN_SHORT_MAP[state.ca] || state.ca}
                </Pill>
              </div>
              <div className={styles.previewRow}>
                <span className={styles.previewKey}>算法</span>
                <Pill variant="accent" size="xs">
                  {TYPE_MAP[state.encryption] || state.encryption}
                </Pill>
              </div>
              <div className={styles.previewRow}>
                <span className={styles.previewKey}>自动续期</span>
                <Pill
                  variant={state.auto_renew ? 'ok' : 'neutral'}
                  size="xs"
                >
                  {state.auto_renew ? '已开启' : '未开启'}
                </Pill>
              </div>
            </div>

            {(state.subject.country ||
              state.subject.organization ||
              state.subject.province) && (
              <div className={styles.previewSection}>
                <div className={styles.previewLabel}>主体信息</div>
                {state.subject.country && (
                  <div className={styles.previewRow}>
                    <span className={styles.previewKey}>国家</span>
                    <span className={styles.previewVal}>
                      {state.subject.country}
                    </span>
                  </div>
                )}
                {state.subject.organization && (
                  <div className={styles.previewRow}>
                    <span className={styles.previewKey}>组织</span>
                    <span className={styles.previewVal}>
                      {state.subject.organization}
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className={styles.previewFooter}>
              <Kaomoji mood="happy" inline size={16} />
              <span>共 {previewDomains.length} 个域名待申请</span>
            </div>

            {/* 配额 / 月度限额信息 ======================================= */}
            {quotaInfo && (
              <div
                style={{
                  marginTop: 8,
                  paddingTop: 8,
                  borderTop: '1px dashed var(--line-dashed)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 12,
                  color: 'var(--text-3)',
                }}
              >
                <div>
                  本月剩余申请：
                  {quotaInfo.monthly_limit === 0 ? (
                    <Tag color="default">未限制</Tag>
                  ) : (
                    <Tag
                      color={
                        quotaInfo.month_used >= quotaInfo.monthly_limit
                          ? 'red'
                          : 'blue'
                      }
                    >
                      {Math.max(
                        0,
                        quotaInfo.monthly_limit - quotaInfo.month_used,
                      )}{' '}
                      / {quotaInfo.monthly_limit}
                    </Tag>
                  )}
                </div>
                <div>
                  证书配额：
                  {quotaInfo.quota < 0 ? (
                    <Tag color="default">不限</Tag>
                  ) : (
                    <Tag
                      color={
                        quotaInfo.active_certs >= quotaInfo.quota
                          ? 'red'
                          : 'blue'
                      }
                    >
                      {quotaInfo.active_certs} / {quotaInfo.quota}
                    </Tag>
                  )}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* 提交中全屏遮罩 ===================================== */}
      <Spin
        spinning={submitting}
        fullscreen
        size="large"
        tip="正在提交申请，请稍候..."
      />
    </PageShell>
  );
}

export type { DomainRowForm };
