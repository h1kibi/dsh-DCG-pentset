#!/bin/bash
# 一次性 provision + 起一个 Samba AD DC（实验室用）。全程本地操作，不需要网络。
set -eux

REALM=LAB.LOCAL
DOMAIN=LAB
PASS='Passw0rd!234'

# provision 要求 hostname 与 /etc/hosts 自洽（容器用 --hostname dc1 启动）
echo "127.0.0.1 dc1.lab.local dc1 localhost" > /etc/hosts
echo "dc1" > /etc/hostname
rm -f /etc/samba/smb.conf

# 域已存在（卷里已有 sam.ldb）就跳过 provision——脚本整体可重复运行。
# 但 smb.conf 生成在**容器文件系统**里、不在卷里：换新容器时会丢，于是这里把它随卷持久化
# （否则第二次起容器会出现「有域、没有 smb.conf」→ samba 起不来，2026-10-06 实测踩到）。
if [ ! -f /var/lib/samba/private/sam.ldb ]; then
  samba-tool domain provision --use-rfc2307 --realm="$REALM" --domain="$DOMAIN" \
    --server-role=dc --dns-backend=SAMBA_INTERNAL --adminpass="$PASS" \
    --option="dns forwarder=127.0.0.11"
  cp -f /etc/samba/smb.conf /var/lib/samba/smb.conf.keep
else
  echo '域已存在，跳过 provision'
  if [ ! -f /etc/samba/smb.conf ] && [ -f /var/lib/samba/smb.conf.keep ]; then
    cp -f /var/lib/samba/smb.conf.keep /etc/samba/smb.conf
    echo '已从卷里恢复 smb.conf'
  fi
fi
cp -f /var/lib/samba/private/krb5.conf /etc/krb5.conf

# 允许非 TLS 的简单绑定（**实验室夹具专用**）：Samba 默认 `ldap server require strong auth = yes`，
# 会让 ldapdomaindump / bloodhound-python / certipy / adidnsdump 的普通 ldap:// 绑定直接以
# `LDAPSessionTerminatedByServerError`（或 `Strong(er) authentication required`）失败——
# 2026-10-06 实测。真实域里这条常是开的（那就得走 LDAPS/签名），所以技能里也写了这条失败形态。
# 必须插在 **[global] 段内**：追加到文件末尾会落进最后一个 section，samba 只警告不生效（实测踩过）。
if ! grep -q 'ldap server require strong auth' /etc/samba/smb.conf; then
  awk '/^\[global\]/{print; print "\tldap server require strong auth = no"; next} {print}' \
    /etc/samba/smb.conf > /tmp/smb.conf.new && mv /tmp/smb.conf.new /etc/samba/smb.conf
fi

# 造可枚举的对象：服务账号（带 SPN）、不要求预认证的账号、组、共享、A 记录
# 全部写成幂等：重复运行不报错（域已存在时跳过创建），便于反复起停。
samba-tool user create svc-sql "$PASS" --given-name=Service --surname=SQL >/dev/null 2>&1 || true
samba-tool user create svc-web "$PASS" >/dev/null 2>&1 || true
samba-tool user create nopreauth "$PASS" >/dev/null 2>&1 || true
samba-tool spn add MSSQLSvc/sql.lab.local:1433 svc-sql >/dev/null 2>&1 || true
samba-tool spn add HTTP/web.lab.local svc-web >/dev/null 2>&1 || true
samba-tool group add Helpdesk >/dev/null 2>&1 || true
samba-tool group addmembers Helpdesk svc-web >/dev/null 2>&1 || true
# DONT_REQ_PREAUTH = 4194304 的属性改动挪到 DC 起来之后用 ldapmodify 做（见下）
samba-tool domain passwordsettings set --complexity=off --min-pwd-length=7 --history-length=0 >/dev/null 2>&1 || true

# 前台起 DC（容器主进程），起来之后再用标准 ldapmodify 补 DONT_REQ_PREAUTH。
# 为什么不直接改 sam.ldb：直接用路径开 ldb 需要 loadparm 上下文，samba 的 python 绑定会以
# `Type mismatch: name[NULL] expected[struct loadparm_context]` 崩（2026-10-06 实测）；
# 而对着**运行中的** DC 用 LDAP 改，既不需要 ldb-tools，也不需要 python 绑定。
/usr/sbin/samba --foreground --no-process-group &
SAMBA_PID=$!
echo "等待 DC 就绪（pid $SAMBA_PID）…"
for i in $(seq 1 30); do
  if ldapsearch -x -H ldap://127.0.0.1 -s base -b "" namingContexts >/dev/null 2>&1; then break; fi
  sleep 2
done

ldapmodify -x -H ldap://127.0.0.1 -D "Administrator@$REALM" -w "$PASS" <<'LDIF' || echo '（UAC 位可能已设置过）'
dn: CN=nopreauth,CN=Users,DC=lab,DC=local
changetype: modify
replace: userAccountControl
userAccountControl: 4260352
LDIF

samba-tool dns add 127.0.0.1 lab.local web A 172.29.0.50 >/dev/null 2>&1 || true
echo 'DC 就绪：LDAP/Kerberos/SMB 已监听'
wait $SAMBA_PID
