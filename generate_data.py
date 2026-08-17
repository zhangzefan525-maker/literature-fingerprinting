#!/usr/bin/env python3
"""
文印项目 - 数据生成脚本
批量处理所有书籍并生成JSON数据
"""

import json
import sys
from pathlib import Path
from src.data_loader import load_clean_text, get_blocks
from src.pipeline import build_book_data

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

            # 计算各项指标并构建数据结构（复用 src/pipeline.py 共享管线）
            print(f"    计算各项指标与功能词 PCA (2D)...")
            book_data = build_book_data(blocks)

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

        return all_data

    return None

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
        print("  1. 启动 API 服务器: python api_server.py")
        print("  2. 浏览器访问 http://localhost:5000/visualization")
    else:
        print("\n❌ 数据处理失败！")
        sys.exit(1)

if __name__ == "__main__":
    main()
