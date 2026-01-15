#!/usr/bin/env python3
"""
文印项目 - 数据API服务器
为D3.js可视化提供JSON数据接口
"""

from flask import Flask, jsonify, send_from_directory, send_file
from flask_cors import CORS
import json
import os
from pathlib import Path

# 初始化Flask应用
app = Flask(__name__, static_folder='static')
CORS(app)  # 允许跨域请求

# 配置
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data" / "raw"
STATIC_DIR = BASE_DIR / "static"

# 确保目录存在
DATA_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR.mkdir(parents=True, exist_ok=True)

@app.route('/')
def index():
    """
    主页面
    """
    return """
    <!DOCTYPE html>
    <html>
    <head>
        <title>文印 - 文学指纹分析系统 API</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            h1 { color: #333; }
            .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px; }
            code { background: #e0e0e0; padding: 2px 5px; border-radius: 3px; }
            .btn { display: inline-block; background: #3498db; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
            .btn:hover { background: #2980b9; }
        </style>
    </head>
    <body>
        <h1>文印 - 文学指纹分析系统 API</h1>
        <p>基于 Python 和 Flask 的数据接口服务器</p>
        
        <a class="btn" href="/visualization" target="_blank">🎨 打开 D3.js 可视化界面</a>
        
        <div class="endpoint">
            <h3>📚 获取所有书籍数据</h3>
            <code>GET /api/fingerprint-data</code>
            <p>返回所有书籍的完整指纹数据</p>
            <a href="/api/fingerprint-data" target="_blank">测试接口</a>
        </div>
        
        <div class="endpoint">
            <h3>📖 获取特定书籍数据</h3>
            <code>GET /api/book/&lt;book_name&gt;</code>
            <p>返回指定书籍的指纹数据</p>
            <p>示例: <a href="/api/book/The%20Adventures%20of%20Tom%20Sawyer" target="_blank">/api/book/The Adventures of Tom Sawyer</a></p>
        </div>
        
        <div class="endpoint">
            <h3>📋 列出所有书籍</h3>
            <code>GET /api/books</code>
            <p>返回可用书籍列表</p>
            <a href="/api/books" target="_blank">测试接口</a>
        </div>
        
        <p style="margin-top: 30px; color: #666;">
            &copy; 2024 文印分析系统 | 技术支持: Python, Flask, D3.js
        </p>
    </body>
    </html>
    """

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
            # 排除 statistics.json，防止加载错误
            data_files = [f for f in data_files if "statistics" not in f.name]
            
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
    获取特定书籍的数据
    """
    try:
        # 这里应该计算真实数据
        # 为了演示，返回模拟数据
        sample_data = generate_sample_data()
        
        if book_name in sample_data:
            return jsonify({
                "status": "success",
                "book": book_name,
                "data": sample_data[book_name]
            })
        else:
            return jsonify({
                "status": "error",
                "message": f"书籍 '{book_name}' 不存在"
            }), 404
            
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        }), 500
@app.route('/simple-viz')
def simple_viz():
    """
    简化版可视化页面
    """
    try:
        return send_file('simple_viz.html')
    except:
        # 返回内联HTML
        return '''
        <!DOCTYPE html>
        <html>
        <head><title>简化版可视化</title></head>
        <body>
            <h1>简化版可视化</h1>
            <p><a href="/visualization">返回完整版</a></p>
            <p><a href="/test">测试页面</a></p>
        </body>
        </html>
        '''

@app.route('/test')
def test_page():
    """
    测试页面
    """
    try:
        return send_file('test.html')
    except:
        return '''
        <!DOCTYPE html>
        <html>
        <head><title>测试页面</title></head>
        <body>
            <h1>测试页面</h1>
            <p>test.html 文件不存在，请在项目根目录创建该文件。</p>
        </body>
        </html>
        '''


@app.route('/api/books', methods=['GET'])
def list_books():
    """
    列出所有可用的书籍
    """
    try:
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
    print("\n🌐 服务器运行在:")
    print("  http://localhost:5000")
    print("  http://127.0.0.1:5000")
    print("\n🎨 直接访问可视化:")
    print("  http://localhost:5000/visualization")
    print("\n🔄 按 CTRL+C 停止服务器")
    print("=" * 60)
    
    app.run(host='0.0.0.0', port=5000, debug=True)