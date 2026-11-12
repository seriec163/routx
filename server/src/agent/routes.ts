import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { sha256Hex, randomToken } from '../lib/crypto.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { loadSettings } from '../settings.js';
import {
  authenticateAgent,
  claimCommand,
  collectCommandResult,
  expireCommands,
  touchRouterSeen,
  updateRouterFromProbe,
  waitForAgentWake,
  type AgentAuthContext,
} from './service.js';
import { sanitizeAgentState } from '../domain/uci.js';
import { createMobileLink } from '../mobile/service.js';
import { notifyRouterOwner } from '../notifications.js';

export interface AgentRouteContext {
  pool: Pool;
  requireSignature: boolean;
  pollHoldSeconds: number;
  publicUrl: string;
}

const probeSchema = z
  .object({
    agent_version: z.string().max(40).optional(),
    product: z.enum(['forkop', 'prokop', 'podkop', 'tachyon', 'unknown', 'conflict']).optional(),
    product_version: z.string().max(60).nullable().optional(),
    conflict: z.boolean().optional(),
    manifest_version: z.coerce.number().int().nonnegative().nullable().optional(),
    openwrt: z.string().max(60).nullable().optional(),
    arch: z.string().max(60).nullable().optional(),
    model: z.string().max(120).nullable().optional(),
    sing_box_version: z.string().max(60).nullable().optional(),
    sing_box_variant: z.string().max(40).nullable().optional(),
    platform_state: z.enum(['ok', 'unsupported', 'conflict']).optional(),
    installed_products: z
      .array(
        z.object({
          product: z.enum(['forkop', 'prokop', 'podkop', 'tachyon']),
          version: z.string().max(60).nullable().optional(),
          packages: z.array(z.string().max(80)).max(20).optional(),
        }),
      )
      .max(10)
      .optional(),
    last_error: z.string().max(500).nullable().optional(),
    health: z.record(z.string(), z.unknown()).optional(),
    service: z.record(z.string(), z.unknown()).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    managed: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const bindSchema = z
  .object({
    token: z.string().min(20).max(64),
    product: z.enum(['forkop', 'prokop', 'podkop', 'tachyon', 'unknown', 'conflict']).optional(),
    agent_version: z.string().max(40).optional(),
    hardware: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const resultSchema = z
  .object({
    status: z.enum(['success', 'failed', 'cancelled', 'timeout']),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.string().max(80).optional(), message: z.string().max(1000).optional() })
      .nullable()
      .optional(),
  })
  .strict();

const reportSchema = z
  .object({
    kind: z.enum(['quick', 'full']),
    product: z.string().max(40),
    agent_version: z.string().max(40).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    body: z.string().min(1).max(4 * 1024 * 1024),
    job_id: z.string().uuid().optional(),
  })
  .strict();

function agentContext(request: FastifyRequest): AgentAuthContext {
  if (!request.agent) throw unauthorized('Агент не аутентифицирован');
  return {
    routerId: request.agent.routerId,
    ownerId: request.agent.ownerId,
    product: request.agent.product,
    status: request.agent.status,
    agentVersion: request.agent.agentVersion,
    token: '',
  };
}

const INSTALL_SCRIPT = `#!/bin/sh
# RoutX agent installer.
# Usage: sh install.sh --server URL --token BINDING_TOKEN [--product prokop|forkop|podkop|tachyon] [--keep prokop|forkop|podkop|tachyon] [--sing-box tiny|stable|extended] [--reboot]
set -eu

SERVER=""
TOKEN=""
PRODUCT=""
KEEP=""
SINGBOX=""
PRODUCT_ARG=""
REBOOT="0"
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --product) PRODUCT_ARG="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --sing-box) SINGBOX="$2"; shift 2 ;;
    --reboot) REBOOT="1"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$SERVER" ] || { echo "--server is required" >&2; exit 2; }
[ -n "$TOKEN" ] || { echo "--token is required" >&2; exit 2; }
case "$PRODUCT_ARG" in
  ""|prokop|forkop|podkop|tachyon) ;;
  *) echo "--product must be prokop, forkop, podkop or tachyon" >&2; exit 2 ;;
esac
case "$KEEP" in
  ""|prokop|forkop|podkop|tachyon) ;;
  *) echo "--keep must be prokop, forkop, podkop or tachyon" >&2; exit 2 ;;
esac
case "$SINGBOX" in
  ""|tiny|stable|extended) ;;
  *) echo "--sing-box must be tiny, stable or extended" >&2; exit 2 ;;
esac

has_prokop() {
  [ -x /usr/bin/prokop ] && return 0
  [ -x /etc/init.d/prokop ] && return 0
  if command -v opkg >/dev/null 2>&1; then
    opkg list-installed 2>/dev/null | grep -q '^prokop ' && return 0
  elif command -v apk >/dev/null 2>&1; then
    apk info -e prokop >/dev/null 2>&1 && return 0
  fi
  return 1
}
has_forkop() {
  [ -x /usr/bin/forkop ] && return 0
  [ -x /etc/init.d/forkop ] && return 0
  if command -v opkg >/dev/null 2>&1; then
    opkg list-installed 2>/dev/null | grep -q '^forkop ' && return 0
  elif command -v apk >/dev/null 2>&1; then
    apk info -e forkop >/dev/null 2>&1 && return 0
  fi
  return 1
}

has_tachyon() {
  [ -x /usr/bin/tachyon ] && return 0
  [ -x /etc/init.d/tachyon ] && return 0
  if command -v opkg >/dev/null 2>&1; then
    opkg list-installed 2>/dev/null | grep -q '^tachyon ' && return 0
  elif command -v apk >/dev/null 2>&1; then
    apk info -e tachyon >/dev/null 2>&1 && return 0
  fi
  return 1
}

pkg_has() {
  if command -v opkg >/dev/null 2>&1; then
    opkg list-installed 2>/dev/null | grep -q "^$1 "
  elif command -v apk >/dev/null 2>&1; then
    apk info -e "$1" >/dev/null 2>&1
  else
    return 1
  fi
}
pkg_mgr_for() {
  if command -v opkg >/dev/null 2>&1 && opkg list-installed 2>/dev/null | grep -q "^$1 "; then
    echo "opkg"
    return 0
  fi
  if command -v apk >/dev/null 2>&1 && apk info -e "$1" >/dev/null 2>&1; then
    echo "apk"
    return 0
  fi
  echo ""
}

force_remove_opkg_status() {
  force_pkg="$1"
  force_status=""
  for force_file in /usr/lib/opkg/status /var/lib/opkg/status; do
    if [ -f "$force_file" ]; then
      force_status="$force_file"
      break
    fi
  done
  [ -n "$force_status" ] || return 1
  force_tmp="$force_status.routx.$$"
  awk -v pkg="$force_pkg" '
    /^Package: / { skip = ($2 == pkg) }
    skip { next }
    { print }
  ' "$force_status" > "$force_tmp" || { rm -f "$force_tmp"; return 1; }
  mv "$force_tmp" "$force_status"
  rm -f /usr/lib/opkg/info/"$force_pkg".* /var/lib/opkg/info/"$force_pkg".* 2>/dev/null || true
  return 0
}

force_remove_apk_package() {
  force_pkg="$1"
  if [ -f /etc/apk/world ]; then
    sed -i "/^$force_pkg\([@=].*\)\{0,1\}$/d" /etc/apk/world 2>/dev/null || true
  fi
  if [ -f /lib/apk/db/installed ]; then
    force_tmp="/lib/apk/db/installed.routx.$$"
    awk -v pkg="$force_pkg" 'BEGIN { RS=""; ORS="\n\n" } $0 !~ ("(^|\n)P:" pkg "(\n|$)") { print }' \
      /lib/apk/db/installed > "$force_tmp" || { rm -f "$force_tmp"; return 1; }
    mv "$force_tmp" /lib/apk/db/installed
  fi
  rm -rf /lib/apk/db/scripts/"$force_pkg".* 2>/dev/null || true
  return 0
}

pkg_del() {
  delete_pkg_mgr="$(pkg_mgr_for "$1")"
  if [ "$delete_pkg_mgr" = "opkg" ]; then
    # Ждём, если другой установщик держит lock.
    if [ -f /var/lock/opkg.lock ]; then
      lock_wait=0
      while [ -f /var/lock/opkg.lock ] && [ "$lock_wait" -lt 30 ]; do
        sleep 1
        lock_wait=$((lock_wait + 1))
      done
    fi
    # Скрипты пакета могут падать и отменять удаление. На время удаления
    # отключаем их: сервис уже остановлен, файлы и конфиг удалим сами.
    for delete_script in /usr/lib/opkg/info/"$1".preinst /usr/lib/opkg/info/"$1".prerm \
      /usr/lib/opkg/info/"$1".postinst /usr/lib/opkg/info/"$1".postrm \
      /var/lib/opkg/info/"$1".preinst /var/lib/opkg/info/"$1".prerm \
      /var/lib/opkg/info/"$1".postinst /var/lib/opkg/info/"$1".postrm; do
      [ -f "$delete_script" ] && mv "$delete_script" "$delete_script.routx-disabled" 2>/dev/null || true
    done
    delete_log="/tmp/routx-opkg-remove-$1.log"
    opkg remove --force-depends --force-removal-of-dependent-packages "$1" >"$delete_log" 2>&1 ||
      opkg remove --force-depends "$1" >>"$delete_log" 2>&1 || true
    if opkg list-installed 2>/dev/null | grep -q "^$1 "; then
      echo "opkg не смог удалить $1; принудительно убираю запись пакета." >&2
      tail -n 5 "$delete_log" >&2 2>/dev/null || true
      force_remove_opkg_status "$1" || true
    fi
    rm -f /usr/lib/opkg/info/"$1".*.routx-disabled /var/lib/opkg/info/"$1".*.routx-disabled 2>/dev/null || true
  elif [ "$delete_pkg_mgr" = "apk" ]; then
    apk del "$1" >/dev/null 2>&1 ||
      apk del --force-broken-world "$1" >/dev/null 2>&1 || true
    if apk info -e "$1" >/dev/null 2>&1; then
      echo "apk не смог удалить $1; принудительно убираю запись пакета." >&2
      force_remove_apk_package "$1" || true
    fi
  fi
}

product_label() {
  case "$1" in
    prokop) echo "Prokop" ;;
    forkop) echo "Forkop" ;;
    podkop) echo "Podkop" ;;
    tachyon) echo "Tachyon" ;;
  esac
}

product_packages() {
  case "$1" in
    prokop) echo "luci-i18n-prokop-ru luci-app-prokop prokop" ;;
    forkop) echo "luci-i18n-forkop-ru luci-app-forkop forkop sing-box-forkop" ;;
    podkop) echo "luci-app-podkop podkop" ;;
    tachyon) echo "luci-i18n-tachyon-ru luci-app-tachyon tachyon tachyon-core" ;;
  esac
}

product_version() {
  case "$1" in
    prokop|forkop|podkop|tachyon)
      if command -v "$1" >/dev/null 2>&1; then
        "$1" show_version 2>/dev/null | head -n 1
      fi
      ;;
  esac
}

remove_product() {
  remove_name="$1"
  echo "Удаляю $(product_label "$remove_name") со всеми остатками..." >&2

  for remove_svc in "$remove_name" "$remove_name-killswitch" "$remove_name-torrserver-direct"; do
    if [ -x "/etc/init.d/$remove_svc" ]; then
      "/etc/init.d/$remove_svc" stop >/dev/null 2>&1 || true
      "/etc/init.d/$remove_svc" disable >/dev/null 2>&1 || true
    fi
  done

  for remove_pkg in $(product_packages "$remove_name"); do
    pkg_del "$remove_pkg"
  done

  # Удаляем nft-таблицы, в имени которых есть продукт.
  if command -v nft >/dev/null 2>&1; then
    nft list tables 2>/dev/null | grep -i "$remove_name" | while read -r _ remove_family remove_table; do
      if [ -n "$remove_family" ] && [ -n "$remove_table" ]; then
        nft delete table "$remove_family" "$remove_table" >/dev/null 2>&1 || true
      fi
    done
  fi

  # Конфиги, состояние, библиотеки и файлы LuCI.
  case "$remove_name" in
    tachyon)
      rm -rf /etc/tachyon /etc/tachyon-core /etc/config/tachyon-core \
        /usr/share/tachyon-core /usr/lib/tachyon /usr/lib/tachyon-core \
        /www/luci-static/resources/view/tachyon 2>/dev/null || true
      ;;
    forkop)
      rm -rf /etc/forkop /etc/forkop-backups /usr/share/forkop /usr/lib/forkop \
        /www/luci-static/resources/view/forkop 2>/dev/null || true
      ;;
    prokop)
      rm -rf /etc/prokop /etc/prokop-backups /etc/prokop-forkop-migration \
        /usr/share/prokop /usr/lib/prokop /www/luci-static/resources/view/prokop 2>/dev/null || true
      ;;
    podkop)
      rm -rf /etc/podkop /usr/share/podkop /usr/lib/podkop \
        /www/luci-static/resources/view/podkop 2>/dev/null || true
      ;;
  esac
  rm -rf "/etc/config/$remove_name" "/etc/config/$remove_name-opkg" 2>/dev/null || true
  rm -rf "/etc/config/$remove_name".routx-removed-* 2>/dev/null || true
  rm -f "/usr/bin/$remove_name" "/etc/init.d/$remove_name" 2>/dev/null || true
  rm -f "/usr/share/luci/menu.d/luci-app-$remove_name.json" \
    "/usr/share/rpcd/acl.d/luci-app-$remove_name.json" 2>/dev/null || true
  rm -f /etc/uci-defaults/*"$remove_name"* 2>/dev/null || true
  rm -f /usr/lib/lua/luci/i18n/"$remove_name".* 2>/dev/null || true
  rm -f /etc/rc.d/*"$remove_name"* 2>/dev/null || true
  if [ -f /etc/crontabs/root ]; then
    sed -i "/$remove_name/d" /etc/crontabs/root 2>/dev/null || true
  fi
  if [ -f /etc/iproute2/rt_tables ]; then
    sed -i "/[[:space:]]$remove_name$/d" /etc/iproute2/rt_tables 2>/dev/null || true
  fi
  REMOVED="$REMOVED $remove_name"
}

remove_generic_sing_box() {
  echo "Удаляю общий sing-box, оставшийся от других продуктов..." >&2
  for remove_pkg in sing-box sing-box-tiny sing-box-extended; do
    pkg_del "$remove_pkg"
  done
  if [ -x /etc/init.d/sing-box ]; then
    /etc/init.d/sing-box stop >/dev/null 2>&1 || true
    /etc/init.d/sing-box disable >/dev/null 2>&1 || true
  fi
  rm -rf /etc/sing-box /etc/config/sing-box /usr/share/sing-box /usr/lib/sing-box \
    /etc/init.d/sing-box 2>/dev/null || true
}

has_podkop() {
  # /etc/config/podkop появляется до готовности пакета, поэтому его одного мало.
  [ -x /usr/bin/podkop ] && return 0
  [ -x /etc/init.d/podkop ] && return 0
  if command -v opkg >/dev/null 2>&1; then
    opkg list-installed 2>/dev/null | grep -q '^podkop ' && return 0
  elif command -v apk >/dev/null 2>&1; then
    apk info -e podkop >/dev/null 2>&1 && return 0
  fi
  return 1
}

HAS_PROKOP=0
HAS_FORKOP=0
HAS_PODKOP=0
HAS_TACHYON=0
has_prokop && HAS_PROKOP=1
has_forkop && HAS_FORKOP=1
has_podkop && HAS_PODKOP=1
has_tachyon && HAS_TACHYON=1
FOUND=$((HAS_PROKOP + HAS_FORKOP + HAS_PODKOP + HAS_TACHYON))
FOUND_KEYS=""
for found_name in prokop forkop podkop tachyon; do
  case "$found_name" in
    prokop) [ "$HAS_PROKOP" -eq 1 ] && FOUND_KEYS="$FOUND_KEYS $found_name" ;;
    forkop) [ "$HAS_FORKOP" -eq 1 ] && FOUND_KEYS="$FOUND_KEYS $found_name" ;;
    podkop) [ "$HAS_PODKOP" -eq 1 ] && FOUND_KEYS="$FOUND_KEYS $found_name" ;;
    tachyon) [ "$HAS_TACHYON" -eq 1 ] && FOUND_KEYS="$FOUND_KEYS $found_name" ;;
  esac
done

if [ "$FOUND" -gt 1 ]; then
  echo "На роутере найдено несколько продуктов:" >&2
  found_index=0
  for found_name in $FOUND_KEYS; do
    found_index=$((found_index + 1))
    echo "  $found_index) $(product_label "$found_name") $(product_version "$found_name")" >&2
    echo "     пакеты: $(product_packages "$found_name")" >&2
  done
  if [ -z "$KEEP" ] && [ -n "$PRODUCT_ARG" ]; then
    case " $FOUND_KEYS " in
      *" $PRODUCT_ARG "*) KEEP="$PRODUCT_ARG" ;;
    esac
  fi
  if [ -z "$KEEP" ]; then
    if ! ( : </dev/tty ) 2>/dev/null; then
      echo "Укажите, какой продукт оставить активным: --keep prokop|forkop|podkop|tachyon" >&2
      exit 2
    fi
    printf 'Какой продукт оставить активным? [1]: ' >/dev/tty
    read -r keep_choice </dev/tty || keep_choice=""
    [ -n "$keep_choice" ] || keep_choice="1"
    found_index=0
    for found_name in $FOUND_KEYS; do
      found_index=$((found_index + 1))
      [ "$found_index" = "$keep_choice" ] && KEEP="$found_name"
    done
  fi
  case " $FOUND_KEYS " in
    *" $KEEP "*) ;;
    *) echo "Продукт '$KEEP' не найден среди установленных." >&2; exit 2 ;;
  esac
  REMOVED=""
  for found_name in $FOUND_KEYS; do
    [ "$found_name" = "$KEEP" ] && continue
    remove_product "$found_name"
  done
  if [ "$KEEP" = "tachyon" ]; then
    remove_generic_sing_box
  fi
  PRODUCT="$KEEP"
  REMAIN=0
  REMAIN_NAMES=""
  has_prokop && { REMAIN=$((REMAIN + 1)); REMAIN_NAMES="$REMAIN_NAMES prokop"; }
  has_forkop && { REMAIN=$((REMAIN + 1)); REMAIN_NAMES="$REMAIN_NAMES forkop"; }
  has_podkop && { REMAIN=$((REMAIN + 1)); REMAIN_NAMES="$REMAIN_NAMES podkop"; }
  has_tachyon && { REMAIN=$((REMAIN + 1)); REMAIN_NAMES="$REMAIN_NAMES tachyon"; }
  if [ "$REMAIN" -gt 1 ]; then
    echo "Не удалось удалить лишние продукты:$REMAIN_NAMES. Устраните конфликт вручную." >&2
    echo "Проверьте: opkg list-installed | grep -E 'forkop|prokop|podkop|tachyon' и /var/log/opkg.log" >&2
    exit 1
  fi
  echo "Оставлен активным: $(product_label "$PRODUCT") $PRODUCT." >&2
  echo "Удалено:$REMOVED" >&2
  if [ -x "/etc/init.d/$PRODUCT" ]; then
    "/etc/init.d/$PRODUCT" start >/dev/null 2>&1 || true
  fi
elif [ "$FOUND" -eq 1 ]; then
  for found_name in $FOUND_KEYS; do
    PRODUCT="$found_name"
    break
  done
  if [ -n "$KEEP" ] && [ "$KEEP" != "$PRODUCT" ]; then
    echo "На роутере уже установлен $PRODUCT, а запрошен $KEEP. Один роутер — один продукт." >&2
    exit 1
  fi
  if [ -n "$PRODUCT_ARG" ] && [ "$PRODUCT_ARG" != "$PRODUCT" ]; then
    echo "На роутере уже установлен $PRODUCT, а запрошен $PRODUCT_ARG. Один роутер — один продукт." >&2
    echo "Чтобы заменить продукт, удалите старый или используйте панель RoutX." >&2
    exit 1
  fi
fi
if [ -z "$PRODUCT" ] && [ -n "$PRODUCT_ARG" ]; then
  PRODUCT="$PRODUCT_ARG"
fi
if [ -z "$PRODUCT" ]; then
  # /dev/tty может существовать как файл, но не открываться без терминала.
  if ! ( : </dev/tty ) 2>/dev/null; then
    echo "Prokop/Forkop/Podkop/Tachyon не найден. Запустите установщик в терминале SSH или укажите --product prokop|forkop|podkop|tachyon." >&2
    exit 2
  fi
  printf '\\nProkop, Forkop, Podkop или Tachyon не найден. Что установить вместе с агентом?\\n' >/dev/tty
  printf '  1) Prokop (рекомендуется)\\n' >/dev/tty
  printf '  2) Forkop\\n' >/dev/tty
  printf '  3) Podkop\\n' >/dev/tty
  printf '  4) Tachyon (tachyon-core)\\n' >/dev/tty
  printf 'Выбор [1]: ' >/dev/tty
  read -r choice </dev/tty || choice=""
  [ -n "$choice" ] || choice="1"
  case "$choice" in
    1) PRODUCT="prokop" ;;
    2) PRODUCT="forkop" ;;
    3) PRODUCT="podkop" ;;
    4) PRODUCT="tachyon" ;;
    *) echo "Некорректный выбор" >&2; exit 2 ;;
  esac
fi
[ -n "$PRODUCT" ] || { echo "Не удалось определить продукт" >&2; exit 2; }

command -v ucode >/dev/null 2>&1 || { echo "ucode is required (OpenWrt 24.10+)" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"

# Зависимости, которых может не быть в минимальной прошивке.
# Проверяем реальную загрузку модулей ucode, а не только имена пакетов:
# так установщик не поставит пакет, который потом не запустится.
if command -v ucode >/dev/null 2>&1; then
  MISSING=""
  ucode -e 'require("digest")' >/dev/null 2>&1 || MISSING="$MISSING ucode-mod-digest"
  ucode -e 'require("fs")' >/dev/null 2>&1 || MISSING="$MISSING ucode-mod-fs"
  ucode -e 'require("uci")' >/dev/null 2>&1 || MISSING="$MISSING ucode-mod-uci"
  if [ -n "$MISSING" ]; then
    echo "Не хватает модулей ucode:$MISSING — устанавливаю..." >&2
    if command -v opkg >/dev/null 2>&1; then
      opkg update >/dev/null 2>&1 || echo "opkg update не удался; проверьте feed-и" >&2
      opkg install $MISSING || true
    elif command -v apk >/dev/null 2>&1; then
      apk update >/dev/null 2>&1 || true
      apk add $MISSING || true
    fi
  fi
  if ! ucode -e 'require("digest")' >/dev/null 2>&1; then
    echo "Ошибка: ucode-mod-digest не установлен." >&2
    echo "Выполните: opkg update && opkg install ucode-mod-digest" >&2
    echo "Без модуля digest агент не сможет подписывать запросы и привязаться." >&2
    exit 1
  fi
fi

# Переход с прежнего имени JanusNew: сохраняем конфиг и снимаем старый пакет.
if [ -f /etc/config/janusnew ] && [ ! -f /etc/config/routx ]; then
  cp -p /etc/config/janusnew /etc/config/routx || true
fi
if command -v opkg >/dev/null 2>&1; then
  opkg remove janusnew --force-depends >/dev/null 2>&1 || true
elif command -v apk >/dev/null 2>&1; then
  apk del janusnew >/dev/null 2>&1 || true
fi

if command -v wget >/dev/null 2>&1; then
  wget -q "$SERVER/agent/routx-agent.sha256" -O routx-agent.sha256
  wget -q "$SERVER/agent/routx-agent.ipk" -O routx-agent.ipk || true
  wget -q "$SERVER/agent/routx-agent.apk" -O routx-agent.apk || true
  wget -q "$SERVER/agent/routx-agent.tar.gz" -O routx-agent.tar.gz || true
else
  curl -fsS "$SERVER/agent/routx-agent.sha256" -o routx-agent.sha256
  curl -fsS "$SERVER/agent/routx-agent.ipk" -o routx-agent.ipk 2>/dev/null || true
  curl -fsS "$SERVER/agent/routx-agent.apk" -o routx-agent.apk 2>/dev/null || true
  curl -fsS "$SERVER/agent/routx-agent.tar.gz" -o routx-agent.tar.gz 2>/dev/null || true
fi

if command -v sha256sum >/dev/null 2>&1 && [ -f routx-agent.sha256 ]; then
  sha256sum -c routx-agent.sha256 2>/dev/null || true
fi

install_tar() {
  [ -f routx-agent.tar.gz ] || return 1
  # tar.gz не знает о conffiles: сохраняем привязку вручную.
  if [ -f /etc/config/routx ]; then
    cp -p /etc/config/routx "$TMP/routx-agent.config" || true
  fi
  tar -C / -xzf routx-agent.tar.gz || return 1
  if [ -f "$TMP/routx-agent.config" ]; then
    cp -p "$TMP/routx-agent.config" /etc/config/routx || true
  fi
  return 0
}

if command -v opkg >/dev/null 2>&1 && [ -f routx-agent.ipk ]; then
  # Зависимости уже проверены выше; --force-depends не даёт opkg отказаться
  # от пакета из-за отсутствующего в feed-ах имени (например, coreutils-timeout).
  opkg install --force-reinstall --force-depends ./routx-agent.ipk || {
    echo "ipk install failed, falling back to tar.gz" >&2
    install_tar || true
  }
elif command -v apk >/dev/null 2>&1 && [ -f routx-agent.apk ]; then
  apk add --upgrade --allow-untrusted --force-overwrite ./routx-agent.apk || {
    echo "apk install failed, falling back to tar.gz" >&2
    install_tar || true
  }
elif command -v apk >/dev/null 2>&1; then
  install_tar || true
else
  [ -f routx-agent.ipk ] && opkg install --force-reinstall ./routx-agent.ipk 2>/dev/null || true
  install_tar || true
fi

uci -q batch <<EOF
set routx.main.server='$SERVER'
set routx.main.bind_token='$TOKEN'
set routx.main.agent_token=''
set routx.main.router_id=''
set routx.main.enabled='1'
commit routx
EOF
chmod 600 /etc/config/routx 2>/dev/null || true

# Старый статус мог остаться от предыдущей привязки: иначе проверка ниже
# примет его за свежий и соврёт об успехе.
rm -f /var/run/routx-agent/status.json

[ -x /etc/init.d/routx-agent ] && /etc/init.d/routx-agent enable 2>/dev/null || true
[ -x /etc/init.d/routx-agent ] && /etc/init.d/routx-agent restart 2>/dev/null || /etc/init.d/routx-agent start 2>/dev/null || true

# Агент уже привязан. Теперь ставим продукт, только если его действительно нет.
# Повторная проверка защищает от гонки и от ложного «продукта нет».
if ! has_prokop && ! has_forkop && ! has_podkop && ! has_tachyon; then
  echo "Агент установлен и привязан. Устанавливаю $PRODUCT ..."
  case "$PRODUCT" in
    prokop)
      if [ -n "$SINGBOX" ]; then
        wget -qO- https://asofwar.github.io/prokop/install.sh | sh -s -- --lang ru --sing-box "$SINGBOX"
      else
        wget -qO- https://asofwar.github.io/prokop/install.sh | sh -s -- --lang ru
      fi
      ;;
    forkop)
      wget -qO- https://raw.githubusercontent.com/ushan0v/forkop/main/install.sh | sh -s
      ;;
    podkop)
      REL=$(. /etc/openwrt_release >/dev/null 2>&1; echo "$DISTRIB_RELEASE")
      MAJOR="\${REL%%.*}"
      MINOR="\${REL#*.}"
      MINOR="\${MINOR%%.*}"
      case "$MAJOR" in ''|*[!0-9]*) MAJOR=0 ;; esac
      case "$MINOR" in ''|*[!0-9]*) MINOR=0 ;; esac
      if [ "$MAJOR" -lt 24 ] || { [ "$MAJOR" -eq 24 ] && [ "$MINOR" -lt 10 ]; }; then
        echo "Podkop требует OpenWrt 24.10 или новее (обнаружено: \${REL:-неизвестно})." >&2
        exit 1
      fi
      AVAIL="$(df /overlay 2>/dev/null | awk 'NR==2 {print $4}')"
      case "$AVAIL" in ''|*[!0-9]*) AVAIL=0 ;; esac
      if [ "$AVAIL" -gt 0 ] && [ "$AVAIL" -lt 25600 ]; then
        echo "Недостаточно места для Podkop: свободно $((AVAIL/1024)) МБ, нужно минимум 25 МБ." >&2
        exit 1
      fi
      if pkg_has https-dns-proxy; then
        echo "Podkop несовместим с https-dns-proxy: удаляю конфликтующий пакет." >&2
        pkg_del https-dns-proxy
        pkg_del luci-app-https-dns-proxy
        pkg_del luci-i18n-https-dns-proxy-ru
      fi
      # Официальный установщик спрашивает только про русскую локализацию:
      # https-dns-proxy и старый конфиг обработаны выше. Отвечаем "n" —
      # интерфейс Podkop настраивается в LuCI, а не в RoutX.
      PODKOP_INSTALLER="$(wget -qO- https://raw.githubusercontent.com/itdoginfo/podkop/main/install.sh 2>/dev/null)" || true
      if [ -z "$PODKOP_INSTALLER" ]; then
        echo "Не удалось загрузить установщик Podkop." >&2
        exit 1
      fi
      echo n | sh -c "$PODKOP_INSTALLER" || true
      ;;
    tachyon)
      wget -O /tmp/tachyon-setup.sh https://raw.githubusercontent.com/Dushnilin/tachyon/main/install.sh && sh /tmp/tachyon-setup.sh -y --tachyon-core
      ;;
  esac

  HAS_AFTER=0
  has_prokop && HAS_AFTER=$((HAS_AFTER + 1))
  has_forkop && HAS_AFTER=$((HAS_AFTER + 1))
  has_podkop && HAS_AFTER=$((HAS_AFTER + 1))
  has_tachyon && HAS_AFTER=$((HAS_AFTER + 1))
  if [ "$HAS_AFTER" -gt 1 ]; then
    echo "После установки обнаружено несколько продуктов. Это конфликт: устраните его вручную. Агент не вносит изменений." >&2
    exit 1
  fi
  if [ "$HAS_AFTER" -eq 0 ]; then
    echo "Не удалось установить $PRODUCT. Агент остаётся привязанным; установите продукт вручную и перезапустите /etc/init.d/routx-agent." >&2
    exit 1
  fi
  [ -x /etc/init.d/routx-agent ] && /etc/init.d/routx-agent restart 2>/dev/null || true
else
  echo "Продукт уже установлен; шаг установки пропущен."
fi

rm -f /tmp/luci-indexcache* 2>/dev/null || true
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload 2>/dev/null || true

# Ждём первую привязку, чтобы команда не врала про успех.
i=0
while [ "$i" -lt 30 ]; do
  grep -q '"bound": true' /var/run/routx-agent/status.json 2>/dev/null && break
  sleep 1
  i=$((i + 1))
done
if grep -q '"bound": true' /var/run/routx-agent/status.json 2>/dev/null; then
  echo "RoutX установлен и привязан. Продукт: $PRODUCT. Сервер: $SERVER."
  if [ "$REBOOT" = "1" ]; then
    echo "Перезагружаю роутер через 5 секунд — это нужно, чтобы LuCI и продукт применили изменения." >&2
    sync
    sleep 5
    reboot
  else
    echo "Перезагрузите роутер, чтобы LuCI и продукт применили изменения: reboot"
  fi
else
  echo "RoutX установлен. Продукт: $PRODUCT. Привязка к $SERVER ещё выполняется; проверьте статус на странице Службы → RoutX." >&2
  echo "--- диагностика агента ---" >&2
  [ -x /usr/bin/routx-agent ] && /usr/bin/routx-agent status >&2 2>&1 || true
  if [ -f /var/run/routx-agent/status.json ]; then
    cat /var/run/routx-agent/status.json >&2
  else
    echo "status.json не создан: проверьте /etc/init.d/routx-agent status и logread -e routx-agent" >&2
  fi
  echo "После успешной привязки перезагрузите роутер: reboot" >&2
fi
echo "LuCI: Службы → RoutX. Если пункта меню не видно — закройте вкладку LuCI и откройте её заново (меню кэшируется браузером)."
`;

export async function registerAgentRoutes(
  app: FastifyInstance,
  ctx: AgentRouteContext,
): Promise<void> {
  const { pool } = ctx;

  app.get('/agent/install.sh', async (_request, reply) => {
    reply.type('text/x-shellscript; charset=utf-8');
    return INSTALL_SCRIPT;
  });

  const agentDist = (global as any).__RC_AGENT_DIST || process.env.RC_AGENT_DIST || null;
  app.get('/agent/routx-agent.ipk', async (_request, reply) => {
    if (agentDist) {
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const p = join(agentDist, 'routx-agent.ipk');
      if (existsSync(p)) {
        reply.type('application/octet-stream');
        reply.header('Content-Disposition', 'attachment; filename="routx-agent.ipk"');
        return readFileSync(p);
      }
    }
    reply.code(404);
    return { error: { code: 'not_bundled', message: 'Пакет не собран в этом образе' } };
  });

  app.get('/agent/routx-agent.apk', async (_request, reply) => {
    if (agentDist) {
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const p = join(agentDist, 'routx-agent.apk');
      if (existsSync(p)) {
        reply.type('application/octet-stream');
        reply.header('Content-Disposition', 'attachment; filename="routx-agent.apk"');
        return readFileSync(p);
      }
    }
    reply.code(404);
    return { error: { code: 'not_bundled', message: 'APK не собран в этом образе' } };
  });

  app.get('/agent/routx-agent.tar.gz', async (_request, reply) => {
    if (agentDist) {
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const p = join(agentDist, 'routx-agent.tar.gz');
      if (existsSync(p)) {
        reply.type('application/gzip');
        reply.header('Content-Disposition', 'attachment; filename="routx-agent.tar.gz"');
        return readFileSync(p);
      }
    }
    reply.code(404);
    return { error: { code: 'not_bundled', message: 'Архив не собран в этом образе' } };
  });

  app.get('/agent/routx-agent.version', async (_request, reply) => {
    if (agentDist) {
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const p = join(agentDist, 'routx-agent.version');
      if (existsSync(p)) {
        reply.type('text/plain; charset=utf-8');
        return readFileSync(p);
      }
    }
    reply.code(404);
    return { error: { code: 'not_bundled', message: 'Версия агента не собрана в этом образе' } };
  });

  app.get('/agent/routx-agent.sha256', async (_request, reply) => {
    if (agentDist) {
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const p = join(agentDist, 'routx-agent.sha256');
      if (existsSync(p)) {
        reply.type('text/plain; charset=utf-8');
        return readFileSync(p);
      }
    }
    reply.code(404);
    return { error: { code: 'not_bundled', message: 'Сумма не собрана в этом образе' } };
  });

  app.post(
    '/agent/v1/bind',
    { config: { public: true, skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const body = bindSchema.parse(request.body);

      const client = await pool.connect();
      try {
        await client.query('begin');
        const found = await client.query<{
          id: string;
          router_id: string | null;
          product_hint: string;
          expires_at: Date;
          used_at: Date | null;
          created_by: string;
        }>(
          `select id, router_id, product_hint, expires_at, used_at, created_by
             from binding_tokens where token_hash = $1 for update`,
          [sha256Hex(body.token)],
        );
        const token = found.rows[0];
        if (!token || token.used_at || token.expires_at.getTime() <= Date.now()) {
          throw badRequest('invalid_binding_token', 'Токен привязки недействителен или истёк');
        }
        if (!token.router_id) throw badRequest('invalid_binding_token', 'Токен не связан с роутером');
        if (
          token.product_hint !== 'any' &&
          body.product &&
          body.product !== 'unknown' &&
          body.product !== token.product_hint
        ) {
          throw badRequest('product_mismatch', 'Продукт на роутере не совпадает с ожидаемым');
        }

        const router = await client.query<{ id: string; archived_at: Date | null; status: string }>(
          'select id, archived_at, status from routers where id = $1 for update',
          [token.router_id],
        );
        const target = router.rows[0];
        if (!target) throw notFound('Роутер не найден');
        if (target.archived_at) throw forbidden('Роутер архивирован');

        const agentToken = randomToken(32);
        const prefix = agentToken.slice(0, 8);

        await client.query(
          `insert into router_credentials
             (router_id, token_hash, token_prefix, rotated_at, previous_token_hash, previous_expires_at)
           values ($1,$2,$3, now(), null, null)
           on conflict (router_id) do update
             set previous_token_hash = router_credentials.token_hash,
                 previous_expires_at = now() + interval '600 seconds',
                 token_hash = excluded.token_hash,
                 token_prefix = excluded.token_prefix,
                 rotated_at = now(),
                 revoked_at = null,
                 expires_at = null`,
          [target.id, sha256Hex(agentToken), prefix],
        );

        await client.query(
          'update binding_tokens set used_at = now(), used_ip = $2 where id = $1',
          [token.id, request.ip],
        );

        await client.query(
          `update routers set status = 'pending', updated_at = now() where id = $1`,
          [target.id],
        );
        await client.query('commit');

        const settings = await loadSettings(pool);

        await audit(pool, {
          actorId: token.created_by,
          action: 'agent.bind',
          targetType: 'router',
          targetId: target.id,
          routerId: target.id,
          result: 'ok',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: { product: body.product ?? 'unknown', agent_version: body.agent_version },
        });

        return {
          router_id: target.id,
          agent_token: agentToken,
          server_url: ctx.publicUrl,
          poll_interval_seconds: settings.monitoring.intervalSeconds,
          poll_hold_seconds: ctx.pollHoldSeconds,
          require_signature: ctx.requireSignature,
          server_time: new Date().toISOString(),
          protocol: 'v1',
        };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  );

  // Все последующие маршруты подписываются токеном агента.
  const agentGuard = async (request: FastifyRequest): Promise<void> => {
    const auth = await authenticateAgent(pool, {
      authorization: request.headers.authorization,
      timestamp: headerValue(request, 'x-rc-timestamp'),
      nonce: headerValue(request, 'x-rc-nonce'),
      signature: headerValue(request, 'x-rc-signature'),
      method: request.method,
      path: request.url.split('?')[0] ?? request.url,
      rawBody: request.rawBody ?? Buffer.alloc(0),
      requireSignature: ctx.requireSignature,
    });

    request.agent = {
      routerId: auth.routerId,
      ownerId: auth.ownerId,
      product: auth.product,
      status: auth.status,
      agentVersion: auth.agentVersion,
    };

    const settings = await loadSettings(pool);
    void settings;
    const seen = await pool.query<{ previous_status: string | null; requested_at: Date | null }>(
      `with prev as (
         select status, reboot_requested_at from routers where id = $1
       )
       update routers r
          set last_poll_at = now(), last_seen_at = now(),
              status = case
                when r.status in ('pending','offline') then 'online'
                else r.status end,
              reboot_requested_at = case
                when prev.reboot_requested_at is not null
                 and prev.reboot_requested_at < now() - interval '30 seconds'
                then null
                else r.reboot_requested_at end
         from prev
        where r.id = $1
       returning prev.status as previous_status,
                 prev.reboot_requested_at as requested_at`,
      [auth.routerId],
    );
    await pool.query(
      `insert into router_availability (router_id, online_since, last_transition)
       values ($1, now(), now())
       on conflict (router_id) do update
         set online_since = coalesce(router_availability.online_since, now()),
             offline_since = null,
             misses = 0,
             last_transition = case when router_availability.offline_since is not null
                                    then now() else router_availability.last_transition end`,
      [auth.routerId],
    );

    const previous = seen.rows[0];
    const requestedAt = previous?.requested_at ? previous.requested_at.getTime() : null;
    const bucket = new Date().toISOString().slice(0, 13);

    if (requestedAt != null && Date.now() - requestedAt > 30_000) {
      await notifyRouterOwner(pool, auth.routerId, {
        kind: 'router.rebooted',
        severity: 'info',
        message: 'Роутер перезагрузился и снова в сети',
        dedupeKey: `rebooted:${auth.routerId}:${bucket}`,
      });
    } else if (previous?.previous_status === 'offline') {
      await notifyRouterOwner(pool, auth.routerId, {
        kind: 'router.online',
        severity: 'info',
        message: 'Связь с роутером восстановлена',
        dedupeKey: `online:${auth.routerId}:${bucket}`,
      });
    }
  };

  app.post(
    '/agent/v1/probe',
    { config: { public: true, skipAuth: true } },
    async (request) => {
      await agentGuard(request);
      const agent = agentContext(request);
      const body = probeSchema.parse(request.body);

      const client = await pool.connect();
      try {
        await client.query('begin');
        await updateRouterFromProbe(client, agent.routerId, {
          ...body,
          agent_version: body.agent_version ?? agent.agentVersion,
        });
        await touchRouterSeen(client, agent.routerId, {
          status:
            body.platform_state === 'conflict' || body.conflict
              ? 'conflict'
              : body.platform_state === 'unsupported'
                ? 'unsupported'
                : 'online',
        });

        if (body.managed) {
          const managed = sanitizeAgentState(body.managed);
          const { stateHash } = await import('../domain/uci.js');
          await client.query(
            `insert into router_state (router_id, managed, state_hash, health, service, capabilities, collected_at, source)
             values ($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb, now(), 'probe')
             on conflict (router_id) do update
               set managed = excluded.managed, state_hash = excluded.state_hash,
                   health = excluded.health, service = excluded.service,
                   capabilities = excluded.capabilities, collected_at = now(),
                   source = 'probe'`,
            [
              agent.routerId,
              JSON.stringify(managed),
              stateHash(managed),
              JSON.stringify(body.health ?? {}),
              JSON.stringify(body.service ?? {}),
              JSON.stringify(body.capabilities ?? {}),
            ],
          );
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      await pool.query('delete from nonces where seen_at < now() - interval \'10 minutes\'');
      return { ok: true, server_time: new Date().toISOString() };
    },
  );

  app.post(
    '/agent/v1/rotate',
    { config: { public: true, skipAuth: true } },
    async (request) => {
      await agentGuard(request);
      const agent = agentContext(request);

      const newToken = randomToken(32);
      const prefix = newToken.slice(0, 8);
      const updated = await pool.query(
        `update router_credentials
            set previous_token_hash = token_hash,
                previous_expires_at = now() + interval '600 seconds',
                token_hash = $2,
                token_prefix = $3,
                rotated_at = now(),
                revoked_at = null
          where router_id = $1`,
        [agent.routerId, sha256Hex(newToken), prefix],
      );
      if ((updated.rowCount ?? 0) === 0) {
        throw notFound('Учётные данные агента не найдены');
      }

      await audit(pool, {
        actorRole: 'agent',
        action: 'router.credential_rotate',
        targetType: 'router',
        targetId: agent.routerId,
        routerId: agent.routerId,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { source: 'agent' },
      });

      return { agent_token: newToken, server_time: new Date().toISOString() };
    },
  );

  // QR для мобильного входа показывает сам роутер: LuCI → Службы → RoutX.
  // Ссылку выпускает только привязанный агент, поэтому панель её не создаёт.
  app.post(
    '/agent/v1/mobile-link',
    { config: { public: true, skipAuth: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      await agentGuard(request);
      const agent = agentContext(request);

      const found = await pool.query<{ owner_id: string | null }>(
        'select owner_id from routers where id = $1',
        [agent.routerId],
      );
      const ownerId = found.rows[0]?.owner_id ?? null;
      if (!ownerId) {
        throw badRequest('router_owner_missing', 'У роутера не указан владелец');
      }

      const base = ctx.publicUrl.replace(/\/+$/, '');
      const forwardedProto = headerValue(request, 'x-forwarded-proto');
      const baseUrl =
        forwardedProto === 'https' && base.startsWith('http://')
          ? base.replace(/^http:\/\//, 'https://')
          : base;

      const link = await createMobileLink(pool, {
        userId: ownerId,
        routerId: agent.routerId,
        baseUrl,
      });

      await audit(pool, {
        actorRole: 'agent',
        action: 'router.mobile_link',
        targetType: 'router',
        targetId: agent.routerId,
        routerId: agent.routerId,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          source: 'router-luci',
          expires_at: link.expires_at,
          https: link.https,
        },
      });

      return { ...link, server_time: new Date().toISOString() };
    },
  );

  app.post(
    '/agent/v1/poll',
    { config: { public: true, skipAuth: true } },
    async (request) => {
      await agentGuard(request);
      const agent = agentContext(request);
      void pool.query('delete from nonces where seen_at < now() - interval \'10 minutes\'').catch(() => undefined);

      const holdSeconds = Math.min(ctx.pollHoldSeconds, 25);
      const deadline = Date.now() + holdSeconds * 1000;

      for (;;) {
        const command = await claimCommand(pool, agent.routerId);
        if (command) {
          return {
            command: {
              id: command.id,
              op: command.op,
              args: command.args,
              expires_at: command.expires_at.toISOString(),
              attempt: command.attempt,
            },
            server_time: new Date().toISOString(),
          };
        }

        if (Date.now() >= deadline) {
          return { command: null, server_time: new Date().toISOString() };
        }

        await waitForAgentWake(
          agent.routerId,
          Math.max(50, Math.min(1000, deadline - Date.now())),
        );      }
    },
  );

  app.post(
    '/agent/v1/commands/:id/result',
    { config: { public: true, skipAuth: true } },
    async (request) => {
      await agentGuard(request);
      const agent = agentContext(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = resultSchema.parse(request.body);

      const rawSize = Buffer.byteLength(JSON.stringify(body.result ?? null), 'utf8');
      const { jobId } = await collectCommandResult(
        pool,
        agent.routerId,
        params.id,
        body.status,
        body.result ?? null,
        body.error ?? null,
        rawSize,
      );

      return { ok: true, job_id: jobId };
    },
  );

  app.post(
    '/agent/v1/report',
    { config: { public: true, skipAuth: true } },
    async (request, reply) => {
      await agentGuard(request);
      const agent = agentContext(request);
      const body = reportSchema.parse(request.body);

      const raw = Buffer.from(body.body, 'base64');
      if (raw.length > 2 * 1024 * 1024) {
        throw badRequest('report_too_large', 'Отчёт превышает 2 МиБ');
      }
      const digest = sha256Hex(raw);
      if (digest.toLowerCase() !== body.sha256.toLowerCase()) {
        throw badRequest('report_checksum_mismatch', 'Контрольная сумма отчёта не совпадает');
      }

      await pool.query(
        `insert into agent_reports (id, router_id, sha256, size_bytes, body)
         values ($1,$2,$3,$4,$5)`,
        [uuidv7(), agent.routerId, digest, raw.length, raw],
      );

      reply.code(201);
      return { ok: true, sha256: digest, size_bytes: raw.length };
    },
  );

  // Авторизованные телефоны. Список и удаление доступны только с самого
  // роутера (LuCI → Служба → RoutX), панель их не трогает.
  app.get(
    '/agent/v1/mobile-devices',
    { config: { public: true, skipAuth: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      await agentGuard(request);
      const agent = agentContext(request);

      const result = await pool.query<{
        id: string;
        name: string;
        platform: string | null;
        created_at: Date;
        last_seen_at: Date;
      }>(
        `select id, name, platform, created_at, last_seen_at
           from mobile_devices
          where router_id = $1 and revoked_at is null
          order by created_at desc`,
        [agent.routerId],
      );

      return {
        items: result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          platform: row.platform,
          created_at: row.created_at.toISOString(),
          last_seen_at: row.last_seen_at.toISOString(),
        })),
        server_time: new Date().toISOString(),
      };
    },
  );

  app.post(
    '/agent/v1/mobile-devices/:id/revoke',
    { config: { public: true, skipAuth: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      await agentGuard(request);
      const agent = agentContext(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);

      const updated = await pool.query<{ id: string; name: string }>(
        `update mobile_devices
            set revoked_at = now(), revoked_by = 'router', device_token_hash = null
          where id = $1 and router_id = $2 and revoked_at is null
          returning id, name`,
        [params.id, agent.routerId],
      );
      const device = updated.rows[0];
      if (!device) throw notFound('Устройство не найдено или уже удалено');

      await pool.query(
        `update sessions set revoked_at = now()
          where mobile_device_id = $1 and revoked_at is null`,
        [device.id],
      );

      await audit(pool, {
        actorRole: 'agent',
        action: 'router.mobile_device_revoke',
        targetType: 'router',
        targetId: agent.routerId,
        routerId: agent.routerId,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { device_id: device.id, device_name: device.name, source: 'router-luci' },
      });

      return { ok: true, id: device.id };
    },
  );

  // Периодическая очистка просроченных команд выполняется воркером.
  void expireCommands;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
