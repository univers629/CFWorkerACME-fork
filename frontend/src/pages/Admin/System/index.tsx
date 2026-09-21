/**
 * 管理员 - 系统管理 /admin/system
 * 分组：
 *   - 站点
 *   - 邮件
 *   - 通知开关
 *   - 注册策略
 *   - 默认变量（vars 覆盖）
 *   - 防滥用（Captcha / 月度上限）
 *   - 开放 API
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Divider,
  Input,
  InputNumber,
  Modal,
  Row,
  Radio,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  ExperimentOutlined,
  ReloadOutlined,
  SaveOutlined,
  SendOutlined,
} from '@ant-design/icons';
import {
  fetchAdminConfs,
  saveAdminConf,
  deleteAdminConf,
  testMail,
  testCaptcha,
  testTelegram,
} from '@api/adminConfs';
import { useBootstrapStore } from '@stores/useBootstrapStore';

type Items = Record<string, any>;
type Touched = Record<string, boolean>;

/** 一个统一的"保存/回退"按钮组 */
function ItemActions({
  name,
  disabled,
  onSave,
  onReset,
}: {
  name: string;
  disabled?: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <Space size={4}>
      <Tooltip title="保存此项">
        <Button
          size="small"
          type="text"
          icon={<SaveOutlined />}
          disabled={disabled}
          onClick={onSave}
        />
      </Tooltip>
      <Tooltip title={`回退到环境变量 / 默认值（删除 Confs.${name}）`}>
        <Button
          size="small"
          type="text"
          danger
          icon={<DeleteOutlined />}
          onClick={onReset}
        />
      </Tooltip>
    </Space>
  );
}

function isBoolString(v: any): boolean {
  if (typeof v === 'boolean') return true;
  const s = String(v).toLowerCase();
  return s === 'true' || s === 'false' || s === '1' || s === '0';
}

function toBool(v: any): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

export default function AdminSystemPage() {
  const { message, modal } = AntdApp.useApp();
  const refreshBootstrap = useBootstrapStore((s) => s.refresh);

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Items>({});
  const [secretKeys, setSecretKeys] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState<Touched>({});

  // 邮件测试弹窗
  const [mailTestOpen, setMailTestOpen] = useState(false);
  const [mailTo, setMailTo] = useState('');
  const [mailTesting, setMailTesting] = useState(false);

  // 验证码测试弹窗
  const [captchaTestOpen, setCaptchaTestOpen] = useState(false);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaTesting, setCaptchaTesting] = useState(false);

  // Telegram 测试
  const [tgTesting, setTgTesting] = useState(false);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const res = await fetchAdminConfs();
      if (res.flags === 0) {
        setItems(res.items);
        setSecretKeys(new Set(res.secret_keys));
        setDirty({});
      } else {
        message.error(res.texts || '加载失败');
      }
    } catch (e: any) {
      message.error(e?.texts || e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markDirty = (name: string, value: any) => {
    setItems((prev) => ({ ...prev, [name]: value }));
    setDirty((prev) => ({ ...prev, [name]: true }));
  };

  const onSaveOne = async (name: string) => {
    try {
      const raw = items[name];
      const res: any = await saveAdminConf(name, raw);
      if (res?.flags === 0) {
        message.success(`${name} 已保存`);
        setDirty((prev) => ({ ...prev, [name]: false }));
        // 若保存影响 bootstrap 返回值（站点标题、邮件开关、验证码、注册策略）
        refreshBootstrap();
      } else {
        message.error(res?.texts || '保存失败');
      }
    } catch (e: any) {
      message.error(e?.texts || e?.message || '保存失败');
    }
  };

  const onResetOne = (name: string) => {
    modal.confirm({
      title: `回退 ${name}？`,
      content: '将删除数据库中该项配置，回退到环境变量或代码默认值。',
      okType: 'danger',
      onOk: async () => {
        const res: any = await deleteAdminConf(name);
        if (res?.flags === 0) {
          message.success('已回退');
          fetchAll();
          refreshBootstrap();
        } else {
          message.error(res?.texts || '回退失败');
        }
      },
    });
  };

  /** 渲染 boolean 项 */
  const renderBool = (name: string, label: string, help?: string) => {
    const val = toBool(items[name]);
    return (
      <Row align="middle" gutter={12} style={{ marginBottom: 12 }}>
        <Col flex="220px">
          <Space>
            <span>{label}</span>
            {dirty[name] && <Tag color="gold">未保存</Tag>}
          </Space>
          {help && (
            <div style={{ fontSize: 12, color: '#6b7280' }}>{help}</div>
          )}
        </Col>
        <Col flex="auto">
          <Switch
            checked={val}
            onChange={(v) => markDirty(name, v)}
          />
        </Col>
        <Col>
          <ItemActions
            name={name}
            disabled={!dirty[name]}
            onSave={() => onSaveOne(name)}
            onReset={() => onResetOne(name)}
          />
        </Col>
      </Row>
    );
  };

  /** 渲染字符串项 */
  const renderText = (
    name: string,
    label: string,
    opts?: { help?: string; placeholder?: string; textarea?: boolean },
  ) => {
    const isSecret = secretKeys.has(name);
    const configured =
      isSecret && typeof items[name] === 'object'
        ? !!items[name]?.configured
        : undefined;
    const val = isSecret ? '' : (items[name] ?? '');
    return (
      <Row align="top" gutter={12} style={{ marginBottom: 12 }}>
        <Col flex="220px">
          <Space>
            <span>{label}</span>
            {isSecret &&
              (configured ? (
                <Tag color="green">已配置</Tag>
              ) : (
                <Tag>未配置</Tag>
              ))}
            {dirty[name] && <Tag color="gold">未保存</Tag>}
          </Space>
          {opts?.help && (
            <div style={{ fontSize: 12, color: '#6b7280' }}>{opts.help}</div>
          )}
        </Col>
        <Col flex="auto">
          {opts?.textarea ? (
            <Input.TextArea
              rows={3}
              value={val}
              placeholder={
                isSecret ? '（保持为空表示不修改）' : opts?.placeholder
              }
              onChange={(e) => markDirty(name, e.target.value)}
            />
          ) : isSecret ? (
            <Input.Password
              value={val}
              placeholder="（保持为空表示不修改）"
              onChange={(e) => markDirty(name, e.target.value)}
              autoComplete="off"
            />
          ) : (
            <Input
              value={val}
              placeholder={opts?.placeholder}
              onChange={(e) => markDirty(name, e.target.value)}
              autoComplete="off"
            />
          )}
        </Col>
        <Col>
          <ItemActions
            name={name}
            disabled={!dirty[name]}
            onSave={() => onSaveOne(name)}
            onReset={() => onResetOne(name)}
          />
        </Col>
      </Row>
    );
  };

  /** 渲染 number 项 */
  const renderNumber = (
    name: string,
    label: string,
    opts?: { help?: string; min?: number; max?: number },
  ) => {
    const val = Number(items[name] ?? 0);
    return (
      <Row align="middle" gutter={12} style={{ marginBottom: 12 }}>
        <Col flex="220px">
          <Space>
            <span>{label}</span>
            {dirty[name] && <Tag color="gold">未保存</Tag>}
          </Space>
          {opts?.help && (
            <div style={{ fontSize: 12, color: '#6b7280' }}>{opts.help}</div>
          )}
        </Col>
        <Col flex="auto">
          <InputNumber
            value={val}
            min={opts?.min}
            max={opts?.max}
            style={{ width: 200 }}
            onChange={(v) => markDirty(name, v)}
          />
        </Col>
        <Col>
          <ItemActions
            name={name}
            disabled={!dirty[name]}
            onSave={() => onSaveOne(name)}
            onReset={() => onResetOne(name)}
          />
        </Col>
      </Row>
    );
  };

  /** 渲染单选项 */
  const renderSelect = (
    name: string,
    label: string,
    options: { value: string; label: string }[],
    help?: string,
  ) => {
    const val = String(items[name] ?? '');
    return (
      <Row align="middle" gutter={12} style={{ marginBottom: 12 }}>
        <Col flex="220px">
          <Space>
            <span>{label}</span>
            {dirty[name] && <Tag color="gold">未保存</Tag>}
          </Space>
          {help && <div style={{ fontSize: 12, color: '#6b7280' }}>{help}</div>}
        </Col>
        <Col flex="auto">
          <Radio.Group
            value={val}
            onChange={(e) => markDirty(name, e.target.value)}
            optionType="button"
            buttonStyle="solid"
          >
            {options.map((o) => (
              <Radio.Button key={o.value} value={o.value}>{o.label}</Radio.Button>
            ))}
          </Radio.Group>
        </Col>
        <Col>
          <ItemActions
            name={name}
            disabled={!dirty[name]}
            onSave={() => onSaveOne(name)}
            onReset={() => onResetOne(name)}
          />
        </Col>
      </Row>
    );
  };

  /** 关闭邮件功能前的二次确认 */
  const handleMailEnabledSave = async () => {
    const next = toBool(items.MAIL_ENABLED);
    if (!next) {
      modal.confirm({
        title: '确认关闭邮箱功能？',
        content:
          '关闭后将停用：注册验证码、密码重置验证码、以及全部证书状态通知邮件。',
        okType: 'danger',
        onOk: () => onSaveOne('MAIL_ENABLED'),
      });
    } else {
      onSaveOne('MAIL_ENABLED');
    }
  };

  const doMailTest = async () => {
    if (!mailTo.trim()) {
      message.error('请输入收件地址');
      return;
    }
    setMailTesting(true);
    try {
      const res: any = await testMail(mailTo.trim());
      if (res?.flags === 0) message.success('测试邮件已发送，请查收');
      else message.error(res?.texts || '发送失败');
    } catch (e: any) {
      message.error(e?.texts || e?.message || '发送失败');
    } finally {
      setMailTesting(false);
    }
  };

  const doTelegramTest = async () => {
    setTgTesting(true);
    try {
      const res: any = await testTelegram();
      if (res?.flags === 0) message.success(res?.texts || '测试消息已发送');
      else message.error(res?.texts || '发送失败');
    } catch (e: any) {
      message.error(e?.texts || e?.message || '发送失败');
    } finally {
      setTgTesting(false);
    }
  };

  const doCaptchaTest = async () => {
    if (!captchaToken.trim()) {
      message.error('请先在其它标签页获取一次验证码 token 并粘贴到此处');
      return;
    }
    setCaptchaTesting(true);
    try {
      const res: any = await testCaptcha(captchaToken.trim());
      if (res?.flags === 0) message.success('验证通过');
      else {
        const codes = (res?.provider_error_codes ?? []).join(', ');
        message.error(
          '验证失败' + (codes ? ` · provider 错误码：${codes}` : ''),
        );
      }
    } catch (e: any) {
      message.error(e?.texts || e?.message || '测试失败');
    } finally {
      setCaptchaTesting(false);
    }
  };

  const mailEnabledBtnSave = useMemo(
    () => (
      <Button
        size="small"
        type="text"
        icon={<SaveOutlined />}
        disabled={!dirty.MAIL_ENABLED}
        onClick={handleMailEnabledSave}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dirty.MAIL_ENABLED, items.MAIL_ENABLED],
  );

  return (
    <div style={{ padding: 24, maxWidth: 1080, margin: '0 auto' }}>
      <Space style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          系统管理
        </Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={fetchAll} loading={loading}>
          刷新
        </Button>
      </Space>

      {/* 站点 =================================================== */}
      <Card title="站点" style={{ marginBottom: 16 }}>
        {renderText('SITE_TITLE', '站点标题', {
          help: '显示于侧边栏与浏览器标签',
        })}
        {renderText('SITE_HOST', '站点域名', {
          help: '用于邮件与前端链接生成',
        })}
      </Card>

      {/* 邮件 =================================================== */}
      <Card title="邮件" style={{ marginBottom: 16 }}>
        <Row align="middle" gutter={12} style={{ marginBottom: 12 }}>
          <Col flex="220px">
            <Space>
              <span>启用邮箱功能</span>
              {dirty.MAIL_ENABLED && <Tag color="gold">未保存</Tag>}
            </Space>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              关闭将禁用验证码与所有邮件通知
            </div>
          </Col>
          <Col flex="auto">
            <Switch
              checked={toBool(items.MAIL_ENABLED)}
              onChange={(v) => markDirty('MAIL_ENABLED', v)}
            />
          </Col>
          <Col>
            <Space>
              {mailEnabledBtnSave}
              <Tooltip title="回退到环境变量 / 默认值">
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => onResetOne('MAIL_ENABLED')}
                />
              </Tooltip>
            </Space>
          </Col>
        </Row>

        {renderText('MAIL_KEYS', 'Resend API Key', {
          help: '对应环境变量 MAIL_KEYS（Resend 控制台生成）',
        })}
        {renderText('MAIL_SEND', '发件地址', {
          placeholder: 'noreply@your-domain.com',
          help: '对应环境变量 MAIL_SEND',
        })}
        <Divider style={{ margin: '12px 0' }} />
        {renderBool(
          'NOTIFY_ON_SUCCESS',
          '证书签发成功通知',
          'flag 变为 5 时发送',
        )}
        {renderBool('NOTIFY_ON_FAIL', '证书签发失败通知')}
        {renderBool('NOTIFY_ON_EXPIRE7', '证书过期前 7 天提醒')}
        {renderBool('NOTIFY_ON_EXPIRED', '证书已过期通知')}
        <Divider style={{ margin: '12px 0' }} />
        {renderBool(
          'AUTO_RENEW_ENABLED',
          '自动续期',
          '对申请时勾选了「自动续期」的订单生效',
        )}
        {renderNumber('AUTO_RENEW_DAYS', '提前续期天数', {
          min: 1,
          help: '距到期不足该天数时自动重新签发',
        })}
        <Divider style={{ margin: '12px 0' }} />
        <Button
          icon={<SendOutlined />}
          onClick={() => setMailTestOpen(true)}
        >
          发送测试邮件
        </Button>
      </Card>

      {/* Telegram 推送 ============================================== */}
      <Card title="Telegram 推送" style={{ marginBottom: 16 }}>
        {renderBool(
          'TG_BOT_ENABLED',
          '启用 Telegram 推送',
          '关闭后下列事件不再推送到 Telegram（邮件通知不受影响）',
        )}
        {renderText('TG_BOT_TOKEN', 'Bot Token', {
          help: '在 Telegram 里找 @BotFather 创建机器人后获得，形如 123456:ABC-DEF...',
          placeholder: '123456789:AA...',
        })}
        {renderText('TG_CHAT_ID', 'Chat ID', {
          help: '支持多个，逗号分隔。私聊为正数，群组为负数（-100 开头）；推送到群组时群成员可见消息内容',
          placeholder: '-1001234567890',
        })}
        <Button
          icon={<SendOutlined />}
          loading={tgTesting}
          onClick={doTelegramTest}
        >
          发送测试消息
        </Button>
      </Card>

      {/* 注册策略 =================================================== */}
      <Card title="注册策略" style={{ marginBottom: 16 }}>
        {renderBool(
          'REGISTER_ALLOW',
          '允许注册',
          '关闭后登录页将隐藏注册 Tab',
        )}
        {renderText('REGISTER_CODE', '注册邀请码', {
          help: '留空表示不校验邀请码',
        })}
        {renderNumber('DEFAULT_QUOTA', '新用户默认配额', {
          min: -1,
          help: '-1 表示不限制；修改不影响存量用户',
        })}
      </Card>

      {/* DCV（Cloudflare DNS 代理）============================= */}
      <Card title="DCV（Cloudflare DNS 代理）" style={{ marginBottom: 16 }}>
        {renderText('DCV_AGENT', 'DCV_AGENT', {
          help: '用于 dns-auto 模式下的验证子域后缀',
        })}
        {renderText('DCV_EMAIL', 'DCV_EMAIL', {
          help: 'Cloudflare 账户邮箱（X-Auth-Email）',
        })}
        {renderText('DCV_TOKEN', 'DCV_TOKEN', {
          help: 'Cloudflare Global API Key / Key Token',
        })}
        {renderText('DCV_ZONES', 'DCV_ZONES', {
          help: '可留空：留空时按域名自动匹配 Zone。多个用逗号分隔。自动匹配需要 Token 具备 Zone:Read',
        })}
      </Card>

      {/* 证书提供商 · 三家 CA ==================================== */}
      <Card
        title="证书提供商（CA）"
        style={{ marginBottom: 16 }}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            *_KeyTS 为账户私钥 PEM，出于安全不回显明文，可覆盖保存
          </Typography.Text>
        }
      >
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          Google Trust Services
        </Typography.Title>
        {renderBool('GTS_useIt', '启用 GTS', '关闭后前端隐藏该选项')}
        {renderText('GTS_keyMC', 'GTS_keyMC（HMAC Key）')}
        {renderText('GTS_keyID', 'GTS_keyID（EAB KID）')}
        {renderText('GTS_KeyTS', 'GTS_KeyTS（账户私钥 PEM）', {
          textarea: true,
        })}
        <Divider />
        <Typography.Title level={5}>SSL.com</Typography.Title>
        {renderBool('SSL_useIt', '启用 SSL.com')}
        {renderText('SSL_keyMC', 'SSL_keyMC（HMAC Key）')}
        {renderText('SSL_keyID', 'SSL_keyID（EAB KID）')}
        {renderText('SSL_KeyTS', 'SSL_KeyTS（账户私钥 PEM）', {
          textarea: true,
        })}
        <Divider />
        <Typography.Title level={5}>ZeroSSL</Typography.Title>
        {renderBool('ZRO_useIt', '启用 ZeroSSL')}
        {renderText('ZRO_keyMC', 'ZRO_keyMC（HMAC Key）')}
        {renderText('ZRO_keyID', 'ZRO_keyID（EAB KID）')}
        {renderText('ZRO_KeyTS', 'ZRO_KeyTS（账户私钥 PEM）', {
          textarea: true,
        })}
      </Card>

      {/* 防滥用 =================================================== */}
      <Card title="申请防滥用" style={{ marginBottom: 16 }}>
        {renderBool(
          'CERT_CAPTCHA_ENABLED',
          '申请证书需要人机验证',
          '开启后前端必须完成验证；开放 API 将无法提交申请',
        )}
        {renderBool(
          'BASE_CAPTCHA_ENABLED',
          '登录/注册/找回密码需要人机验证',
          '开启后登录、注册、找回密码发送邮件验证码前必须完成人机验证',
        )}
        {renderSelect(
          'CERT_CAPTCHA_PROVIDER',
          '验证码提供商',
          [
            { value: 'turnstile', label: 'Cloudflare Turnstile' },
            { value: 'hcaptcha', label: 'hCaptcha' },
            { value: 'recaptcha', label: 'reCAPTCHA v2' },
          ],
          '修改后请同步更新下方 Site Key / Secret Key',
        )}
        {renderText('SITE_KEYS', 'Site Key（SITE_KEYS）', {
          help: '前端 widget 使用；也兼容旧键 CERT_CAPTCHA_SITE_KEY',
        })}
        {renderText('AUTH_KEYS', 'Secret Key（AUTH_KEYS）', {
          help: '服务端校验使用；也兼容旧键 CERT_CAPTCHA_SECRET_KEY',
        })}
        <Button
          icon={<ExperimentOutlined />}
          onClick={() => setCaptchaTestOpen(true)}
        >
          测试验证码
        </Button>
        <Divider style={{ margin: '12px 0' }} />
        {renderNumber('MONTHLY_APPLY_LIMIT', '每月申请上限', {
          min: 0,
          help: '0 表示不限制；以 UTC 自然月为窗口',
        })}
      </Card>

      {/* 开放 API =================================================== */}
      <Card title="开放 API" style={{ marginBottom: 16 }}>
        {renderNumber('API_RATE_LIMIT', '速率限制（次/分钟）', {
          min: 1,
          max: 10000,
        })}
      </Card>

      {/* 邮件测试弹窗 =============================================== */}
      <Modal
        open={mailTestOpen}
        title="发送测试邮件"
        onCancel={() => setMailTestOpen(false)}
        onOk={doMailTest}
        okText="发送"
        confirmLoading={mailTesting}
        destroyOnClose
      >
        <Typography.Paragraph>
          调用当前配置的 <code>MAIL_KEYS</code> 与 <code>MAIL_SEND</code>{' '}
          发送一封测试邮件。
        </Typography.Paragraph>
        <Input
          placeholder="收件地址"
          value={mailTo}
          onChange={(e) => setMailTo(e.target.value)}
        />
      </Modal>

      {/* 验证码测试弹窗 =========================================== */}
      <Modal
        open={captchaTestOpen}
        title="测试验证码"
        onCancel={() => setCaptchaTestOpen(false)}
        onOk={doCaptchaTest}
        okText="提交校验"
        confirmLoading={captchaTesting}
        destroyOnClose
      >
        <Typography.Paragraph>
          粘贴一个由当前 provider 生成的 response token，用于校验 secret 是否正确。
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          placeholder="把验证码 token 粘贴到此处"
          value={captchaToken}
          onChange={(e) => setCaptchaToken(e.target.value)}
        />
      </Modal>
    </div>
  );
}
