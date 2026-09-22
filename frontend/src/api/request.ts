import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import type { ApiResp } from './types';

/**
 * 全局事件桥：让拦截器能调用 App 内的 message/notification
 * 避免在模块加载期导入 App 实例的循环依赖问题
 */
type ToastFn = (msg: string) => void;
type UnauthorizedFn = () => void;

let toastError: ToastFn = (msg) => console.error('[API]', msg);
let onUnauthorized: UnauthorizedFn = () => {
  window.location.hash = '#/login';
};

export function configureApiHandlers(handlers: {
  onError?: ToastFn;
  onUnauthorized?: UnauthorizedFn;
}) {
  if (handlers.onError) toastError = handlers.onError;
  if (handlers.onUnauthorized) onUnauthorized = handlers.onUnauthorized;
}

/* ------------------------------------------------------------ */

const instance: AxiosInstance = axios.create({
  baseURL: '/',
  timeout: 30000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 请求拦截器（预留扩展）
instance.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => config,
  (error) => Promise.reject(error),
);

// 响应拦截器
// 说明：由于后端各接口对 flags 字段的语义并不统一
//   - /login/ 成功返回 {flags: 1}
//   - /check/ 成功返回 {flags: 0}，未登录返回 {flags: 2}
//   - /nonce/ 成功返回 {nonce: '...'}，失败返回 {flags: !=0}
// 因此拦截器不再对 flags 做统一业务判定，仅处理 HTTP 层面错误和 401 未登录跳转，
// 业务语义请各 API 调用方自行根据 res.data.flags 判断。
instance.interceptors.response.use(
  (res: AxiosResponse<ApiResp>) => {
    // 2xx 响应直接透传，业务层自行解析 flags
    return res as any;
  },
  (err: AxiosError<ApiResp>) => {
    // 统一从后端返回体里提取业务错误文案
    // 后端风格不统一：有的用 nonce（如 /nonce/、mailSend、userAuth 返回的 "请先完成验证"/"邮件发送失败：..."），
    // 有的用 texts / message / error，兜底才使用 axios 本身的 err.message（如 "Request failed with status code 403"）
    const data: any = err.response?.data;
    const pickMsg = (d: any): string | undefined => {
      if (!d) return undefined;
      if (typeof d === 'string') return d;
      if (typeof d !== 'object') return undefined;
      // 优先顺序：nonce(业务错误文案) > texts > message > error > msg
      return d.nonce || d.texts || d.message || d.error || d.msg;
    };
    const bizMsg = pickMsg(data);
    const finalMsg = bizMsg || err.message || '网络异常，请稍后重试';

    if (err.response?.status === 401 || err.response?.data?.flags === 2) {
      onUnauthorized();
    } else if (!(err.config as any)?.silent) {
      // 后台轮询（silent）失败不弹 toast：轮询间隔只有数秒，
      // 网络抖动或后端忙时会连续弹出同一句错误，把界面刷满。
      // 失败信息由调用方按需展示（例如订单页保留上一次成功的数据）。
      toastError(finalMsg);
    }
    // 把业务错误文案注入到 reject 对象的 message 字段，
    // 这样调用方用 err.message 也能拿到友好的中文提示，
    // 避免组件里显示 "Request failed with status code 403"
    const rejectPayload: any = (data && typeof data === 'object') ? { ...data } : {};
    rejectPayload.message = finalMsg;
    rejectPayload.status = err.response?.status;
    return Promise.reject(rejectPayload);
  },
);

export const http = instance;

/**
 * 便捷 GET（返回 data 部分）
 *
 * `silent: true` 表示后台轮询：失败时不弹全局 toast，由调用方自行处理。
 * 该字段经 axios config 透传，拦截器通过 `err.config.silent` 读取。
 */
export async function apiGet<T = ApiResp>(
  url: string,
  params?: Record<string, any>,
  opts?: { silent?: boolean },
): Promise<T> {
  const res = await instance.get<T>(url, { params, ...(opts as any) });
  return res.data;
}

/**
 * 便捷 POST
 */
export async function apiPost<T = ApiResp>(
  url: string,
  body?: any,
): Promise<T> {
  const res = await instance.post<T>(url, body);
  return res.data;
}

export default instance;
