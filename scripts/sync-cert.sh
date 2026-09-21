#!/bin/sh
# =============================================================================
# sync-cert.sh —— 从 CertHub 拉取证书并写入 dpanel
# -----------------------------------------------------------------------------
# 用途：多台服务器共用同一张证书，由各服务器自行拉取，无需开放 SSH 入站。
#
# 部署方式（二选一）：
#   A. dpanel「容器管理 → 计划任务 → 添加」：
#        - 触发类型：周期 → 每天
#        - 执行容器：留空（即在 dpanel 容器内执行）
#        - 执行脚本：粘贴本文件内容
#        - 路径使用容器内路径：/dpanel/acme/<域名>_ecc
#   B. 宿主机 crontab：DIR 改为 docker run -v 映射出的宿主机目录
#
# 行为约定：
#   1. 仅在内容变化时替换并 reload，避免无意义的 nginx 重启；
#   2. 替换前校验证书与私钥的公钥指纹是否一致；
#   3. 先写临时文件再 mv，保证替换原子性；
#   4. 拉取失败时保留现有证书。
# =============================================================================

set -eu

# ---------------------------- 配置区 -----------------------------------------
SITE="https://your-certhub.example.com"   # CertHub 站点地址
UUID="xxxxxxxxxxxxxxxx"                    # 订单 UUID（订单详情页 URL 中）
MAIL="you@example.com"                     # 登录邮箱
TOKEN="your-api-token"                     # 账户 → API 页生成的 Token
DOMAIN="example.com"                       # 证书主域名（用于定位目录与文件名）

# 证书目录：
#   - dpanel 容器内执行（计划任务留空执行容器）→ /dpanel/acme/${DOMAIN}_ecc
#   - 宿主机执行 → docker run -v 映射出的宿主机目录
DIR="/dpanel/acme/${DOMAIN}_ecc"

# 重载命令：dpanel 容器内执行时为 `nginx -s reload`；
# 宿主机执行时改为 `docker exec dpanel nginx -s reload`
RELOAD="nginx -s reload"
# -----------------------------------------------------------------------------

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NEW_CRT="$TMP/fullchain.pem"
NEW_KEY="$TMP/privkey.pem"

# 1) 拉取证书。优先使用 ZIP 接口；unzip 在 Alpine 镜像中属于 busybox applet，
#    不保证存在，失败时回退到 PEM(JSON) 接口，该路径仅依赖 sed。
fetch_ok=0

if curl -fsS --max-time 30 \
      "$SITE/api/v1/orders/$UUID/zip" \
      -H "X-API-Mail: $MAIL" \
      -H "X-API-Token: $TOKEN" \
      -o "$TMP/cert.zip" 2>/dev/null; then
    if command -v unzip >/dev/null 2>&1 && unzip -oq "$TMP/cert.zip" -d "$TMP/zip" 2>/dev/null; then
        NEW_CRT="$TMP/zip/fullchain.pem"
        NEW_KEY="$TMP/zip/privkey.pem"
        fetch_ok=1
    else
        log "未找到 unzip，改用 PEM 接口"
    fi
fi

if [ "$fetch_ok" -eq 0 ]; then
    if ! curl -fsS --max-time 30 \
          "$SITE/api/v1/orders/$UUID/pem" \
          -H "X-API-Mail: $MAIL" \
          -H "X-API-Token: $TOKEN" \
          -o "$TMP/cert.json"; then
        log "拉取失败（网络或凭据问题），保留现有证书"
        exit 1
    fi
    # PEM 值仅含 \n 转义，不含未转义引号，sed 提取可靠
    sed -n 's/.*"fullchain":"\([^"]*\)".*/\1/p' "$TMP/cert.json" | sed 's/\\n/\n/g' > "$NEW_CRT"
    sed -n 's/.*"privkey":"\([^"]*\)".*/\1/p'   "$TMP/cert.json" | sed 's/\\n/\n/g' > "$NEW_KEY"
fi

if [ ! -s "$NEW_CRT" ] || [ ! -s "$NEW_KEY" ]; then
    log "证书内容不完整，保留现有证书"
    exit 1
fi

# 2) 校验证书与私钥是否配对（比对公钥指纹）。
#    续期过程中后端可能短暂存在不匹配的组合，此处拦截。
CRT_PUB="$(openssl x509 -in "$NEW_CRT" -noout -pubkey 2>/dev/null | openssl sha256 2>/dev/null || true)"
KEY_PUB="$(openssl pkey -in "$NEW_KEY" -pubout 2>/dev/null | openssl sha256 2>/dev/null || true)"
if [ -z "$CRT_PUB" ] || [ -z "$KEY_PUB" ]; then
    log "无法计算公钥指纹（openssl 不可用），跳过本次更新"
    exit 1
fi
if [ "$CRT_PUB" != "$KEY_PUB" ]; then
    log "证书与私钥不匹配（可能正在续期中），本次跳过"
    exit 1
fi

# 3) 内容无变化则直接结束
if [ -f "$DIR/fullchain.cer" ] && cmp -s "$NEW_CRT" "$DIR/fullchain.cer"; then
    log "证书无变化"
    exit 0
fi

# 4) 目录不存在时创建（正常情况下 dpanel 导入过一次即已存在）
mkdir -p "$DIR"

# 5) 原子替换：先写 .new 再 mv，避免 nginx 读到不完整文件
cp "$NEW_CRT" "$DIR/fullchain.cer.new"
cp "$NEW_KEY" "$DIR/$DOMAIN.key.new"
chmod 644 "$DIR/fullchain.cer.new"
chmod 600 "$DIR/$DOMAIN.key.new"
mv "$DIR/fullchain.cer.new" "$DIR/fullchain.cer"
mv "$DIR/$DOMAIN.key.new"   "$DIR/$DOMAIN.key"

# 6) 重载 nginx
if sh -c "$RELOAD"; then
    log "证书已更新并重载 nginx"
else
    log "证书已更新，但重载失败，请检查 nginx 配置"
    exit 1
fi

# 7) 同步 dpanel 的 .conf 到期时间，避免 acme.sh 误判该证书需要续签。
#    该文件由 dpanel 维护；不存在时跳过。
CONF="$DIR/$DOMAIN.conf"
if [ -f "$CONF" ]; then
    NOT_AFTER="$(openssl x509 -in "$NEW_CRT" -noout -enddate 2>/dev/null | cut -d= -f2)"
    if [ -n "$NOT_AFTER" ]; then
        NEXT_TS="$(date -d "$NOT_AFTER" +%s 2>/dev/null || true)"
        if [ -n "$NEXT_TS" ]; then
            # BSD 与 GNU date 的差异由 || true 兜住
            sed -i "s|^Le_NextRenewTime=.*|Le_NextRenewTime='$NEXT_TS'|" "$CONF" 2>/dev/null || true
            log "已同步 .conf 到期时间"
        fi
    fi
fi

exit 0
