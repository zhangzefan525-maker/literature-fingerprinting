#!/usr/bin/env python3
"""
文印项目 - 数据API服务器
为D3.js可视化提供JSON数据接口
"""

from flask import Flask, jsonify, request, send_from_directory, send_file
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge
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

# 限制上传文件大小，防止超大文件拖垮服务器
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB


@app.errorhandler(RequestEntityTooLarge)
def handle_request_too_large(_error):
    """将 Flask 默认 HTML 413 转为前端可解析的 JSON。"""
    return jsonify({
        "status": "error",
        "message": "文件太大，单个文件不能超过 50 MB。请压缩内容或选择较小的 .txt 文件。"
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

# 演示数据生成状态（懒加载：首次请求时若 all_books.json 缺失则自动生成一次）
_demo_data_ready = False


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


def _library_keys():
    """当前「我的图书馆」已保存的书名集合（每次现读磁盘，避免缓存过期）。"""
    return {p.stem for p in LIBRARY_DIR.glob("*.json")}


def _resolve_final_name(base):
    """决定上传文件最终采用的书名（= 前端数据键 = 磁盘文件名）。

    优先级：
    1) 书库已存在同名 → 沿用同名（视为「替换更新」，不产生重复副本）；
    2) 撞上内置示例书名 → 加后缀「（我的）」，再撞则递增 (2)、(3)…；
    3) 其余情况 → 原样。内置示例书永不被覆盖。
    """
    base = sanitize_book_name(base)
    if base in _library_keys():
        return base
    if base in _builtin_keys():
        candidate = f"{base}（我的）"
        taken = _library_keys() | _builtin_keys()
        n = 2
        while candidate in taken:
            candidate = f"{base}（我的）({n})"
            n += 1
        return candidate
    return base


def _save_library_book(name, book_data):
    """把一本书的指纹数据写入 data/library/（JSON，UTF-8 无转义，保留可读）。"""
    path = LIBRARY_DIR / f"{sanitize_book_name(name)}.json"
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


# ---------------------------------------------------------------------------
# 语料缓存：每次请求都重新解析 700 KB JSON 太浪费。
# 按「源文件指纹」缓存，all_books.json 或任一书库文件的修改时间/大小变了才重读。
# ---------------------------------------------------------------------------
_corpus_cache = {"key": None, "data": None, "message": None}


def _library_stamp():
    """书库指纹：文件名 + 修改时间 + 大小。新增、删除、覆盖都能检出。"""
    stamp = []
    for path in sorted(LIBRARY_DIR.glob("*.json")):
        try:
            stat = path.stat()
        except OSError:
            continue
        stamp.append((path.name, stat.st_mtime_ns, stat.st_size))
    return tuple(stamp)


def _corpus_stamp(target_file):
    try:
        stat = target_file.stat()
    except OSError:
        return None
    return (stat.st_mtime_ns, stat.st_size, _library_stamp())


def _load_corpus():
    """
    读取（并缓存）全量语料：内置示例书 + 「我的图书馆」。

    Returns:
        (dict | None, str | None): (语料字典, 给前端的来源说明)；取不到数据时返回 (None, None)
    """
    processed_dir = BASE_DIR / "data" / "processed"
    target_file = processed_dir / "all_books.json"
    stamp = _corpus_stamp(target_file)

    if stamp is not None:
        if _corpus_cache["key"] == stamp and _corpus_cache["data"] is not None:
            return _corpus_cache["data"], _corpus_cache["message"]

        with open(target_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        # 合并「我的图书馆」中用户勾选保存的书籍（不与内置键冲突、不覆盖内置；
        # 单文件损坏只跳过，不影响其它书）
        if LIBRARY_DIR.exists():
            for lib_file in sorted(LIBRARY_DIR.glob("*.json")):
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
        _corpus_cache.update(key=stamp, data=data, message=message)
        return data, message

    # 找不到汇总文件时，退回「最新的单书文件」（保持原有后备逻辑）
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


def _ensure_demo_data():
    """若预处理的示例数据不存在，则基于 data/raw/ 自动生成一次（保证全新克隆开箱即用）。"""
    global _demo_data_ready
    if _demo_data_ready:
        return True

    target = BASE_DIR / "data" / "processed" / "all_books.json"
    if target.exists():
        _demo_data_ready = True
        return True

    raw_dir = BASE_DIR / "data" / "raw"
    if not raw_dir.exists() or not list(raw_dir.glob("*.txt")):
        return False

    try:
        from generate_data import process_all_books
        process_all_books()
        _demo_data_ready = target.exists()
        # 刚生成完，投影模型文件这时才出现，让缓存重新去读
        _projection_model.update(loaded=False, model=None)
        _corpus_cache.update(key=None, data=None, message=None)
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

        return jsonify({
            "status": "success",
            "message": message,
            "data": data
        })

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
                "data": all_data[book_name]
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
    from src.data_loader import get_blocks
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

    if not file.filename.lower().endswith('.txt'):
        return jsonify({"status": "error", "message": "仅支持 .txt 文本文件"}), 400

    # 用文件名（不含扩展名）作为该书的基础名；最终键由 _resolve_final_name 决定
    # （内置同名加「（我的）」，书库同名视为替换更新）
    base_name = Path(file.filename).stem

    try:
        uploaded_text = file.read().decode('utf-8')
    except UnicodeDecodeError:
        return jsonify({
            "status": "error",
            "message": "文件不是有效的 UTF-8 编码。请将文本另存为 UTF-8 后重试。"
        }), 400
    except Exception:
        app.logger.exception("读取上传文件失败")
        return jsonify({"status": "error", "message": "读取文件失败，请重新选择文件后再试。"}), 400

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

    blocks = get_blocks(raw_text, block_size=BLOCK_SIZE, overlap=OVERLAP)
    if not blocks:
        return jsonify({
            "status": "error",
            "message": f"文本太短，无法生成指纹（至少需要约 {BLOCK_SIZE} 个单词）"
        }), 400

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
            "message": "文本分析失败，请确认文件是英文 UTF-8 纯文本后重试。"
        }), 422

    final_name = _resolve_final_name(base_name)
    delete_token = None

    if want_save:
        # 保存时签发删除令牌：只有拿着它的浏览器能删掉这本书，
        # 挡住跨站页面和脚本随意删别人的书（本机访问不受限，见删除接口）
        delete_token = secrets.token_urlsafe(16)
        book_data["_deleteToken"] = delete_token
        try:
            _save_library_book(final_name, book_data)
        except Exception:
            app.logger.exception("保存到我的图书馆失败")
            return jsonify({
                "status": "error",
                "message": "分析已完成，但写入「我的图书馆」失败（服务器磁盘不可写？），本次结果未留存，请改在上方展示区查看。"
            }), 500
        book_data.pop("_deleteToken", None)

    resp = {
        "status": "success",
        "book": final_name,  # 前端必须以 result.book 作为数据键与展示名
        "saved": bool(want_save),
        "data": _strip_internal(book_data),
    }
    if want_save:
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

        # 追加「我的图书馆」中保存的书（source=library，前端据此显示删除按钮）
        if LIBRARY_DIR.exists():
            for lib_file in sorted(LIBRARY_DIR.glob("*.json")):
                books.append({
                    "id": lib_file.stem,
                    "name": lib_file.stem,
                    "filename": lib_file.name,
                    "source": "library"
                })

        return jsonify({
            "status": "success",
            "books": books
        })

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
    - 书库中不存在返回 404；
    - 需要带上保存时签发的删除令牌（请求头 X-Delete-Token），只有存过这本书的
      浏览器才拿得到，避免任何人随手删别人的书。本机默认同样要令牌——
      Host 头是客户端说了算的，拿它当授权等于没授权；确有需要时可用
      ALLOW_LOCAL_DELETE=1 启动服务显式放行。
    """
    name = sanitize_book_name(book_name)
    if name in _builtin_keys():
        return jsonify({"status": "error", "message": "内置示例书不能删除。"}), 400

    target = LIBRARY_DIR / f"{name}.json"
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
                        f"或直接删除 data/library/{name}.json。"
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

    return jsonify({"status": "success", "message": f"已从「我的图书馆」删除《{name}》。"})

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
    print("  GET /api/books                - 列出所有书籍（含「我的图书馆」）")
    print("  DELETE /api/library/<name>    - 删除「我的图书馆」中的一本书")
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