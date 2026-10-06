# 实验室 AD 域控（Samba AD DC）——**只用于冒烟与演练**，不是产品组件。
#
# 为什么单独做一个镜像：容器内 `apt-get update` 在本环境里要 4 分钟起步（出口间歇），
# 而**构建期**网络稳定得多（工具镜像几百个包 4 分钟装完）。所以包在构建期装好，
# 运行时只做 `samba-tool domain provision`（纯本地操作，不需要网络）。
#
# 用法（RUNBOOK §2.1 靶标一节）：
#   docker build -t pentest-ad-dc:lab docker/ad-dc
#   docker run -d --name ad-dc --network pentest-lab-internal --hostname dc1 pentest-ad-dc:lab
# 域：LAB.LOCAL（NetBIOS LAB），管理员口令 Passw0rd!234，含两个带 SPN 的服务账号与一个
# 不要求预认证（DONT_REQ_PREAUTH）的账号，供 recon-ad-surface / vuln-ad-checks 冒烟。
FROM debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      samba samba-ad-provision samba-ad-dc samba-dsdb-modules samba-vfs-modules \
      smbclient winbind libsasl2-modules krb5-user dnsutils ldap-utils ldb-tools \
  && rm -rf /var/lib/apt/lists/*
# 注意：容器必须 `--privileged` 运行——`samba-tool domain provision` 在设置 sysvol 的 NT ACL 时
# 需要 Docker 默认不授予的能力，否则报 `set_nt_acl_no_snum: fset_nt_acl returned NT_STATUS_ACCESS_DENIED`
# （2026-10-06 实测：换卷/换文件系统都无效，加 `--privileged` 才过）。这是实验室夹具，隔离不是诉求。

COPY provision.sh /usr/local/bin/provision.sh
RUN chmod 0755 /usr/local/bin/provision.sh

ENTRYPOINT ["/usr/local/bin/provision.sh"]
