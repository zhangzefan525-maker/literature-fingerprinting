#!/usr/bin/env python3
"""
文印项目 - 数据生成脚本
批量处理所有书籍并生成JSON数据
"""

import json
import sys
from pathlib import Path
from src.data_loader import load_clean_text, get_blocks
from src.metrics import (
    calc_sentence_length,
    calc_simpsons_index,
    calc_hapax_legomena,
    get_pca_coordinates,
    get_top_keywords
)

def process_all_books():
    """
    处理所有书籍并生成完整数据
    """
    BASE_DIR = Path(__file__).parent
    DATA_DIR = BASE_DIR / "data" / "raw"
    OUTPUT_DIR = BASE_DIR / "data" / "processed"
    
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    all_data = {}
    
    # 获取所有文本文件
    book_files = list(DATA_DIR.glob("*.txt"))
    
    if not book_files:
        print(f"错误: 在 {DATA_DIR} 中没有找到任何文本文件")
        print("请确保已将书籍文本文件放置在 data/raw/ 目录下")
        return None
    
    print(f"找到 {len(book_files)} 个文本文件")
    
    for i, book_file in enumerate(book_files, 1):
        book_name = book_file.stem
        print(f"[{i}/{len(book_files)}] 正在处理: {book_name}")
        
        try:
            # 加载并清洗文本
            text = load_clean_text(str(book_file))
            
            # 分割文本块（使用论文推荐参数）
            blocks = get_blocks(text, block_size=10000, overlap=9000)
            
            if not blocks:
                print(f"  警告: {book_name} 没有生成任何文本块")
                continue
            
            print(f"  文本块数量: {len(blocks)}")
            
            # 计算各项指标
            sentence_lengths = []
            simpson_indices = []
            hapax_values = []
            keywords_list = []
            
            for j, block in enumerate(blocks):
                # 每处理10个块打印一次进度
                if j % 10 == 0:
                    print(f"    处理块 {j}/{len(blocks)}...")
                
                sentence_lengths.append(calc_sentence_length(block))
                simpson_indices.append(calc_simpsons_index(block))
                hapax_values.append(calc_hapax_legomena(block))
                keywords_list.append(get_top_keywords(block, n=3))
            
            # 计算功能词PCA
            print(f"    计算功能词PCA...")
            pca_coords = get_pca_coordinates(blocks)
            
            # 构建数据结构
            book_data = {
                "sentenceLength": [
                    {
                        "block": i,
                        "value": round(val, 4),
                        "keywords": keywords_list[i],
                        "preview": blocks[i][:150] + "..." if len(blocks[i]) > 150 else blocks[i],
                        "wordCount": len(blocks[i].split())
                    }
                    for i, val in enumerate(sentence_lengths)
                ],
                "simpsonIndex": [
                    {
                        "block": i,
                        "value": round(val, 6),
                        "keywords": keywords_list[i],
                        "preview": blocks[i][:150] + "..." if len(blocks[i]) > 150 else blocks[i],
                        "wordCount": len(blocks[i].split())
                    }
                    for i, val in enumerate(simpson_indices)
                ],
                "hapaxLegomena": [
                    {
                        "block": i,
                        "value": round(val, 4),
                        "keywords": keywords_list[i],
                        "preview": blocks[i][:150] + "..." if len(blocks[i]) > 150 else blocks[i],
                        "wordCount": len(blocks[i].split())
                    }
                    for i, val in enumerate(hapax_values)
                ],
                "functionWords": [
                    {
                        "block": i,
                        "value": round(val, 4),
                        "keywords": keywords_list[i],
                        "preview": blocks[i][:150] + "..." if len(blocks[i]) > 150 else blocks[i],
                        "wordCount": len(blocks[i].split())
                    }
                    for i, val in enumerate(pca_coords)
                ],
                "metadata": {
                    "totalBlocks": len(blocks),
                    "totalWords": sum(len(block.split()) for block in blocks),
                    "avgSentenceLength": round(sum(sentence_lengths) / len(sentence_lengths), 2),
                    "avgSimpsonIndex": round(sum(simpson_indices) / len(simpson_indices), 4)
                }
            }
            
            all_data[book_name] = book_data
            
            # 保存单本书的数据
            book_output_file = OUTPUT_DIR / f"{book_name}.json"
            with open(book_output_file, 'w', encoding='utf-8') as f:
                json.dump(book_data, f, ensure_ascii=False, indent=2)
            
            print(f"  ✓ {book_name} 处理完成，保存到 {book_output_file}")
            
        except Exception as e:
            print(f"  ✗ 处理 {book_name} 时出错: {e}")
            import traceback
            traceback.print_exc()
    
    # 保存所有数据
    if all_data:
        all_output_file = OUTPUT_DIR / "all_books.json"
        with open(all_output_file, 'w', encoding='utf-8') as f:
            json.dump(all_data, f, ensure_ascii=False, indent=2)
        
        print(f"\n✓ 所有数据处理完成！")
        print(f"  总书籍数: {len(all_data)}")
        print(f"  完整数据保存到: {all_output_file}")
        
        # 生成数据统计
        generate_stats(all_data, OUTPUT_DIR)
        
        return all_data
    
    return None

def generate_stats(data, output_dir):
    """
    生成数据统计报告
    """
    stats = {
        "totalBooks": len(data),
        "books": {}
    }
    
    for book_name, book_data in data.items():
        metadata = book_data.get("metadata", {})
        stats["books"][book_name] = metadata
    
    stats_file = output_dir / "statistics.json"
    with open(stats_file, 'w', encoding='utf-8') as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    
    # 生成HTML报告
    html_report = output_dir / "statistics.html"
    with open(html_report, 'w', encoding='utf-8') as f:
        f.write(generate_html_report(stats))
    
    print(f"  统计报告保存到: {stats_file}")

def generate_html_report(stats):
    """
    生成HTML格式的统计报告
    """
    html = """<!DOCTYPE html>
<html>
<head>
    <title>文印项目 - 数据统计报告</title>
    <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; margin: 40px; }
        h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
        .summary { background: #f8f9fa; padding: 20px; border-radius: 10px; margin-bottom: 30px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th { background: #3498db; color: white; padding: 12px; text-align: left; }
        td { padding: 10px; border-bottom: 1px solid #ddd; }
        tr:hover { background: #f5f5f5; }
        .metric { display: inline-block; background: #e8f4fc; padding: 5px 10px; margin: 5px; border-radius: 5px; }
    </style>
</head>
<body>
    <h1>📊 文印项目 - 数据统计报告</h1>
    
    <div class="summary">
        <h2>📚 总体统计</h2>
        <div class="metric">总书籍数: <strong>""" + str(stats["totalBooks"]) + """</strong></div>
        <div class="metric">分析完成时间: <strong>""" + """</strong></div>
    </div>
    
    <h2>📖 各书详细统计</h2>
    <table>
        <tr>
            <th>书籍名称</th>
            <th>文本块数</th>
            <th>总单词数</th>
            <th>平均句长</th>
            <th>平均Simpson指数</th>
        </tr>"""
    
    for book_name, book_stats in stats["books"].items():
        html += f"""
        <tr>
            <td>{book_name}</td>
            <td>{book_stats.get('totalBlocks', 'N/A')}</td>
            <td>{book_stats.get('totalWords', 'N/A')}</td>
            <td>{book_stats.get('avgSentenceLength', 'N/A')}</td>
            <td>{book_stats.get('avgSimpsonIndex', 'N/A')}</td>
        </tr>"""
    
    html += """
    </table>
    
    <div style="margin-top: 40px; color: #7f8c8d; font-size: 12px; text-align: center;">
        <p>© 2024 文印分析系统 | 基于 Literature Fingerprinting 理论</p>
        <p>数据生成时间: """ + """</p>
    </div>
</body>
</html>"""
    
    return html

def main():
    """
    主函数
    """
    print("=" * 60)
    print("文印项目 - 数据生成脚本")
    print("基于 Python 的文学指纹数据生成工具")
    print("=" * 60)
    
    print("\n开始处理所有书籍...")
    
    data = process_all_books()
    
    if data:
        print("\n✅ 数据处理成功完成！")
        print("下一步操作:")
        print("  1. 启动API服务器: python api_server.py")
        print("  2. 访问 http://localhost:5000 查看数据")
        print("  3. 打开 http://localhost:5000/static/d3_visualization.html 查看可视化")
    else:
        print("\n❌ 数据处理失败！")
        sys.exit(1)

if __name__ == "__main__":
    main()