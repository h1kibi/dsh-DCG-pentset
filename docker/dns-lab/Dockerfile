# 实验室 DNS 服务器（bind9）——只用于冒烟与演练，不是产品组件。
#
# 为什么要有它：`dns_axfr`（区域传送）这条核验需要一个**故意配错**的权威服务器才能验成功分支
# （AD DC 的内嵌 DNS 会拒绝未认证传送，只能验"被拒"那一半）。同时它也给 `dns_enum` / `dns_brute`
# 提供了正向样本（真实存在的正/负记录）。
#
# 用法（RUNBOOK §2.1⑤ 靶标一节）：
#   docker build -t pentest-dns-lab:lab docker/dns-lab
#   docker run -d --name dns-lab --network pentest-lab-internal pentest-dns-lab:lab
FROM debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bind9 bind9-utils bind9-dnsutils dnsutils \
  && rm -rf /var/lib/apt/lists/*

COPY named.conf /etc/bind/named.conf
COPY db.lab-zone.test /etc/bind/db.lab-zone.test
RUN chown -R bind:bind /etc/bind /var/cache/bind

# 前台跑，日志到 stdout（容器主进程）
ENTRYPOINT ["/usr/sbin/named", "-g", "-c", "/etc/bind/named.conf", "-u", "bind"]
