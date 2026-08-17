#!/usr/bin/env python3
"""
文印项目 - 数据API服务器
为D3.js可视化提供JSON数据接口
"""

from flask import Flask, jsonify, request, send_from_directory, send_file
from flask_cors import CORS
import json
import os
from pathlib import Path

# 初始化Flask应用
app = Flask(__name__, static_folder='static')
CORS(app)  # 允许跨域请求

# 限制上传文件大小，防止超大文件拖垮服务器
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB

# 配置
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data" / "raw"
STATIC_DIR = BASE_DIR / "static"

# 确保目录存在
DATA_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR.mkdir(parents=True, exist_ok=True)

# 演示数据生成状态（懒加载：首次请求时若 all_books.json 缺失则自动生成一次）
_demo_data_ready = False


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

        # 如果没有真实数据，返回模拟数据
        return jsonify({
            "status": "success",
            "message": "使用模拟数据进行演示",
            "data": generate_sample_data()
        })
        
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

    # 用文件名（不含扩展名）作为该书在可视化中的标识
    book_name = Path(file.filename).stem

    try:
        raw_text = file.read().decode('utf-8', errors='ignore')
    except Exception as e:
        return jsonify({"status": "error", "message": f"读取文件失败: {e}"}), 400

    blocks = get_blocks(raw_text, block_size=10000, overlap=9000)
    if not blocks:
        return jsonify({
            "status": "error",
            "message": "文本太短，无法生成指纹（至少需要约 10000 个单词）"
        }), 400

    book_data = build_book_data(blocks)
    return jsonify({"status": "success", "book": book_name, "data": book_data})

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
                    "filename": book_file.name
                })
        
        # 如果没有找到文件，返回示例书籍
        if not books:
            books = [
                {"id": "The Adventures of Tom Sawyer", "name": "The Adventures of Tom Sawyer", "filename": "The Adventures of Tom Sawyer.txt"},
                {"id": "The Call of the Wild", "name": "The Call of the Wild", "filename": "The Call of the Wild.txt"},
                {"id": "White Fang", "name": "White Fang", "filename": "White Fang.txt"}
            ]
        
        return jsonify({
            "status": "success",
            "books": books
        })
        
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        }), 500

def generate_sample_data():
    """
    生成示例数据用于演示
    """
    import random
    import math
    
    data = {}
    
    # 三本书的示例数据
    books = ["The Adventures of Tom Sawyer", "The Call of the Wild", "White Fang"]
    
    for book in books:
        # 每本书生成不同数量的数据点
        if "Tom Sawyer" in book:
            n_points = 64
            base_value_sl = 19.0  # 平均句长
            base_value_si = 0.06  # Simpson指数
        elif "Call" in book:
            n_points = 23
            base_value_sl = 16.0
            base_value_si = 0.08
        else:
            n_points = 65
            base_value_sl = 17.0
            base_value_si = 0.07
        
        # 生成数据
        sentence_length = []
        simpson_index = []
        hapax_legomena = []
        function_words = []
        
        for i in range(n_points):
            # 添加一些随机波动和趋势
            trend = math.sin(i * 0.1) * 0.5
            
            sentence_length.append({
                "block": i,
                "value": round(base_value_sl + trend + random.uniform(-1, 1), 2),
                "keywords": ["example", "text", "analysis"],
                "preview": f"This is example text block {i} from {book}. It shows how the visualization works.",
                "wordCount": random.randint(8000, 12000)
            })
            
            simpson_index.append({
                "block": i,
                "value": round(base_value_si + trend * 0.01 + random.uniform(-0.01, 0.01), 4),
                "keywords": ["vocabulary", "richness", "measure"],
                "preview": f"This is example text block {i} from {book}. It shows how the visualization works.",
                "wordCount": random.randint(8000, 12000)
            })
            
            hapax_legomena.append({
                "block": i,
                "value": round(80 + trend * 5 + random.uniform(-10, 10), 1),
                "keywords": ["unique", "words", "count"],
                "preview": f"This is example text block {i} from {book}. It shows how the visualization works.",
                "wordCount": random.randint(8000, 12000)
            })
            
            function_words.append({
                "block": i,
                "value": round(trend * 0.5 + random.uniform(-0.5, 0.5), 3),
                "keywords": ["function", "words", "pca"],
                "preview": f"This is example text block {i} from {book}. It shows how the visualization works.",
                "wordCount": random.randint(8000, 12000)
            })
        
        data[book] = {
            "sentenceLength": sentence_length,
            "simpsonIndex": simpson_index,
            "hapaxLegomena": hapax_legomena,
            "functionWords": function_words,
            "metadata": {
                "totalBlocks": n_points,
                "avgSentenceLength": round(sum([d["value"] for d in sentence_length]) / n_points, 2),
                "avgSimpsonIndex": round(sum([d["value"] for d in simpson_index]) / n_points, 4)
            }
        }
    
    return data

if __name__ == '__main__':
    print("=" * 60)
    print("文印 - 文学指纹分析系统 API 服务器")
    print("=" * 60)
    print(f"项目目录: {BASE_DIR}")
    print(f"数据目录: {DATA_DIR}")
    print(f"静态文件目录: {STATIC_DIR}")
    print("\n📡 可用接口:")
    print("  GET /                         - 主页面")
    print("  GET /visualization            - D3.js可视化界面")
    print("  GET /api/fingerprint-data     - 获取所有书籍数据")
    print("  GET /api/book/<name>          - 获取特定书籍数据")
    print("  GET /api/books                - 列出所有书籍")
    # 端口优先读环境变量 PORT（Render 等托管平台会注入），本地默认 5000
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"

    print("\n🌐 服务器运行在:")
    print(f"  http://localhost:{port}")
    print(f"  http://127.0.0.1:{port}")
    print("\n🎨 直接访问可视化:")
    print(f"  http://localhost:{port}/visualization")
    print("\n🔄 按 CTRL+C 停止服务器")
    print("=" * 60)

    app.run(host='0.0.0.0', port=port, debug=debug)