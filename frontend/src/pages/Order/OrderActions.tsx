import { App as AntdApp, Button } from 'antd';
import {
  Archive,
  Download,
  FileLock2,
  Key,
  Pencil,
  PlayCircle,
  RotateCcw,
  ShieldOff,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import type { Order, OrderAction } from '@api/types';
import { handleDownloadZip, handleDownloadPfx } from '@utils/certDownload';
import styles from './Order.module.css';

export interface OrderActionsProps {
  order: Order;
  operating: boolean;
  onAction: (
    action: OrderAction,
    domainName?: string,
    opts?: {
      confirm?: string;
      danger?: boolean;
      filename?: string;
      /** 需要用户输入此字段值才能确认（通常传订单ID） */
      requireConfirmId?: string;
      /** 吊销证书时是否提示选择原因 */
      pickRevokeReason?: boolean;
    },
  ) => void;
}

export default function OrderActions({
  order,
  operating,
  onAction,
}: OrderActionsProps) {
  const { message } = AntdApp.useApp();
  const isPending = order.flag >= 0 && order.flag < 5;
  const isVerifiable = order.flag === 2;
  const isSigned = order.flag === 5;
  // flag=-1：订单被判定失败。此前这个状态下整个操作区都不渲染，
  // 用户既不能重试也不能重新生成，只能删掉订单重建。
  // 但失败可能是临时的（CA 网关 502 等），必须留一个重试入口。
  const isFailed = order.flag === -1;
  const hasCert = !!order.cert;
  const hasKey = !!order.keys;

  return (
    <div className={styles.actionsBar}>
      {isPending && (
        <>
          <Button
            type="primary"
            size="large"
            icon={<Zap size={16} />}
            loading={operating}
            onClick={() =>
              onAction('process', undefined, {
                confirm:
                  '确认立即处理此订单？需要一些时间',
              })
            }
          >
            立即处理
          </Button>
          <Button
            size="large"
            icon={<PlayCircle size={16} />}
            disabled={!isVerifiable || operating}
            loading={operating}
            onClick={() =>
              onAction('verify', undefined, {
                confirm: '确认触发全部域名的验证？',
              })
            }
          >
            {isVerifiable ? '验证全部' : '耐心等待'}
          </Button>
          <Button
            size="large"
            icon={<RotateCcw size={16} />}
            disabled={!isVerifiable || operating}
            loading={operating}
            onClick={() =>
              onAction('reload', undefined, {
                confirm: '确认重新生成验证信息？原有的 DNS 记录将失效',
              })
            }
          >
            重新生成
          </Button>
          <Button
            size="large"
            icon={<Pencil size={16} />}
            disabled={!isVerifiable || operating}
            loading={operating}
            onClick={() =>
              onAction('modify', undefined, {
                confirm: '确认修改申请？当前订单将被删除',
                danger: true,
              })
            }
          >
            修改申请
          </Button>
          <Button
            danger
            size="large"
            icon={<XCircle size={16} />}
            loading={operating}
            disabled={operating}
            onClick={() =>
              onAction('cancel', undefined, {
                confirm: '确认撤销此订单？此操作不可恢复',
                danger: true,
              })
            }
          >
            撤销申请
          </Button>
        </>
      )}

      {isSigned && (
        <>
          <Button
            type="primary"
            size="large"
            icon={<Download size={16} />}
            disabled={!hasCert}
            loading={operating}
            onClick={() =>
              onAction('ca_get', undefined, {
                filename: `${order.uuid}.crt`,
              })
            }
          >
            下载证书
          </Button>
          <Button
            size="large"
            icon={<Key size={16} />}
            disabled={!hasKey || operating}
            loading={operating}
            onClick={() =>
              onAction('ca_key', undefined, {
                filename: `${order.uuid}.pem`,
              })
            }
          >
            下载密钥
          </Button>
          <Button
            size="large"
            icon={<Archive size={16} />}
            disabled={!hasKey || operating}
            onClick={() => handleDownloadZip(order.uuid, message)}
          >
            下载 ZIP
          </Button>
          <Button
            size="large"
            icon={<FileLock2 size={16} />}
            disabled={!hasKey || operating}
            onClick={() => handleDownloadPfx(order.uuid, message)}
          >
            下载 PFX
          </Button>
          <Button
            size="large"
            icon={<RotateCcw size={16} />}
            loading={operating}
            disabled={operating}
            onClick={() =>
              onAction('re_new', undefined, {
                confirm: '确认续期此证书？将重新发起签发流程',
              })
            }
          >
            续期证书
          </Button>
          <Button
            size="large"
            icon={<Trash2 size={16} />}
            disabled={!hasKey || operating}
            loading={operating}
            onClick={() =>
              onAction('rm_key', undefined, {
                confirm: '确认清空本地私钥？清空后无法使用私钥吊销或续期证书，此操作不可恢复',
                danger: true,
                requireConfirmId: order.uuid,
              })
            }
          >
            清空私钥
          </Button>
          <Button
            size="large"
            icon={<ShieldOff size={16} />}
            disabled={!hasKey || operating}
            loading={operating}
            onClick={() =>
              onAction('ca_del', undefined, {
                confirm: '确认吊销此证书？吊销后证书将被 CA 标记为无效，使用该证书的服务都将无法正常工作',
                danger: true,
                requireConfirmId: order.uuid,
                pickRevokeReason: true,
              })
            }
          >
            吊销证书
          </Button>
          <Button
            danger
            size="large"
            icon={<XCircle size={16} />}
            loading={operating}
            disabled={operating}
            onClick={() =>
              onAction('cancel', undefined, {
                confirm: '确认删除此订单？所有相关信息将丢失',
                danger: true,
                requireConfirmId: order.uuid,
              })
            }
          >
            删除订单
          </Button>
        </>
      )}

      {isFailed && (
        <>
          <Button
            type="primary"
            size="large"
            icon={<RotateCcw size={16} />}
            loading={operating}
            disabled={operating}
            onClick={() =>
              onAction('re_new', undefined, {
                confirm: '确认重试此订单？将从创建订单开始重新走一遍签发流程',
              })
            }
          >
            重试申请
          </Button>
          <Button
            danger
            size="large"
            icon={<XCircle size={16} />}
            loading={operating}
            disabled={operating}
            onClick={() =>
              onAction('cancel', undefined, {
                confirm: '确认删除此订单？所有相关信息将丢失',
                danger: true,
                requireConfirmId: order.uuid,
              })
            }
          >
            删除订单
          </Button>
        </>
      )}
    </div>
  );
}
