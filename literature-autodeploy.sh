#!/usr/bin/env bash
# literature-fingerprinting 自动部署脚本
#
# 由服务器 root crontab 每 2 分钟调用一次：GitHub master 有新提交才 ff-only 拉取并重启服务。
# 这份是仓库里的权威副本，服务器上装在 /usr/local/bin/literature-autodeploy.sh。
# 改完要 cp 过去，安装命令见 README「第十一批」。
#
# 旧版（2026-10-07 之前）有两个 bug，合起来导致服务被无限白重启：
#   1. 不看 `git fetch` 的退出码；
#   2. 拿 `git rev-parse FETCH_HEAD` 跟 HEAD 比，而 FETCH_HEAD 是「上一次成功拉取」的
#      陈旧值（拉取彻底失败时 git 甚至会把 "FETCH_HEAD" 这个字面量打印出来）。
#   于是 LOCAL != REMOTE 恒成立，守卫被绕过，每一轮 cron 都走一遍 merge + restart。
#   实测日志：6362 次 [ok] restarted，其中真正带来新提交的是 0 次。
# 两个修法各一行：fetch 失败直接退出，比对对象换成 origin/master。

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
set -u

LOCK=/run/lock/literature-autodeploy.lock
exec 9>"$LOCK"
flock -n 9 || exit 0   # 上一轮还没跑完（网络卡住时会）就跳过这一轮

LOG=/var/log/literature-autodeploy.log
cd /opt/literature-fingerprinting || exit 1

# 超时兜底：这台机器到 github.com 经常卡满两分钟（GnuTLS recv error / 443 连不通），
# 不设上限会把每一轮 cron 都拖住、并连带跳过下一轮。
# 拉取失败一律安静退出——下一轮会自动重试；**绝不能因为拉不动就去重启服务**。
#
# `-c http.version=HTTP/1.1`：2026-10-08 查线上日志，cron 里的失败几乎全是
#   error: RPC failed; curl 16 Error in the HTTP2 framing layer
#   fatal: expected flush after ref listing
# 这不是慢、是秒失败（跟上面的超时是两回事，所以两条都得在）。手动加这条开关实测
# **第一次就拉下来了**。默认走 HTTP/2，这台机器的网络路径谈不下。
if ! timeout 90 git -c http.version=HTTP/1.1 fetch origin master -q 2>>"$LOG"; then
  exit 0
fi

LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse origin/master 2>/dev/null)
# 解析不出任何一个 sha 就什么都别做：宁可这轮不部署，也不能拿空值去比、去 merge。
if [ -z "$LOCAL" ] || [ -z "$REMOTE" ]; then
  echo "$(date +"%F %T") [error] cannot resolve HEAD or origin/master" >> "$LOG"
  exit 0
fi
[ "$LOCAL" = "$REMOTE" ] && exit 0   # 无新提交，安静退出

echo "$(date +"%F %T") [deploy] $LOCAL -> $REMOTE" >> "$LOG"
if git merge --ff-only origin/master -q; then
  systemctl restart literature-fingerprinting
  echo "$(date +"%F %T") [ok] restarted, HEAD=$(git rev-parse --short HEAD)" >> "$LOG"
else
  echo "$(date +"%F %T") [error] ff merge failed - manual check needed" >> "$LOG"
fi
