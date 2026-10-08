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
#
# 2026-10-08 再补三件（这份脚本的日志必须又少又准，上面那条教训就是刷屏刷出来的）：
#   - 日志超 1 MB 滚成 .1；
#   - ff 失败记 stderr 与 git status，但同一个 REMOTE 只记一次（/run/…lastfail）；
#   - 重启后 curl 验活，不通就记状态 + journalctl 尾部。

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
set -u

LOCK=/run/lock/literature-autodeploy.lock
exec 9>"$LOCK"
flock -n 9 || exit 0   # 上一轮还没跑完（网络卡住时会）就跳过这一轮

LOG=/var/log/literature-autodeploy.log
FAILSTATE=/run/literature-autodeploy.lastfail

# 日志轮转（2026-10-08 加）：正常一轮 cron 只写 0–2 行，1 MB 够放几个月；
# 超了就滚成 $LOG.1（只留一代——这个文件大只可能是出事了，留一代足够查）。
# 必须放在任何写 LOG 的动作之前，否则本轮还在往要滚走的那个文件里写。
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  mv -f "$LOG" "$LOG.1"
fi

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
# 无新提交，安静退出。顺带清掉上次的失败标记：本地已经和 origin/master 同一个 sha，
# 说明那次 ff 失败已经被处理掉了（人工 reset / 手动 merge 过），留着它只会让下一次
# 真失败时误判成「同一个 failure 已经记过」而静默。
if [ "$LOCAL" = "$REMOTE" ]; then
  rm -f "$FAILSTATE"
  exit 0
fi

echo "$(date +"%F %T") [deploy] $LOCAL -> $REMOTE" >> "$LOG"
if MERGE_ERR=$(git merge --ff-only origin/master -q 2>&1); then
  rm -f "$FAILSTATE"
  # 重启本身失败（start-limit-hit、unit 写坏）也要留痕：不然只会等 10 秒后报一句
  # 「not serving」，看不出是服务起不来还是重启就没成功。
  if ! RESTART_OUT=$(systemctl restart literature-fingerprinting 2>&1); then
    echo "$(date +"%F %T") [error] systemctl restart failed: ${RESTART_OUT:-rc=$?}" >> "$LOG"
  fi
  # 重启后验活（2026-10-08 加）：README 立的门槛就是「只认 curl 与 git rev-parse HEAD」，
  # 脚本自己也该量这两样。systemd 报 active 只说明进程在，能答一个请求才算真的起来了。
  # 最多试 5 次 × 每次 2 秒（够冷启动把 gunicorn 那几个 worker 拉起来）。
  # 探针打 /visualization 而不是 API：那是静态路由，不会被 _ensure_demo_data() 的
  # 首次重建拖过 5 秒超时（冷启动第一次重建示例数据要好几十秒，打 API 必然假失败）。
  SERVING=0
  for _ in 1 2 3 4 5; do
    sleep 2
    if systemctl is-active --quiet literature-fingerprinting \
       && curl -fsS -m 5 -o /dev/null http://127.0.0.1:8000/visualization; then
      SERVING=1
      break
    fi
  done
  if [ "$SERVING" = 1 ]; then
    echo "$(date +"%F %T") [ok] restarted, HEAD=$(git rev-parse --short HEAD), serving" >> "$LOG"
  else
    echo "$(date +"%F %T") [error] restarted but not serving; is-active=$(systemctl is-active literature-fingerprinting)" >> "$LOG"
    journalctl -u literature-fingerprinting -n 5 --no-pager 2>/dev/null | sed 's/^/    /' >> "$LOG"
  fi
else
  # 失败要能诊断：ff 失败几乎总是本地有脏文件或分叉（谁在服务器上改过代码）。
  # 但同一个 REMOTE 只记一次——cron 每 2 分钟一轮，不设这道闸就会变成
  # 文件头里那 6362 次刷屏的翻版（当年刷的是 [ok]，现在会刷 [error]）。
  if [ "$(cat "$FAILSTATE" 2>/dev/null)" != "$REMOTE" ]; then
    {
      echo "$(date +"%F %T") [error] ff merge failed: $LOCAL -> $REMOTE"
      # git 的报错是多行的，直接塞进日志会把这个「一行一事件」的格式打断
      # （grep/awk 全都不好使）：折成一行、截到 400 字符。
      echo "    stderr: $(printf '%s' "$MERGE_ERR" | tr '\n' ' ' | cut -c1-400)"
      echo "    git status --porcelain (head -5):"
      git status --porcelain 2>/dev/null | head -5 | sed 's/^/        /'
    } >> "$LOG"
    echo "$REMOTE" > "$FAILSTATE"
  fi
fi
