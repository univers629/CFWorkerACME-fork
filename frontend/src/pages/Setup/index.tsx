/**
 * 系统初始化向导页 /setup
 * -----------------------------------------------------------------
 * 逻辑：
 *   1. 挂载后调用 /bootstrap 获取初始化状态 + 数据源探测；
 *   2. 若 initialized=true 直接跳转首页；
 *   3. 若 db_ok=false 展示错误面板且禁用表单提交；
 *   4. 表单提交后 POST /setup，成功后刷新 bootstrap 并跳转 /login。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Checkbox,
  Form,
  Input,
  Space,
  Tag,
} from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  DatabaseOutlined,
  LoadingOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useBootstrapStore } from '@stores/useBootstrapStore';
import { submitSetup } from '@api/system';
import { sha256, isValidEmail } from '@utils/crypto';
import styles from './Setup.module.css';

interface FormValues {
  site_host: string;
  site_title: string;
  admin_mail: string;
  admin_pass: string;
  admin_pass_confirm: string;
  mail_enabled: boolean;
  mail_keys?: string;
  mail_send?: string;
  /** 初始化令牌：后端为 token 模式时必填 */
  setup_token?: string;
}

function SetupPage() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const { info, loading, error, refresh } = useBootstrapStore();

  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);
  const mailEnabled = Form.useWatch('mail_enabled', form);

  // 首次进入时刷新一次（若已初始化则跳走）
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (info?.initialized) {
      navigate('/login', { replace: true });
    }
  }, [info?.initialized, navigate]);

  const dbOk = !!info?.db_ok;
  const dbSource = info?.db_source ?? 'unset';
  const dbErr = info?.db_error;
  // 初始化安全模式：preset（已预置，向导关闭）/ token（需令牌）/ locked（未配置）
  const setupMode = info?.setup_mode ?? 'locked';
  const needToken = setupMode === 'token';
  const isLocked = setupMode === 'locked';
  const isPreset = setupMode === 'preset';
  const canSubmit = useMemo(
    () => dbOk && !info?.initialized && !isLocked,
    [dbOk, info, isLocked],
  );

  const onSubmit = async (v: FormValues) => {
    if (!canSubmit) return;
    if (v.admin_pass !== v.admin_pass_confirm) {
      message.error('两次输入的密码不一致');
      return;
    }
    if (!isValidEmail(v.admin_mail)) {
      message.error('管理员邮箱格式不正确');
      return;
    }
    setSubmitting(true);
    try {
      // 与现有 userPost 一致：后端存储 SHA256(明文) 的 hex
      const hashed = await sha256(v.admin_pass);
      const resp = await submitSetup({
        site_host: v.site_host.trim(),
        site_title: v.site_title.trim(),
        admin_mail: v.admin_mail.trim().toLowerCase(),
        admin_pass: hashed,
        mail_enabled: !!v.mail_enabled,
        mail_keys: v.mail_enabled ? v.mail_keys?.trim() : undefined,
        mail_send: v.mail_enabled ? v.mail_send?.trim() : undefined,
        setup_token: needToken ? v.setup_token?.trim() : undefined,
      });
      if (resp && (resp as any).flags === 0) {
        message.success('系统初始化完成，即将跳转登录页');
        await refresh();
        setTimeout(() => navigate('/login', { replace: true }), 800);
      } else {
        message.error((resp as any)?.texts || '初始化失败');
      }
    } catch (e: any) {
      message.error(e?.texts || e?.message || '初始化失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.setupPage}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.title}>
            <ThunderboltOutlined /> 系统初始化向导
          </div>
          <div className={styles.subtitle}>
            首次部署请完成以下步骤。完成后该页面将不可再次访问，请妥善保管管理员密码。
          </div>
        </div>

        {/* 探测面板 ======================================================= */}
        <div className={`${styles.probe} ${dbOk ? styles.ok : styles.err}`}>
          <div className={styles.probeRow}>
            <DatabaseOutlined />
            <span className={styles.probeLabel}>数据源</span>
            <Tag color={dbSource === 'unset' ? 'red' : 'blue'}>
              DB_SOURCE = {dbSource}
            </Tag>
            {loading ? (
              <Tag icon={<LoadingOutlined />}>探测中</Tag>
            ) : dbOk ? (
              <Tag color="success" icon={<CheckCircleFilled />}>
                连通
              </Tag>
            ) : (
              <Tag color="error" icon={<CloseCircleFilled />}>
                不可用
              </Tag>
            )}
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              onClick={() => refresh()}
              loading={loading}
            >
              重新探测
            </Button>
          </div>
          {!dbOk && (
            <>
              <div className={styles.errorText}>
                {dbErr || error || '数据库尚不可用'}
              </div>
              <div className={styles.hint}>
                请在 <code>wrangler.jsonc</code>（或环境变量）中正确设置{' '}
                <code>DB_SOURCE</code> 后重新部署；可选值：
                <code>d1</code> / <code>mysql</code> / <code>prisma</code>
                {dbSource === 'mysql' ? (
                  <>，并提供 <code>DB_MYSQL_URL</code> 或主机参数</>
                ) : null}
                {dbSource === 'prisma' ? (
                  <>，并提供 <code>DATABASE_URL</code></>
                ) : null}
                。
              </div>
            </>
          )}
        </div>

        {/* 安全模式提示 ==================================================== */}
        {isLocked && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            message="初始化向导未启用"
            description={
              <>
                为防止站点被扫描后抢注管理员，初始化接口默认拒绝服务。请先在 Worker
                的环境变量中配置 <code>ADMIN_MAIL</code> + <code>ADMIN_PASS</code>
                （推荐，会自动建好管理员），或配置 <code>SETUP_TOKEN</code> 后重新部署。
              </>
            }
          />
        )}
        {isPreset && !info?.initialized && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="正在按预置配置创建管理员"
            description={
              info?.setup_error
                ? `自动初始化失败：${info.setup_error}`
                : '已检测到 ADMIN_MAIL / ADMIN_PASS，系统会自动创建管理员，无需手动初始化。'
            }
          />
        )}
        {needToken && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="需要初始化令牌"
            description={
              <>
                本次初始化必须填写环境变量 <code>SETUP_TOKEN</code> 的值，否则会被拒绝。
              </>
            }
          />
        )}

        {/* 表单 ========================================================== */}
        <Form<FormValues>
          form={form}
          layout="vertical"
          initialValues={{
            site_title: 'SSL 证书助手',
            mail_enabled: false,
            site_host: typeof window !== 'undefined' ? window.location.host : '',
          }}
          onFinish={onSubmit}
          disabled={!canSubmit || submitting}
        >
          {needToken && (
            <Form.Item
              label="初始化令牌"
              name="setup_token"
              rules={[{ required: true, message: '请输入 SETUP_TOKEN' }]}
              extra="对应部署时配置的环境变量 SETUP_TOKEN"
            >
              <Input.Password placeholder="SETUP_TOKEN" autoComplete="off" />
            </Form.Item>
          )}
          <Form.Item
            label="站点域名"
            name="site_host"
            rules={[{ required: true, message: '请输入站点访问域名' }]}
          >
            <Input placeholder="例如 acme.example.com" autoComplete="off" />
          </Form.Item>

          <Form.Item
            label="站点标题"
            name="site_title"
            rules={[{ required: true, message: '请输入站点标题' }]}
          >
            <Input placeholder="用于顶栏与浏览器标签" autoComplete="off" />
          </Form.Item>

          <Form.Item
            label="管理员邮箱"
            name="admin_mail"
            rules={[{ required: true, message: '请输入管理员邮箱' }]}
          >
            <Input placeholder="该邮箱将被赋予管理员身份" autoComplete="off" />
          </Form.Item>

          <Form.Item
            label="管理员密码"
            name="admin_pass"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 8, message: '密码长度至少 8 位' },
            ]}
          >
            <Input.Password placeholder="至少 8 位" autoComplete="new-password" />
          </Form.Item>

          <Form.Item
            label="重复密码"
            name="admin_pass_confirm"
            dependencies={['admin_pass']}
            rules={[
              { required: true, message: '请再次输入密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('admin_pass') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('两次输入的密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password placeholder="再次输入以确认" autoComplete="new-password" />
          </Form.Item>

          <Form.Item name="mail_enabled" valuePropName="checked">
            <Checkbox>启用邮箱功能（注册验证码、邮件通知）</Checkbox>
          </Form.Item>

          {mailEnabled ? (
            <>
              <Form.Item
                label="Resend API Key"
                name="mail_keys"
                rules={[{ required: true, message: '启用邮箱功能时必填' }]}
              >
                <Input.Password placeholder="re_xxxxxxxx" autoComplete="off" />
              </Form.Item>
              <Form.Item
                label="发件地址"
                name="mail_send"
                rules={[{ required: true, message: '启用邮箱功能时必填' }]}
              >
                <Input placeholder="noreply@your-domain.com" autoComplete="off" />
              </Form.Item>
            </>
          ) : null}

          <div className={styles.footer}>
            <Space>
              <Button onClick={() => form.resetFields()} disabled={submitting}>
                重置
              </Button>
              <Button
                type="primary"
                htmlType="submit"
                loading={submitting}
                disabled={!canSubmit}
              >
                完成初始化
              </Button>
            </Space>
          </div>
        </Form>
      </div>
    </div>
  );
}

export default SetupPage;
