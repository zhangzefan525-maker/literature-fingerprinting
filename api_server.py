#!/usr/bin/env python3
"""
文印项目 - 数据API服务器
为D3.js可视化提供JSON数据接口
"""

from flask import Flask, g, has_request_context, jsonify, request, send_from_directory, send_file
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge
import hashlib
import json
import math
import os
import re
import secrets
import time
from pathlib import Path

from src.data_loader import BLOCK_SIZE, OVERLAP, clean_text

# 初始化Flask应用
app = Flask(__name__, static_folder='static')

# 前后端同源部署，默认不需要跨域。只放行本机开发用的地址，
# 避免任何网站都能在访客浏览器里调用这里的接口。
CORS(app, resources={r"/api/*": {"origins": [
    r"http://localhost(:\d+)?",
    r"http://127\.0\.0\.1(:\d+)?",
]}})

# 反向代理跳数：站在 nginx 之类后面时，request.remote_addr 拿到的是代理自己的地址，
# 于是「上传限流」从「按访客」退化成「全站共用一个桶」——第 11 次上传之后所有人一起
# 被挡，报错却写着「请求太频繁了」（指向本人）。设为 1（或真实跳数）让 Flask 改读
# X-Forwarded-For 的最后一跳，限流才按真实访客算。
#
# 默认 0 = 不信任任何转发头，行为与以前完全一致。这个开关**只在该端口无法被绕过代理
# 直连时**才安全：能直连的话，任何人都能自己伪造 X-Forwarded-For，限流就从「共用一个
# 桶」变成「完全可绕过」——比不改更糟。所以默认关，要用先确认部署拓扑。
_TRUST_PROXY_COUNT = int(os.environ.get("TRUST_PROXY_COUNT", "0") or 0)
if _TRUST_PROXY_COUNT > 0:
    from werkzeug.middleware.proxy_fix import ProxyFix

    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=_TRUST_PROXY_COUNT)

# 限制上传文件大小，防止超大文件拖垮服务器
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB

# 上传片段数上限。50 MB 只是「文件字节」这道闸门，换成英文正文能装下几百万词，
# 而分析开销随片段数线性增长（每个片段都要做分词与指标计算）。
#
# 这个上限现在由**线上超时**反推，不再是「能装多少装多少」：
# 线上 gunicorn 是 --timeout 180 --workers 2（2026-10-08 从 1 提到 2），
# 实测服务器上每个片段约 0.30 秒（README 记过一次 248 个片段跑了 75 秒）。
# 600 个片段要 180 秒，正好撞上超时线，worker 被 SIGKILL——一个 worker 被占满的那 3 分钟里
# 整站只剩一半容量（提到 2 个 worker 就是为这个）。
# 300 个片段约 90 秒，是超时预算的一半，留了一倍余量。
#
# 代价写在这里，因为它是一次真实的降级：300 个片段覆盖约 31 万英文单词，
# 装不下《战争与和平》（英文约 56 万词）这类超长篇，也比原来少了一半。
# 换到的是「一篇长文不会再把全站拖死」。超长篇的出路在下面的报错里写明了：
# 拆文件分次上传，或先截取要研究的章节。下限（太短）在 analyze_upload 里判，两边对称。
MAX_BLOCKS = 300


@app.errorhandler(RequestEntityTooLarge)
def handle_request_too_large(_error):
    """
    将 Flask 默认 HTML 413 转为前端可解析的 JSON。

    这里**不报具体数字**（以前写的是「不能超过 50 MB」）。因为真正会拦下绝大多数
    用户的不是字节数：线上 nginx 在 20 MB 就先返回 413，本地直跑没有 nginx、
    要等 Flask 的 MAX_CONTENT_LENGTH（50 MB），而用户实际上多半是在更早的一步
    ——片段数超过 MAX_BLOCKS，约合 1.9 MB 正文——被挡下的，那一步有自己的报错。
    写死任何一个数字，都会在其中一种部署下是错的；能照做的建议只有「截取章节/拆文件」。
    """
    return jsonify({
        "status": "error",
        "message": "文件太大，服务器不接受这么大的上传。请先截取要研究的章节，"
                   "或拆成几个文件分次上传。"
    }), 413


# 配置
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data" / "raw"
STATIC_DIR = BASE_DIR / "static"
LIBRARY_DIR = BASE_DIR / "data" / "library"  # 用户「我的图书馆」（勾选保存的派生分析 JSON）

# 确保目录存在
DATA_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR.mkdir(parents=True, exist_ok=True)
LIBRARY_DIR.mkdir(parents=True, exist_ok=True)

# 演示数据生成状态（懒加载：首次请求时若 all_books.json 缺失、或还是旧管线留下的，自动生成一次）
_demo_data_ready = False

# 上次尝试「重算陈旧演示数据」时那份文件的指纹；同一份旧文件只尝试一次。
_demo_repair_stamp = None

# 当前管线写出的 all_books.json 结构版本（见 generate_data.py / src/pipeline.py）。
# 只判断「文件在不在」是不够的：data/processed/ 不进版本库，旧克隆里那份是旧管线生成的，
# 它会一直存在、也就永远不会被重算——线上就因此喂了一个月的旧数据（没有 chapters、
# 没有共享投影模型），前端拿不到章节和跨书坐标，只能退回「各书各自算」的降级分支。
_DEMO_SCHEMA_VERSION = 3


# ---------------------------------------------------------------------------
# 访客身份：每个浏览器一枚匿名编号，「我的图书馆」按它分目录存放
#
# 以前所有人共用一份 data/library/，于是甲勾选保存的书不只出现在乙的书单里，
# 还会并进乙看到的那份语料——乙能在「值得一看的片段」里读到甲上传文本的原文摘录，
# 自己什么都没传，星系图上却凭空多出几个点。老师来评分时看到的是全班的合集。
#
# 不做账号：站点是 HTTP（没有证书，密码就是明文），项目里也没有数据库，
# 为「传一篇文本看指纹」这种一次性动作引入注册/登录/改密/会话，风险远大于收益。
# 只发一枚随机编号，不收集任何个人信息。
#
# 代价写在明处：编号只活在浏览器里，清一次浏览器数据，书架就从这台设备上消失了。
# 第二十批补上了「找回」：编号由 /api/books 的 shelfCode 显示在页面上，在另一台
# 设备上用 /api/shelf/claim 填回去就能切过去。规则没有变——知道编号 = 能看到这个
# 书架——编号本身就是那把钥匙，只是原先从没人看见过它。
# ---------------------------------------------------------------------------
VISITOR_COOKIE = "lf_visitor"
# 编号会被直接当成子目录名，所以只允许 URL-safe base64 的那一段字符。
# 少了这道校验，cookie 就是访客手里一条直通 data/ 的路径穿越——all_books.json
# 就躺在它的上一层。校验必须发生在它碰到任何路径之前。
_VISITOR_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_VISITOR_MAX_AGE = 365 * 24 * 3600


def _current_visitor():
    """
    本请求的访客编号；不在请求上下文里（命令行、单元测试的直接调用）返回 None。

    必须先问 has_request_context()：直接读 g 在没有上下文时会抛 RuntimeError，
    而下面这些函数（_library_keys / _resolve_final_name …）是要能被直接调用的。
    """
    if not has_request_context():
        return None
    return getattr(g, "visitor_id", None)


def _visitor_dir(visitor):
    """
    访客的书架目录。

    visitor 为空 = 调用方没有访客身份（命令行、测试里的直接调用），退回顶层目录，
    也就是这次改动之前的行为。编号不合法时同样退回顶层——**退回、而不是拿去拼路径**：
    这样哪怕哪天有人把没校验过的值传进来，最坏也只是读到共享目录，不会跑出 data/library/。
    """
    if visitor and _VISITOR_RE.match(visitor):
        return LIBRARY_DIR / visitor
    return LIBRARY_DIR


def _shelf_dir(visitor=None):
    """书架目录：显式给了就用给的，没给就取本请求的访客编号。"""
    return _visitor_dir(visitor if visitor is not None else _current_visitor())


@app.before_request
def _identify_visitor():
    """每个请求认一次身份：带着合法编号就用它的，否则现发一枚。"""
    raw = request.cookies.get(VISITOR_COOKIE, "")
    if _VISITOR_RE.match(raw):
        g.visitor_id = raw
        g.visitor_cookie_new = False
    else:
        g.visitor_id = secrets.token_urlsafe(16)
        g.visitor_cookie_new = True


@app.after_request
def _hand_out_visitor_cookie(resp):
    """
    只在「这一次才拿到编号」时回设 cookie，之后每次请求都带着它。

    没有 secure 可用（线上是 HTTP），也就是说这枚编号在链路上是明文的：
    它保证的是「别人的书单里不会出现你的书」，不是机密性。
    """
    if getattr(g, "visitor_cookie_new", False):
        resp.set_cookie(
            VISITOR_COOKIE,
            g.visitor_id,
            max_age=_VISITOR_MAX_AGE,
            httponly=True,
            samesite="Lax",
            path="/",
        )
    return resp


# ---------------------------------------------------------------------------
# 「我的图书馆」：文件名校验 / 命名去重 / 落盘读写
# 统一由这里的 sanitize + resolve 决定最终书名（= 前端数据键 = 磁盘文件名），
# 客户端不二次清洗，避免「键 ↔ 文件名」漂移。
# ---------------------------------------------------------------------------
_FORBIDDEN_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
_RESERVED_DEVICE_RE = re.compile(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$', re.IGNORECASE)


def _is_local_host(host):
    """按 Host 头判断是否为本地访问（决定书库语义 local-library / hosted-library）。"""
    name = (host or "").split(":")[0].strip().lower()
    return name in {"localhost", "127.0.0.1", "::1"}


# 本机删除是否免令牌。Host 头是客户端说了算的，拿它当删除授权等于没授权；
# 默认一律要令牌，只在明确设了 ALLOW_LOCAL_DELETE=1 时才对本机放行。
_LOCAL_DELETE_ENV = "ALLOW_LOCAL_DELETE"


def _local_delete_allowed():
    """是否允许本机免令牌删除（显式开关，默认关闭）。"""
    return os.environ.get(_LOCAL_DELETE_ENV, "").strip() == "1"


# 可做趋势/异常分析的观察角度（与页面下拉框一致）
_METRIC_KEYS = {"sentenceLength", "simpsonIndex", "hapaxLegomena", "functionWords"}


def _chapter_of_block(metadata, block):
    """
    片段落在哪一章：取片段中点所在的章节区间。
    老数据没有章节信息时返回 None（前端据此省略章节文字）。
    """
    if not isinstance(metadata, dict) or not isinstance(block, int):
        return None
    chapters = metadata.get("chapters")
    if not chapters:
        return None
    step = metadata.get("step") or 1000
    block_size = metadata.get("blockSize") or 10000
    center = block * step + block_size / 2
    for chapter in chapters:
        if chapter.get("wordStart") <= center < chapter.get("wordEnd"):
            return chapter
    return None


def sanitize_book_name(raw):
    """把原始书名清洗成可安全落盘的字符串。

    - 丢弃换行/制表/全角空白等非普通空格；保留半角空格；
    - Windows/NTFS 禁用的特殊字符替换为 '_' 并合并连续下划线；
    - 去掉首尾的 '_' '.' 与空白；空则回退 'book'；
    - 命中 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）加 '_' 前缀；
    - 总长上限 200。
    CJK、全角括号「（我的）」、半角空格与半角括号均保留（NTFS 合法且键可读）。
    """
    name = str(raw or "")
    name = "".join(ch for ch in name if ch == " " or not ch.isspace())
    name = _FORBIDDEN_CHARS_RE.sub("_", name)
    name = re.sub(r"_+", "_", name)
    name = name.strip(" _.")
    if not name:
        return "book"
    if _RESERVED_DEVICE_RE.match(name):
        name = "_" + name
    return name[:200]


def _builtin_keys():
    """当前 data/raw/ 下内置示例书的文件名 stem 集合（只读，永不写）。"""
    return {p.stem for p in DATA_DIR.glob("*.txt")}


def _library_keys(visitor=None):
    """当前书架上已保存的书名集合（每次现读磁盘，避免缓存过期）。"""
    return {p.stem for p in _shelf_dir(visitor).glob("*.json")}


def _resolve_final_name(base, visitor=None):
    """决定上传文件最终采用的书名（= 前端数据键 = 磁盘文件名）。

    这里的「重名」只在自己书架上算：甲和乙各存各的《MyDoc》互不相干，
    谁也不会因为对方先存了而变成《MyDoc（我的）(2)》。

    优先级：
    1) 书库已存在同名 → 沿用同名（视为「替换更新」，不产生重复副本）；
    2) 撞上内置示例书名 → 加后缀「（我的）」，再撞则递增 (2)、(3)…；
    3) 其余情况 → 原样。内置示例书永不被覆盖。

    注意 1) 是**会毁掉旧数据的**：同名上传意味着上一次保存的那本被整份替换。
    所以调用方必须把这件事说出来（响应里的 replacedExisting / renamedFrom），
    界面上那句勾选提示也必须照实写——以前它写的是「重名会自动改名，不会覆盖」，
    与这里的行为正好相反，用户会因为信那句话而不去备份。
    """
    base = sanitize_book_name(base)
    if base in _library_keys(visitor):
        return base
    if base in _builtin_keys():
        candidate = f"{base}（我的）"
        taken = _library_keys(visitor) | _builtin_keys()
        n = 2
        while candidate in taken:
            candidate = f"{base}（我的）({n})"
            n += 1
        return candidate
    return base


def _save_library_book(name, book_data, visitor=None):
    """把一本书的指纹数据写入这个访客自己的书架（JSON，UTF-8 无转义，保留可读）。"""
    shelf = _shelf_dir(visitor)
    # 目录只在这里（真的落盘时）建。读路径永远不建目录：否则一个伪造的编号
    # 就能让服务器凭空造出一堆空目录。
    shelf.mkdir(parents=True, exist_ok=True)
    path = shelf / f"{sanitize_book_name(name)}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(book_data, f, ensure_ascii=False, indent=2)


def _strip_internal(book_data):
    """
    剥掉服务器内部字段（下划线开头的键，例如逐块功能词向量）。

    这些字段只在落盘时需要（将来换投影模型时不必要求用户重新上传原文），
    不下发前端——前端拿不到，也就不会依赖。
    """
    if not isinstance(book_data, dict):
        return book_data
    return {key: value for key, value in book_data.items() if not key.startswith("_")}


def _public_book_data(book_data):
    """
    下发用的书籍数据：每段摘录只留 150 字的 preview，摘掉 1200 字的 extended_preview。

    长摘录占了首屏响应体量的七成，却只在「复制更长的摘录」和原文弹窗里用得到——
    前端需要时改从 /api/excerpt 按段取（存储里原样保留，一个字节不动）。

    **绝不就地修改**：传进来的可能是 _load_corpus 缓存里的共享对象。就地 pop 会让
    /api/excerpt 从此只能取到短摘录，而且不报任何错——表现为「这本书就是没有更长的
    摘录」这种看起来正常的降级。所以只新建 dict，其余条目原样引用。
    """
    if not isinstance(book_data, dict):
        return book_data
    public = {}
    for key, value in book_data.items():
        if isinstance(value, list):
            public[key] = [
                ({k: v for k, v in entry.items() if k != "extended_preview"}
                 if isinstance(entry, dict) and "extended_preview" in entry else entry)
                for entry in value
            ]
        else:
            public[key] = value
    return public


def _public_corpus(data):
    """整份语料的下发版：逐本书走 _public_book_data（同样绝不就地改缓存）。"""
    if not isinstance(data, dict):
        return data
    return {name: _public_book_data(book) for name, book in data.items()}


def _find_excerpt(book_data, block):
    """
    在一本书里找某个片段的摘录：返回 (文本, 是不是长摘录)。

    必须两遍式：老数据（v1）只有 functionWords 一个指标带 extended_preview，
    如果在「只有短摘录」的指标上找到就返回，就永远走不到那份长文。
    _METRIC_KEYS 是 set，迭代顺序无定义，先排序再扫。
    """
    short_fallback = None
    for key in sorted(_METRIC_KEYS):
        entries = book_data.get(key)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("block") != block:
                continue
            extended = entry.get("extended_preview")
            if isinstance(extended, str) and extended:
                return extended, True
            short = entry.get("preview")
            if short_fallback is None and isinstance(short, str) and short:
                short_fallback = short
    return short_fallback, False


# ---------------------------------------------------------------------------
# 语料缓存：每次请求都重新解析 700 KB JSON 太浪费。
# 按「源文件指纹」缓存，all_books.json 或**本书架**里任一文件变了才重读。
#
# 以前这里只有一个槽位：两位访客交替请求时，指纹每轮都不同，于是每轮都落空、
# 反复重解那 700 KB。改成按指纹做键的小字典（上限 _CORPUS_CACHE_MAX）——
# 键就是内容本身的指纹，同一份内容谁问都是它，不同内容各占一格。
# ---------------------------------------------------------------------------
_CORPUS_CACHE_MAX = 8
_corpus_cache = {}


def _corpus_path():
    """全量语料的路径（生成脚本与这里必须指向同一个文件）。"""
    return BASE_DIR / "data" / "processed" / "all_books.json"


def _library_stamp(visitor=None):
    """
    书架指纹：文件名 + 修改时间 + 大小。新增、删除、覆盖都能检出。

    **必须按访客取。** 忘了这一点（继续 glob 顶层目录）它就会永远是空的，
    于是缓存永不失效——用户存了书却看不见，直到 all_books.json 变动才突然冒出来。
    这类错不报错、不报红，只是功能静默失灵。
    """
    stamp = []
    for path in sorted(_shelf_dir(visitor).glob("*.json")):
        try:
            stat = path.stat()
        except OSError:
            continue
        stamp.append((path.name, stat.st_mtime_ns, stat.st_size))
    return tuple(stamp)


def _file_stamp(path):
    """单个文件的指纹（修改时间 + 大小）；读不到返回 None。"""
    try:
        stat = path.stat()
    except OSError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


def _corpus_stamp(target_file, visitor=None):
    stamp = _file_stamp(target_file)
    if stamp is None:
        return None
    return (stamp[0], stamp[1], _library_stamp(visitor))


def _corpus_etag(stamp):
    """
    语料指纹 → ETag。

    指纹就是 _load_corpus 判断「要不要重读文件」用的那个：重新生成数据、本书架增删改，
    都会让它变；没变就说明这次要发的东西和上次一模一样。没有指纹时返回 None，
    调用方按「不带条件缓存」处理。

    它**只由「这份内容是什么」决定**，与缓存有没有命中无关。以前这里读的是缓存槽里存的
    那个键，而槽位会被别人的请求挤掉——同一个访客、同一份内容，也能拿到一个新 ETag，
    304 就这么白丢了。
    """
    if stamp is None:
        return None
    return hashlib.sha1(repr(stamp).encode("utf-8")).hexdigest()


def _current_corpus_etag():
    """本次请求要发的这份语料的 ETag（按本请求的访客算，因人而异）。"""
    return _corpus_etag(_corpus_stamp(_corpus_path()))


def _load_corpus(visitor=None):
    """
    读取（并缓存）全量语料：内置示例书 + 这个访客自己的书架。

    Returns:
        (dict | None, str | None): (语料字典, 给前端的来源说明)；取不到数据时返回 (None, None)
    """
    target_file = _corpus_path()
    stamp = _corpus_stamp(target_file, visitor)

    if stamp is not None:
        cached = _corpus_cache.get(stamp)
        if cached is not None:
            return cached

        with open(target_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        # 合并本书架里勾选保存的书籍（不与内置键冲突、不覆盖内置；
        # 单文件损坏只跳过，不影响其它书）
        shelf = _shelf_dir(visitor)
        if shelf.exists():
            for lib_file in sorted(shelf.glob("*.json")):
                if lib_file.stem in data:
                    continue
                try:
                    with open(lib_file, "r", encoding="utf-8") as lf:
                        payload = json.load(lf)
                    if isinstance(payload, dict) and "metadata" in payload:
                        data[lib_file.stem] = _strip_internal(payload)
                except Exception:
                    app.logger.warning("跳过无法读取的书库文件: %s", lib_file.name)

        message = f"成功加载数据文件: {target_file.name}"
        if len(_corpus_cache) >= _CORPUS_CACHE_MAX:
            # 粗粒度淘汰：满了就全清。最坏代价是某位访客多解析一遍 700 KB，
            # 不值得为这点开销引入 LRU。
            _corpus_cache.clear()
        _corpus_cache[stamp] = (data, message)
        return data, message

    # 找不到汇总文件时，退回「最新的单书文件」（保持原有后备逻辑）
    processed_dir = target_file.parent
    if processed_dir.exists():
        data_files = sorted(processed_dir.glob("*.json"), key=os.path.getctime)
        if data_files:
            latest = data_files[-1]
            with open(latest, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data, f"未找到汇总文件，加载了最新的单书文件: {latest.name}"

    return None, None


# ---------------------------------------------------------------------------
# 共享投影模型：上传的书也要落在与内置书相同的坐标系里，跨书比较才成立
# ---------------------------------------------------------------------------
_projection_model = {"loaded": False, "model": None}


def _get_projection_model():
    """
    懒加载并常驻内存的共享投影模型。文件缺失时返回 None，
    此时上传的书会退回「单书自己拟合」，前端会标成「独立坐标 · 不可直接比较」。
    """
    if not _projection_model["loaded"]:
        from src.projection import load_model
        _projection_model["model"] = load_model()
        _projection_model["loaded"] = True
    return _projection_model["model"]


# ---------------------------------------------------------------------------
# 上传限流：内存令牌桶，够挡住脚本反复提交，正常使用感觉不到
# ---------------------------------------------------------------------------
_RATE_CAPACITY = 10          # 最多攒 10 次
_RATE_REFILL_SECONDS = 30    # 每 30 秒补 1 次
_rate_state = {}


def _rate_limited(client_ip):
    now = time.monotonic()
    if len(_rate_state) > 2000:  # 防止陌生人刷 IP 把内存撑大
        _rate_state.clear()
    tokens, last = _rate_state.get(client_ip, (_RATE_CAPACITY, now))
    tokens = min(_RATE_CAPACITY, tokens + (now - last) / _RATE_REFILL_SECONDS)
    _rate_state[client_ip] = (tokens - 1 if tokens >= 1 else tokens, now)
    return tokens < 1


def _demo_corpus_is_current(target):
    """
    已存在的 all_books.json 是不是**当前管线**生成的（而不是旧克隆里那份陈旧产物）。

    只要有一本书带 metadata.schemaVersion >= 当前版本就算数：整个文件是一次写出的，
    不存在半新半旧。读不动、结构不认识，一律当过期处理（触发一次重算）。
    """
    try:
        with open(target, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    for book in data.values():
        meta = book.get("metadata") if isinstance(book, dict) else None
        if isinstance(meta, dict) and meta.get("schemaVersion", 0) >= _DEMO_SCHEMA_VERSION:
            return True
    return False


def _ensure_demo_data():
    """若预处理的示例数据不存在、或还是旧管线留下的，则基于 data/raw/ 自动生成一次（保证全新克隆开箱即用）。"""
    global _demo_data_ready, _demo_repair_stamp
    if _demo_data_ready:
        return True

    target = BASE_DIR / "data" / "processed" / "all_books.json"
    if target.exists():
        if _demo_corpus_is_current(target):
            _demo_data_ready = True
            return True
        # 文件在、但结构是旧的：重算一次。**同一份旧文件只尝试一次**——重算要跑 1~3 分钟，
        # 万一失败（比如 data/raw/ 是空的），不能让此后每个请求都卡满一次生成。
        stamp = _file_stamp(target)
        if stamp is not None and stamp == _demo_repair_stamp:
            return False
        _demo_repair_stamp = stamp

    raw_dir = BASE_DIR / "data" / "raw"
    if not raw_dir.exists() or not list(raw_dir.glob("*.txt")):
        return False

    try:
        from generate_data import process_all_books
        process_all_books()
        _demo_data_ready = _demo_corpus_is_current(target)
        # 刚生成完，投影模型文件这时才出现，让缓存重新去读
        _projection_model.update(loaded=False, model=None)
        _corpus_cache.clear()
    except Exception as e:
        print(f"自动生成演示数据失败: {e}")
        _demo_data_ready = False
    return _demo_data_ready


def _serve_visualization():
    """返回 D3.js 可视化页面（优先项目根目录，其次 static 目录）。"""
    try:
        return send_file('d3_visualization.html')
    except Exception:
        return send_from_directory('static', 'd3_visualization.html')


@app.route('/')
def index():
    """
    主页面：打开即进入 D3.js 可视化界面（不再展示 API 说明页）
    """
    return _serve_visualization()

@app.route('/visualization')
def visualization():
    """
    提供 D3.js 可视化页面
    """
    try:
        # 尝试从根目录发送文件
        return send_file('d3_visualization.html')
    except:
        try:
            # 如果不在根目录，尝试从static目录发送
            return send_from_directory('static', 'd3_visualization.html')
        except Exception:
            app.logger.exception("找不到可视化页面文件")
            return "错误: 找不到可视化页面文件。请确保 d3_visualization.html 在项目根目录或 static 文件夹中。", 404

@app.route('/favicon.ico')
def favicon():
    """
    站点图标。浏览器（以及各种爬虫）默认都会来要 /favicon.ico——以前这里 404，
    是历次批次记录在案的那条控制台噪音。页面 head 里同时有 <link rel="icon">，
    这条路由是给不起 link 的场景兜底；图标是 SVG，就近发同一份。
    """
    return send_from_directory(str(STATIC_DIR), 'favicon.svg',
                               mimetype='image/svg+xml', max_age=86400)

# api_server.py

@app.route('/api/fingerprint-data', methods=['GET'])
def get_fingerprint_data():
    """
    获取所有书籍的指纹数据（内置示例书 + 「我的图书馆」）
    """
    try:
        _ensure_demo_data()
        data, message = _load_corpus()

        if data is None:
            # 没有真实数据时，返回明确错误并引导用户生成/上传，不返回随机模拟数据
            # （避免用户把随机数误当成自己的分析结果）
            return jsonify({
                "status": "error",
                "message": "暂无可用书籍数据。请先运行 python generate_data.py 生成示例数据，"
                           "或通过上传接口 /api/analyze 上传自己的文本。"
            }), 404

        resp = jsonify({
            "status": "success",
            "message": message,
            # 长摘录（每段 1200 字符）不下发：它占这份响应体量的七成，而只有
            # 「复制更长的摘录」和原文弹窗用得到，需要时改从 /api/excerpt 按段取。
            "data": _public_corpus(data)
        })

        # 首屏每次都要拉这一份（未压缩约 0.29 MB，gzip 后约 0.04 MB；摘掉长摘录之前
        # 是 1.5 MB / 0.5 MB），而它只在重新生成数据或书库变动时才会变。带上 ETag 让
        # 重复访问走 304：浏览器仍然每次都问一句，只是问到的答案是「没变」，于是这
        # 0.04 MB 不用重传。
        # no-cache 是「可以存，但每次都要先确认」，不是「不许存」——数据会变，必须revalidate。
        # 内容是因人而异的（每人书架上放着自己的书），所以除了 ETag 认内容，
        # 还要用 Vary 告诉沿途的缓存：同一个网址，带着不同 cookie 来拿到的是不同的东西。
        resp.headers["Vary"] = "Cookie"
        etag = _current_corpus_etag()
        if etag is None:
            return resp
        resp.set_etag(etag)
        resp.headers["Cache-Control"] = "no-cache"
        return resp.make_conditional(request)

    except Exception:
        app.logger.exception("读取指纹数据失败")
        return jsonify({
            "status": "error",
            "message": "服务器读取分析数据时出错，请稍后重试。"
        }), 500

@app.route('/api/book/<book_name>', methods=['GET'])
def get_book_data(book_name):
    """
    获取特定书籍的真实指纹数据
    """
    try:
        _ensure_demo_data()
        all_data, _message = _load_corpus()

        if all_data and book_name in all_data:
            return jsonify({
                "status": "success",
                "book": book_name,
                # 与 /api/fingerprint-data 同一条规则：响应里不下发长摘录
                # （按需取走 /api/excerpt）。该端点目前没有前端调用方。
                "data": _public_book_data(all_data[book_name])
            })

        return jsonify({
            "status": "error",
            "message": f"书籍 '{book_name}' 不存在。请先运行 python generate_data.py 生成数据"
        }), 404

    except Exception:
        app.logger.exception("读取单本书数据失败")
        return jsonify({
            "status": "error",
            "message": "服务器读取这本书的数据时出错，请稍后重试。"
        }), 500

@app.route('/api/excerpt/<path:book_name>', methods=['GET'])
def get_block_excerpt(book_name):
    """
    按需取某个片段的长摘录（首屏响应不再带它，见 _public_book_data）。

    只查数据、不拼文件路径，所以不做 sanitize——穿越串在这里只是查不到（同 /api/analysis）。
    用户点击驱动、无序请求无批量，与 /api/book、/api/analysis 一样不限流。
    """
    try:
        block = int(str(request.args.get("block", "")).strip())
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "片段号必须是一个非负整数。"}), 400
    if block < 0:
        return jsonify({"status": "error", "message": "片段号必须是一个非负整数。"}), 400

    try:
        _ensure_demo_data()
        all_data, _message = _load_corpus()
        book_data = (all_data or {}).get(book_name)
        if not isinstance(book_data, dict):
            return jsonify({
                "status": "error",
                "message": "这本书不在当前数据里，请刷新页面后重试。"
            }), 404
        excerpt, extended = _find_excerpt(book_data, block)
        if not excerpt:
            return jsonify({
                "status": "error",
                "message": "这个片段没有可用的摘录。"
            }), 404
        return jsonify({
            "status": "success",
            "book": book_name,
            "block": block,
            "excerpt": excerpt,
            # false = 只有 150 字短摘录可用（老数据或该段没有长文本），前端据此换文案
            "extended": bool(extended),
        })
    except Exception:
        app.logger.exception("读取片段摘录失败")
        return jsonify({
            "status": "error",
            "message": "服务器读取这段摘录时出错，请稍后重试。"
        }), 500

@app.route('/api/analysis/<path:book_name>', methods=['GET'])
def analyze_book(book_name):
    """
    只读分析：对一本书的某个指标给出统计量、趋势与「异常片段」。

    「异常」在这里是统计意义上的偏离（离均值远 / 超出四分位距），
    不代表写得好或不好——前端文案里也要写清这一点。
    """
    from src.analysis_utils import analyze_series

    metric = request.args.get('metric', 'sentenceLength')
    if metric not in _METRIC_KEYS:
        return jsonify({
            "status": "error",
            "message": "不支持的观察角度，请换一个再试。"
        }), 400

    try:
        _ensure_demo_data()
        all_data, _message = _load_corpus()
        book_data = (all_data or {}).get(book_name)
        if not book_data:
            return jsonify({
                "status": "error",
                "message": "这本书不在当前数据里，请刷新页面后重试。"
            }), 404

        series = book_data.get(metric)
        if not isinstance(series, list) or not series:
            return jsonify({
                "status": "error",
                "message": "这本书在这个观察角度下没有数据，请换一个角度再试。"
            }), 404

        # 先过滤成 (片段号, 数值) 对：这样异常结果的序号能准确映射回片段
        pairs = []
        for item in series:
            value = item.get("value") if isinstance(item, dict) else None
            if isinstance(value, (int, float)) and math.isfinite(float(value)):
                pairs.append((item, float(value)))
        if len(pairs) < 5:
            return jsonify({
                "status": "error",
                "message": "有效的片段太少，做不了异常分析。"
            }), 404

        analysis = analyze_series([value for _item, value in pairs])
        metadata = book_data.get("metadata") or {}
        blocks = [item.get("block") for item, _value in pairs]

        anomalies = []
        for entry in analysis["anomalies"]["items"]:
            item, value = pairs[entry["index"]]
            chapter = _chapter_of_block(metadata, blocks[entry["index"]])
            anomalies.append({
                "block": blocks[entry["index"]],
                "value": value,
                "zScore": entry["zScore"],
                "byZScore": entry["byZScore"],
                "byIQR": entry["byIQR"],
                "chapterIndex": chapter["index"] if chapter else None,
                "chapterTitle": chapter["title"] if chapter else None,
                "preview": item.get("preview"),
                "keywords": item.get("keywords") or [],
            })

        return jsonify({
            "status": "success",
            "book": book_name,
            "metric": metric,
            "summary": analysis["summary"],
            "trend": analysis["trend"],
            "anomalies": anomalies,
            "anomalyCounts": analysis["anomalies"]["counts"],
            "totalBlocks": metadata.get("totalBlocks") or len(pairs),
        })

    except Exception:
        app.logger.exception("分析单本书失败")
        return jsonify({
            "status": "error",
            "message": "服务器分析这本书时出错，请稍后重试。"
        }), 500


@app.route('/api/analyze', methods=['POST'])
def analyze_upload():
    """
    用户上传文本文件，即时计算文学指纹。
    复用与示例书籍完全相同的 src/* 管线，返回与 all_books.json 单本书一致的结构。
    """
    from src.data_loader import get_blocks, detect_language, count_blocks, decode_upload
    from src.pipeline import build_book_data

    if _rate_limited(request.remote_addr or "unknown"):
        return jsonify({
            "status": "error",
            "message": "请求太频繁了，请等半分钟再试。"
        }), 429

    if 'file' not in request.files:
        return jsonify({"status": "error", "message": "请求中未包含文件（字段名应为 file）"}), 400

    file = request.files['file']
    if not file or file.filename == '':
        return jsonify({"status": "error", "message": "未选择文件"}), 400

    # 只收 .txt。判后缀不是「图省事」：Word 文档（.docx 其实是个压缩包）和 PDF 都是二进制，
    # 进了分析管线只会得到一堆无意义的数值。所以这里要明说「怎么办」，而不是只说「不行」——
    # 非技术用户手上多半就是一份 Word 文档，不给出转法他只会以为网站坏了。
    # （前端把文件选择框的 accept 过滤去掉了，所以用户永远能选中自己的文件、看到这句话；
    #  留着 accept=".txt" 的话他的文件在选择框里根本看不见，连这句提示都读不到。）
    if not file.filename.lower().endswith('.txt'):
        return jsonify({
            "status": "error",
            "message": "只支持纯文本文件（.txt）。如果文本在 Word 文档或 PDF 里，请先转成纯文本："
                       "Word 打开后「文件 → 另存为 → 纯文本 (*.txt)」；"
                       "PDF 里的文字需要先复制粘贴进一个 .txt 文件。"
                       "如果它本来就是纯文本，把文件名后缀改成 .txt 也能上传。"
        }), 400

    # 用文件名（不含扩展名）作为该书的基础名；最终键由 _resolve_final_name 决定。
    # 注意两种同名是两种结局：撞书库里的旧书 = 原地替换（旧的被整份换掉，所以响应里
    # 会带 replacedExisting 让界面说出来）；撞内置示例书 = 加「（我的）」另存，示例书不动。
    base_name = Path(file.filename).stem

    try:
        raw_bytes = file.read()
    except Exception:
        app.logger.exception("读取上传文件失败")
        return jsonify({"status": "error", "message": "读取文件失败，请重新选择文件后再试。"}), 400

    # 不假定 UTF-8。以前这一步是 raw.decode('utf-8')，解不开就回一句「请另存为 UTF-8」——
    # 而中文 Windows 的 Word/记事本另存纯文本默认就是 GBK，西文 Windows 另存 ANSI 是 cp1252，
    # 两种都不是 UTF-8。结果是**一份完全正常的英文小说**（正文里带 Word 生成的弯引号）
    # 被编码卡住，用户拿到的提示还在教他改一个他改不动的东西。
    # 现在按候选编码解一遍，具体怎么挑见 src/data_loader.py 的 decode_upload。
    uploaded_text, encoding = decode_upload(raw_bytes)
    if uploaded_text is None:
        return jsonify({
            "status": "error",
            "message": "这个文件读不出文本内容，看起来不是纯文本文件。"
                       "本工具只读 .txt；Word 文档请「另存为 → 纯文本 (*.txt)」，"
                       "PDF 请先把文字复制进一个 .txt 文件。"
        }), 400
    if encoding != 'utf-8':
        app.logger.info("上传文件不是 UTF-8，按 %s 解读", encoding)

    if not uploaded_text.strip():
        return jsonify({
            "status": "error",
            "message": "文件内容为空，请选择包含正文的 .txt 文件。"
        }), 400

    # 与内置书走同一条清洗管线（剥页眉页脚、合并空白、还原缩写）。
    # 不清洗的话，上传书的词数会被页眉噪声撑大、缩写也没还原，
    # 而导出说明里那句「文本经页眉页脚清理与缩写还原后」就成了假话。
    raw_text = clean_text(uploaded_text)
    if not raw_text.strip():
        return jsonify({
            "status": "error",
            "message": "文件清洗后没有剩余正文（可能只有页眉页脚），请换一个文件。"
        }), 400

    # 语言闸门必须排在切块之前：中文没有空格，整本书会被当成 1 个「单词」，
    # 先切块的话用户永远只会看到「文本太短」，永远看不到真正的原因。
    ok, reason, lang_stats = detect_language(raw_text)
    if not ok:
        app.logger.info("上传文本未通过语言闸门: %s", lang_stats)
        return jsonify({"status": "error", "message": reason}), 400

    # 两个长度闸门都先用**算术**算出片段数，再决定要不要真的切块。
    # get_blocks 切一份大文本很贵：2026-10-09 实测 20 MB 正文（约 425 万词）切出 4,244 块
    # 要 2.07 秒、峰值内存 415 MB，而这么大的文本无论切不切都要被上限拒掉——先切后判
    # 等于白付这笔（线上是 2 GB 上下的机器、2 个 worker，415 MB 是实打实的风险）。
    # 顺序仍是「语言闸门 → 长度闸门」，理由见上面 detect_language 那一段。
    word_count = len(raw_text.split())
    n_blocks = count_blocks(word_count, BLOCK_SIZE, OVERLAP)

    if n_blocks == 0:
        return jsonify({
            "status": "error",
            "message": f"文本太短，无法生成指纹（至少需要约 {BLOCK_SIZE} 个英文单词，"
                       f"这份文本约 {word_count} 个）"
        }), 400

    # 上限必须在这里拦，不能等 build_book_data 跑完——那正是要避免的等待。
    # 报错要说清「多少、上限多少、怎么办」，不然用户只会以为服务器坏了。
    if n_blocks > MAX_BLOCKS:
        # 片段之间重叠 9 千词，覆盖到的词数不是「片段数 × 1 万」，而是
        # 最后一块的末尾位置：(n-1) × 步长 + 块长。
        covered = (MAX_BLOCKS - 1) * (BLOCK_SIZE - OVERLAP) + BLOCK_SIZE
        return jsonify({
            "status": "error",
            "message": f"文本太长，单次最多分析约 {MAX_BLOCKS} 个片段（覆盖约 {covered // 10000} "
                       f"万英文单词），这份文本约 {n_blocks} 个片段。"
                       "请拆分文件后分次上传，或先截取要研究的那些章节。"
        }), 400

    blocks = get_blocks(raw_text, block_size=BLOCK_SIZE, overlap=OVERLAP)

    # 前端在勾选「存入我的图书馆」时随 multipart 附 save=1
    want_save = request.form.get("save", "").strip().lower() in {"1", "true", "yes", "on"}

    try:
        book_data = build_book_data(
            blocks,
            text=raw_text,
            # 用与内置书相同的投影模型，上传的书才和它们落在同一坐标系里
            projection=_get_projection_model(),
            block_size=BLOCK_SIZE,
            overlap=OVERLAP,
            include_vectors=want_save,
        )
    except Exception:
        app.logger.exception("上传文本分析失败")
        return jsonify({
            "status": "error",
            "message": "文本分析失败，请确认这是一份英文纯文本后重试。"
        }), 422

    final_name = _resolve_final_name(base_name)
    # 落盘之前先记住这个名字是不是已经有一本了：同名意味着这一存会把旧的整份换掉，
    # 必须让用户知道（以前是彻底静默的，用户以为自己在「新增」）。
    replaced_existing = final_name in _library_keys()
    delete_token = None
    save_error = None

    if want_save:
        # 保存时签发删除令牌：只有拿着它的浏览器能删掉这本书，
        # 挡住跨站页面和脚本随意删别人的书（本机访问不受限，见删除接口）
        delete_token = secrets.token_urlsafe(16)
        book_data["_deleteToken"] = delete_token
        try:
            _save_library_book(final_name, book_data)
        except Exception:
            # 分析已经跑完了（这是整个请求里最贵的一步），落盘失败不该把它丢掉。
            # 原来这里直接返回 500 且不带 data，前端据此提前 return，于是文案
            # 「请改在上方展示区查看」指向一个根本不会出现的书名——用户唯一能做的
            # 就是重传一遍，而磁盘问题没解决必然再失败一次。
            # 现在照样把结果下发（saved=False），前端能照常画图，只是刷新后不留存。
            app.logger.exception("保存到我的图书馆失败")
            save_error = ("分析已经完成、图上可以正常看，但没能存进「我的图书馆」"
                          "（服务器磁盘不可写或已满）。刷新页面后这本书会消失，"
                          "需要留存请先联系管理员腾出磁盘空间，再上传一次。")
        else:
            book_data.pop("_deleteToken", None)

    # 长摘录同样不下发（首屏瘦身那套，见 _public_book_data）——唯一的例外是**没落盘**
    # 的这次分析：那份响应是长摘录在世界上唯一的副本（磁盘上没有），剥了用户就只能
    # 复制到 150 字。落盘的那份由 /api/excerpt 按需取；这份响应里的则由前端直接
    # 从内存里拿（见前端 resolveExcerpt 的「先查本地」）。
    public_data = _strip_internal(book_data)
    if want_save and not save_error:
        public_data = _public_book_data(public_data)

    resp = {
        "status": "success",
        "book": final_name,  # 前端必须以 result.book 作为数据键与展示名
        "saved": bool(want_save and not save_error),
        "data": public_data,
    }
    # 改名要说出来：撞上内置示例书时书名会加「（我的）」后缀，用户上传时按的是原名，
    # 不提一句他会以为书没进来。
    if final_name != sanitize_book_name(base_name):
        resp["renamedFrom"] = sanitize_book_name(base_name)
    # 覆盖也要说出来，而且要说得比改名更重：这次保存把同名旧书整份换掉了，
    # 上一版的分析已经不存在，用户可能正指望它。
    if want_save and replaced_existing:
        resp["replacedExisting"] = True
    # 反向的那个坑：这次没勾选保存，但书名和书库里已有的一本重名。屏幕上显示的是
    # 这一次的分析结果，磁盘上留着的还是那一本旧的——两个「同一本书」不同内容，
    # 不说清楚，用户会以为书库里那本已经更新了。
    if not want_save and final_name in _library_keys():
        resp["shadowsExisting"] = True
    if save_error:
        resp["warning"] = save_error
    if want_save and not save_error:
        resp["savedName"] = final_name
        resp["deleteToken"] = delete_token
        resp["storage"] = "local-library" if _is_local_host(request.host) else "hosted-library"
    return jsonify(resp)

@app.route('/api/books', methods=['GET'])
def list_books():
    """
    列出所有可用的书籍
    """
    try:
        _ensure_demo_data()
        books = []
        # 检查data/raw目录中的文本文件
        if DATA_DIR.exists():
            for book_file in DATA_DIR.glob("*.txt"):
                books.append({
                    "id": book_file.stem,
                    "name": book_file.stem,
                    "filename": book_file.name,
                    "source": "builtin"
                })

        # 如果没有找到文件，返回示例书籍
        if not books:
            books = [
                {"id": "The Adventures of Tom Sawyer", "name": "The Adventures of Tom Sawyer", "filename": "The Adventures of Tom Sawyer.txt", "source": "builtin"},
                {"id": "The Call of the Wild", "name": "The Call of the Wild", "filename": "The Call of the Wild.txt", "source": "builtin"},
                {"id": "White Fang", "name": "White Fang", "filename": "White Fang.txt", "source": "builtin"}
            ]

        # 追加这个访客自己书架上保存的书（source=library，前端据此显示删除按钮）。
        # 只看自己那一格：别人的书不进这份列表，前端也就永远不会给出「删除」按钮。
        shelf = _shelf_dir()
        if shelf.exists():
            for lib_file in sorted(shelf.glob("*.json")):
                books.append({
                    "id": lib_file.stem,
                    "name": lib_file.stem,
                    "filename": lib_file.name,
                    "source": "library"
                })

        resp = jsonify({
            "status": "success",
            "books": books,
            # 让页面能看见自己的书架编号——cookie 是 HttpOnly，JS 读不到
            # document.cookie，这是全站唯一一条把编号交给前端的路（「书架编号」
            # 弹窗靠它显示，换设备时用户才有东西可抄）。响应本来就按 cookie 变化，
            # 所以新字段不改变缓存语义（下面那行 Vary 是给它兜底的那一条）。
            "shelfCode": _current_visitor(),
        })
        resp.headers["Vary"] = "Cookie"  # 书单因人而异
        # 第二十批加：这条响应现在带着书架编号，而「认领别人的编号」成功后是
        # location.reload()——只要浏览器拿了一次启发式缓存（这条响应没有 ETag 之类的
        # 校验器），刷新后页面就会显示**上一个**编号和上一个书单，看起来像没切成功，
        # 而且是间歇性的、极难查。no-store 比 no-cache 更贴切：它本来也不该被复用。
        resp.headers["Cache-Control"] = "no-store"
        return resp

    except Exception:
        app.logger.exception("列出书籍失败")
        return jsonify({
            "status": "error",
            "message": "服务器读取书籍列表时出错，请稍后重试。"
        }), 500


@app.route('/api/library/<book_name>', methods=['DELETE'])
def delete_library_book(book_name):
    """
    从「我的图书馆」删除一本书。

    - 内置示例书不可删除（400）；
    - 书库中不存在返回 404（**别人的书也不在你书架里，同样是 404**）；
    - 需要带上保存时签发的删除令牌（请求头 X-Delete-Token），只有存过这本书的
      浏览器才拿得到，避免任何人随手删别人的书。本机默认同样要令牌——
      Host 头是客户端说了算的，拿它当授权等于没授权；确有需要时可用
      ALLOW_LOCAL_DELETE=1 启动服务显式放行。
    """
    name = sanitize_book_name(book_name)
    if name in _builtin_keys():
        return jsonify({"status": "error", "message": "内置示例书不能删除。"}), 400

    # 只在自己书架上找：别人的书不在这个目录里，于是天然是 404——
    # 「看不见」和「删不掉」在这里是同一件事，不需要两套判断。
    target = _shelf_dir() / f"{name}.json"
    if not target.exists():
        return jsonify({"status": "error", "message": f"「我的图书馆」中不存在《{name}》。"}), 404

    exempt = _local_delete_allowed() and _is_local_host(request.host)
    if not exempt:
        stored_token = None
        try:
            with open(target, "r", encoding="utf-8") as f:
                stored_token = json.load(f).get("_deleteToken")
        except Exception:
            app.logger.warning("读取删除令牌失败: %s", target.name)

        supplied = request.headers.get("X-Delete-Token", "")
        if not stored_token or not secrets.compare_digest(str(stored_token), supplied):
            if _is_local_host(request.host):
                return jsonify({
                    "status": "error",
                    "message": (
                        "无法删除：本机删除也需要保存时签发的令牌（存在本浏览器里）。"
                        "若已清除浏览器数据，可用 ALLOW_LOCAL_DELETE=1 启动服务，"
                        "或直接在 data/library/ 里找到并删掉那个同名的 .json"
                        "（每个浏览器一个子目录，逐个找一下）。"
                    )
                }), 403
            return jsonify({
                "status": "error",
                "message": "无法删除：只有保存这本书的浏览器可以删除它。"
            }), 403

    try:
        target.unlink()
    except Exception:
        app.logger.exception("删除书库文件失败")
        return jsonify({"status": "error", "message": f"删除《{name}》失败，请稍后重试。"}), 500

    # 删掉最后一本时，把这一格空目录也收掉。rmdir 只在空目录上成功，所以
    # 「还有书就一律不动」是天然成立的，不需要额外判断。删不掉（权限等）只是
    # 留下一个空目录，不值得为此报错——线上另有一条手动清理命令（见 README）。
    try:
        _shelf_dir().rmdir()
    except OSError:
        pass

    return jsonify({"status": "success", "message": f"已从「我的图书馆」删除《{name}》。"})


# ---------------------------------------------------------------------------
# 书架找回：把另一个浏览器上的编号认领过来（换设备 / 清了浏览器数据的出口）
#
# 这是全站第一条「客户端字符串 → 身份」的入口（此前身份只有 cookie 一条路），
# 所以四道门缺一不可，且**任何一步失败都不许动现有身份**——g.visitor_id 改错
# 等于把用户当下的书架换掉。
# ---------------------------------------------------------------------------
_SHELF_CLAIM_HEADER = "X-Shelf-Claim"


@app.route('/api/shelf/claim', methods=['POST'])
def claim_shelf():
    """
    认领一个书架编号：此后这个浏览器就用那个编号。

    1) 必须带自定义请求头 X-Shelf-Claim: 1。防的是「登录型 CSRF」——跨站的表单
       POST 也能让浏览器接受响应里的 Set-Cookie，被诱导的用户此后上传的书会直接
       落进别人的书架。简单表单发不出自定义头；跨站 fetch 加头又必然触发预检，
       而 CORS 白名单只放行本机。
    2) 编号必须满足 _VISITOR_RE：它接下来会被拿去拼路径，校验必须在拼路径之前
       （与 cookie 那道校验同一条正则、同一个理由）。
    3) 限流。单独一个桶，不跟 /api/analyze 抢——否则几次认领会把上传额度挤掉。
    4) 那个编号下真的有一本书才算「找到」。**绝不 mkdir**：目录不存在与目录空着
       同待遇（用户视角都是「没有书」），否则随机编号能把服务器刷出一地空目录。
    """
    if request.headers.get(_SHELF_CLAIM_HEADER) != "1":
        return jsonify({
            "status": "error",
            "message": "请求缺少必要的标记，请刷新页面后重试。"
        }), 403

    payload = request.get_json(silent=True) or {}
    code = str(payload.get("code") or "").strip()

    if not _VISITOR_RE.match(code):
        return jsonify({
            "status": "error",
            "message": "编号格式不对。请照抄那串字符（区分大小写，没有空格）。"
        }), 400

    if _rate_limited("claim:" + (request.remote_addr or "unknown")):
        return jsonify({
            "status": "error",
            "message": "尝试太频繁，请等半分钟再试。"
        }), 429

    if not _library_keys(code):
        return jsonify({
            "status": "error",
            "message": "这个编号下没有书架。请检查有没有抄错（区分大小写）。"
        }), 404

    # 身份交给 after_request 的 _hand_out_visitor_cookie 统一下发：cookie 属性
    # （HttpOnly / SameSite / 有效期）只写一份，日后不会和第一次发牌时漂移。
    g.visitor_id = code
    g.visitor_cookie_new = True

    # 连删除令牌一起交回：只交编号的话，找回后能看不能删（✕ 会 403「只有保存这本
    # 书的浏览器可以删除它」），是个死胡同；编号本身就是完整凭据（知道编号就能看到
    # 全部内容），令牌不扩大实际暴露面，只是把「找回」补完整。
    # 代价：要把每本书的 JSON 读一遍（一本最多约 2.8 MB），书多时会慢几百毫秒。
    books = []
    for path in sorted(_shelf_dir(code).glob("*.json")):
        token = None
        try:
            with open(path, "r", encoding="utf-8") as f:
                token = json.load(f).get("_deleteToken")
        except Exception:
            app.logger.warning("认领书架时读取删除令牌失败: %s", path.name)
        if token:
            books.append({"name": path.stem, "deleteToken": str(token)})

    resp = jsonify({
        "status": "success",
        "shelfCode": code,
        "books": books,
    })
    resp.headers["Cache-Control"] = "no-store"  # 切身份的响应绝不能进任何缓存
    return resp


def _warm_up_analysis_deps():
    """
    把第一次分析要用到的东西在启动时就装好，而不是留给第一个上传的人。

    2026-10-09 实测：`import nltk` 本身要 3.9 秒（Windows 开发机；服务器上量级相近），
    而这一步发生在「第一次调用 detect_language」的时候——src/data_loader.py 里
    stopwords 是延迟导入的。服务每次 systemctl restart 都要重新付这笔，付的人是那一轮
    第一个上传文本的用户：他看到「正在分析…」多转四秒，而那一次分析其实还没开始。

    只预热「读本地文件/加载模块」这部分，**不碰** _ensure_nltk_data()：那条路在本地
    缺数据时会去 nltk.download()，放到启动阶段会把 systemctl restart 卡在网络超时上。

    放在模块层：gunicorn 的每个 worker 各自付一次（两个 worker 并行，开销量级不变），
    而测试进程本来就要 import nltk（tests/test_data_loader.py 顶部就导入了 sent_tokenize），
    不增加任何成本。
    """
    try:
        from nltk.tokenize import sent_tokenize  # noqa: F401  先导，避免第一次切句时现装
        from src.metrics import function_word_matrix  # noqa: F401  这个模块顶层就 import nltk
        from src.data_loader import _english_stopwords
        _english_stopwords()
    except Exception:
        # 预热失败不该拦住服务：后面真正用到时会自己再试一次，最坏也不过是慢一点
        app.logger.exception("预热分析依赖失败（不影响功能，只是第一个请求会慢一些）")


_warm_up_analysis_deps()


if __name__ == '__main__':
    # 注意：横幅只用 ASCII 符号 + 中文，不用 emoji/生僻 Unicode——
    # Windows 中文控制台输出被重定向时退化为 GBK，遇 emoji 直接 print 会抛
    # UnicodeEncodeError 导致服务器启动崩溃；交互控制台虽无碍，重定向场景必须安全。
    print("=" * 60)
    print("文印 - 文学指纹分析系统 API 服务器")
    print("=" * 60)
    print(f"项目目录: {BASE_DIR}")
    print(f"数据目录: {DATA_DIR}")
    print(f"静态文件目录: {STATIC_DIR}")
    print("\n[API] 可用接口:")
    print("  GET /                         - 主页面")
    print("  GET /visualization            - D3.js可视化界面")
    print("  GET /api/fingerprint-data     - 获取所有书籍数据")
    print("  GET /api/book/<name>          - 获取特定书籍数据")
    print("  GET /api/excerpt/<name>?block=N - 按需取某个片段的长摘录")
    print("  GET /favicon.ico              - 站点图标")
    print("  GET /api/books                - 列出所有书籍（含「我的图书馆」）")
    print("  DELETE /api/library/<name>    - 删除「我的图书馆」中的一本书")
    print("  POST /api/shelf/claim         - 用书架编号找回「我的图书馆」（换设备）")
    # 端口优先读环境变量 PORT（Render 等托管平台会注入），本地默认 5000
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"

    print("\n[RUN] 服务器运行在:")
    print(f"  http://localhost:{port}")
    print(f"  http://127.0.0.1:{port}")
    print("\n[OPEN] 直接访问可视化:")
    print(f"  http://localhost:{port}/visualization")
    print("\n[STOP] 按 CTRL+C 停止服务器")
    print("=" * 60)

    host = os.environ.get("HOST", "127.0.0.1")
    app.run(host=host, port=port, debug=debug)