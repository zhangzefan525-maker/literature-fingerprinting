# src/atomic_io.py
"""
原子写 JSON
===========

所有会被下一次请求、下一次重算或另一个 gunicorn worker 读到的 JSON，
都应当「一次出现就是完整的」：先在同一目录写临时文件，`flush` + `fsync`，
再用 `os.replace` 原子替换目标。读者要么看到旧文件，要么看到新文件，
不会看到 `open(..., 'w')` 截断后写了一半的半截 JSON。

临时文件用 `.tmp` 后缀、放在目标同目录（跨文件系统 rename 不原子），
不会被 `glob("*.json")` 之类的扫描当成数据文件。
"""

import json
import os
import tempfile
from pathlib import Path


def write_json_atomic(target, data, *, indent=None, ensure_ascii=False):
    """
    把 `data` 以 JSON 形式原子写入 `target`。

    成功路径写出的字节与 `json.dump(data, f, ensure_ascii=..., indent=...)`
    完全一致；区别只在「什么时候可见」以及失败时旧文件保持原样。
    返回写入的路径。
    """
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{target.name}.",
        suffix=".tmp",
        dir=str(target.parent),
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=ensure_ascii, indent=indent)
            f.flush()
            os.fsync(f.fileno())

        # 保留原文件权限（mkstemp 默认 0600）；新文件则维持 mkstemp 的结果。
        try:
            mode = target.stat().st_mode & 0o777
        except OSError:
            mode = None
        if mode is not None:
            os.chmod(tmp, mode)

        os.replace(tmp, target)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise

    # 目录项落盘：崩溃后 rename 也还在。Windows 不支持对目录 fsync，失败即忽略。
    try:
        dir_fd = os.open(target.parent, os.O_RDONLY)
    except OSError:
        return target
    try:
        os.fsync(dir_fd)
    except OSError:
        pass
    finally:
        os.close(dir_fd)
    return target
