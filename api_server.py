#!/usr/bin/env python3
"""
文印项目 - 数据API服务器
为D3.js可视化提供JSON数据接口
"""

from flask import Flask, jsonify, request, send_from_directory, send_file
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge
import json
import os
import re
from pathlib import Path

# 初始化Flask应用
app = Flask(__name__, static_folder='static')
CORS(app)  # 允许跨域请求

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
        except Exception as e:
            return f"错误: 找不到可视化页面文件。请确保 d3_visualization.html 在项目根目录或 static 文件夹中。<br>错误详情: {str(e)}", 404

# api_server.py

@app.route('/api/fingerprint-data', methods=['GET'])
def get_fingerprint_data():
    """
    获取所有书籍的指纹数据
    """
    try:
        _ensure_demo_data()
        processed_dir = BASE_DIR / "data" / "processed"

        # --- 修改开始 ---
        # 明确指定我们要加载 all_books.json，而不是任何最新的 json 文件
        target_file = processed_dir / "all_books.json"
        
        if target_file.exists():
            with open(target_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            # 合并「我的图书馆」中用户勾选保存的书籍（不与内置键冲突、不覆盖内置；
            # 单文件损坏只跳过，不影响其它书）。
            if LIBRARY_DIR.exists():
                for lib_file in sorted(LIBRARY_DIR.glob("*.json")):
                    if lib_file.stem in data:
                        continue
                    try:
                        with open(lib_file, "r", encoding="utf-8") as lf:
                            payload = json.load(lf)
                        if isinstance(payload, dict) and "metadata" in payload:
                            data[lib_file.stem] = payload
                    except Exception:
                        app.logger.warning("跳过无法读取的书库文件: %s", lib_file.name)

            return jsonify({
                "status": "success",
                "message": f"成功加载数据文件: {target_file.name}",
                "data": data
            })
        # --- 修改结束 ---
        
        # 如果找不到 all_books.json，尝试查找其他 json 文件作为备选（保持原有逻辑作为后备）
        elif processed_dir.exists():
            data_files = list(processed_dir.glob("*.json"))
            
            if data_files:
                latest_file = max(data_files, key=os.path.getctime)
                with open(latest_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                
                return jsonify({
                    "status": "success",
                    "message": f"未找到汇总文件，加载了最新的单书文件: {latest_file.name}",
                    "data": data
                })

        # 没有真实数据时，返回明确错误并引导用户生成/上传，不再返回随机模拟数据
        # （避免用户把随机数误当成自己的分析结果）
        return jsonify({
            "status": "error",
            "message": "暂无可用书籍数据。请先运行 python generate_data.py 生成示例数据，"
                       "或通过上传接口 /api/analyze 上传自己的文本。"
        }), 404

    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        }), 500

@app.route('/api/book/<book_name>', methods=['GET'])
def get_book_data(book_name):
    """
    获取特定书籍的真实指纹数据
    """
    try:
        processed_dir = BASE_DIR / "data" / "processed"
        target_file = processed_dir / "all_books.json"

        if target_file.exists():
            with open(target_file, 'r', encoding='utf-8') as f:
                all_data = json.load(f)

            if book_name in all_data:
                return jsonify({
                    "status": "success",
                    "book": book_name,
                    "data": all_data[book_name]
                })

        return jsonify({
            "status": "error",
            "message": f"书籍 '{book_name}' 不存在。请先运行 python generate_data.py 生成数据"
        }), 404

    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        }), 500

@app.route('/api/analyze', methods=['POST'])
def analyze_upload():
    """
    用户上传文本文件，即时计算文学指纹。
    复用与示例书籍完全相同的 src/* 管线，返回与 all_books.json 单本书一致的结构。
    """
    from src.data_loader import get_blocks
    from src.pipeline import build_book_data

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
        raw_text = file.read().decode('utf-8')
    except UnicodeDecodeError:
        return jsonify({
            "status": "error",
            "message": "文件不是有效的 UTF-8 编码。请将文本另存为 UTF-8 后重试。"
        }), 400
    except Exception as e:
        return jsonify({"status": "error", "message": f"读取文件失败: {e}"}), 400

    if not raw_text.strip():
        return jsonify({
            "status": "error",
            "message": "文件内容为空，请选择包含正文的 .txt 文件。"
        }), 400

    blocks = get_blocks(raw_text, block_size=10000, overlap=9000)
    if not blocks:
        return jsonify({
            "status": "error",
            "message": "文本太短，无法生成指纹（至少需要约 10000 个单词）"
        }), 400

    try:
        book_data = build_book_data(blocks)
    except Exception as e:
        app.logger.exception("上传文本分析失败")
        return jsonify({
            "status": "error",
            "message": "文本分析失败，请确认文件是英文 UTF-8 纯文本后重试。"
        }), 422

    final_name = _resolve_final_name(base_name)
    # 前端在勾选「存入我的图书馆」时随 multipart 附 save=1
    want_save = request.form.get("save", "").strip().lower() in {"1", "true", "yes", "on"}

    if want_save:
        try:
            _save_library_book(final_name, book_data)
        except Exception as e:
            app.logger.exception("保存到我的图书馆失败")
            return jsonify({
                "status": "error",
                "message": "分析已完成，但写入「我的图书馆」失败（服务器磁盘不可写？），本次结果未留存，请改在上方展示区查看。"
            }), 500

    resp = {
        "status": "success",
        "book": final_name,  # 前端必须以 result.book 作为数据键与展示名
        "saved": bool(want_save),
        "data": book_data,
    }
    if want_save:
        resp["savedName"] = final_name
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
        
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        }), 500


@app.route('/api/library/<book_name>', methods=['DELETE'])
def delete_library_book(book_name):
    """
    从「我的图书馆」删除一本书。内置示例书不可删除（返回 400），
    书库中不存在返回 404。
    """
    name = sanitize_book_name(book_name)
    if name in _builtin_keys():
        return jsonify({"status": "error", "message": "内置示例书不能删除。"}), 400

    target = LIBRARY_DIR / f"{name}.json"
    if not target.exists():
        return jsonify({"status": "error", "message": f"「我的图书馆」中不存在《{name}》。"}), 404

    try:
        target.unlink()
    except Exception as e:
        return jsonify({"status": "error", "message": f"删除《{name}》失败: {e}"}), 500

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