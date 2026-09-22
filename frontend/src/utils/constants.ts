/* ============================================================
 * 业务常量映射
 * ============================================================ */

// 证书厂商
export const SIGN_MAP: Record<string, string> = {
  'lets-encrypt': "Let's Encrypt Global",
  'google-trust': 'Google Trust Service',
  'bypass-trust': 'Bypass Trust Service',
  'zeroca-trust': 'ZeroSSL Free Service',
  'sslcom-trust': 'SSL.com Free Service',
};

export const SIGN_SHORT_MAP: Record<string, string> = {
  'lets-encrypt': "Let's Encrypt",
  'google-trust': 'Google Trust',
  'bypass-trust': 'Bypass Trust',
  'zeroca-trust': 'ZeroSSL',
  'sslcom-trust': 'SSL.com',
};

export const SIGN_OPTIONS = [
  {
    value: 'google-trust',
    label: 'Google Trust Service',
    desc: '优先使用，不支持中文域名',
  },
  {
    value: 'lets-encrypt',
    label: "Let's Encrypt Global",
    desc: '失败备用，申请速度较慢',
  },
  {
    value: 'zeroca-trust',
    label: 'ZeroSSL Free Service',
    desc: '失败备用，申请速度较慢',
  },
  {
    value: 'sslcom-trust',
    label: 'SSL.com Free Service',
    desc: '失败备用，申请速度较慢',
  },
];

// 加密算法
export const TYPE_MAP: Record<string, string> = {
  rsa2048: 'RSA 2048',
  eccp256: 'ECC P256',
  eccp384: 'ECC P384',
};

export const TYPE_OPTIONS = [
  { value: 'rsa2048', label: 'RSA 2048', desc: '兼容好' },
  { value: 'eccp256', label: 'ECC P256', desc: '速度快' },
  { value: 'eccp384', label: 'ECC P384', desc: '安全好' },
];

// 订单状态
export const FLAG_MAP: Record<string | number, string> = {
  '-1': '已失效',
  '0': '等待中',
  '1': '创建中',
  '2': '待验证',
  '3': '验证中',
  '4': '申请中',
  '5': '已完成',
};

// 中间态：由后台任务/cron 自动推进，前端需轮询才能看到变化。
// 不含 2（待验证，需用户配置 DNS 后手动触发）与 -1/5（终态）。
export const TRANSIENT_FLAGS = new Set<number>([0, 1, 3, 4]);

// 订单状态 → 颜色 token 名
export const FLAG_COLOR: Record<string | number, string> = {
  '-1': 'err',
  '0': 'info',
  '1': 'info',
  '2': 'warn',
  '3': 'info',
  '4': 'info',
  '5': 'ok',
};

// 订单状态 → 脉搏状态
export const FLAG_PULSE: Record<
  string | number,
  'pending' | 'verifying' | 'success' | 'failed' | 'expired'
> = {
  '-1': 'failed',
  '0': 'pending',
  '1': 'pending',
  '2': 'pending',
  '3': 'verifying',
  '4': 'verifying',
  '5': 'success',
};

// 验证方式
export const AUTH_MAP: Record<string, string> = {
  'dns-self': 'TXT 手动验证',
  'web-self': 'WEB 手动验证',
  'dns-auto': 'TXT 自动验证',
};

export const AUTH_OPTIONS = [
  { value: 'dns-self', label: 'DNS TXT 手动' },
  { value: 'dns-auto', label: 'DNS CNAME 自动' },
  { value: 'web-self', label: 'WEB 文件验证' },
];

// IP证书模式下只允许WEB验证
export const AUTH_OPTIONS_IP = [
  { value: 'web-self', label: 'WEB 文件验证' },
];

// 订单操作
export const AUTH_ACT_MAP: Record<string, string> = {
  verify: '验证全部',
  reload: '重新生成',
  modify: '修改申请',
  cancel: '撤销申请',
  single: '单条验证',
  ca_get: '下载证书',
  ca_key: '下载密钥',
  re_new: '续期证书',
  rm_key: '删除密钥',
  ca_del: '吊销证书',
};

// Turnstile Site Key（来自原 login.html）
export const TURNSTILE_SITE_KEY = '0x4AAAAAABa7S19lK0Kn_TWK';

// Gravatar 默认头像
export const GRAVATAR_BASE = 'https://www.gravatar.com/avatar/';

// GitHub 仓库
export const GITHUB_URL = 'https://github.com/univers629/CFWorkerACME-fork';

// 产品信息
export const APP_NAME = 'CertHub';
export const APP_SUBTITLE = 'SSL 证书助手';
export const APP_VERSION = '2.0.0';
