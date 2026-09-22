#!/usr/bin/env python3
"""
文印项目 - 数据生成脚本
批量处理所有书籍并生成JSON数据

分两趟做，顺序不能颠倒：
1. 逐本书读取、切块、算指标；
2. 把所有书的文本块合起来**只拟合一次**功能词投影模型，再逐本投影落盘。
   这是跨书坐标可比的前提——每本书各自拟合的话，坐标只在本书内部有意义。
"""

import json
import sys
from pathlib import Path

import numpy as np

# Windows 控制台默认 GBK，打印 ✓/✗ 会直接抛 UnicodeEncodeError 把整个生成流程打断
# （数据已经写了一半）。这里把标准输出切到 UTF-8，失败也不影响后续处理。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from src.data_loader import BLOCK_SIZE, OVERLAP, get_blocks, load_clean_text
from src.metrics import function_word_matrix
from src.pipeline import build_book_data
from src.projection import MODEL_PATH, axis_extent, build_model, save_model

def process_all_books():
    """
    处理所有书籍并生成完整数据
    """
    BASE_DIR = Path(__file__).parent
    DATA_DIR = BASE_DIR / "data" / "raw"
    OUTPUT_DIR = BASE_DIR / "data" / "processed"

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 排序后处理：保证不同机器、不同次运行生成的顺序一致，坐标与模型编号才可复现
    book_files = sorted(DATA_DIR.glob("*.txt"))

    if not book_files:
        print(f"错误: 在 {DATA_DIR} 中没有找到任何文本文件")
        print("请确保已将书籍文本文件放置在 data/raw/ 目录下")
        return None

    print(f"找到 {len(book_files)} 个文本文件")

    # --- 第一趟：读取原文并切块 ---
    prepared = []
    for i, book_file in enumerate(book_files, 1):
        book_name = book_file.stem
        print(f"[{i}/{len(book_files)}] 正在读取: {book_name}")

        try:
            # 加载并清洗文本
            text = load_clean_text(str(book_file))

            # 分割文本块（使用论文推荐参数）
            blocks = get_blocks(text, block_size=BLOCK_SIZE, overlap=OVERLAP)

            if not blocks:
                print(f"  警告: {book_name} 没有生成任何文本块")
                continue

            print(f"  文本块数量: {len(blocks)}，总词数: {len(text.split())}")
            prepared.append({"name": book_name, "text": text, "blocks": blocks})

        except Exception as e:
            print(f"  ✗ 处理 {book_name} 时出错: {e}")
            import traceback
            traceback.print_exc()

    if not prepared:
        return None

    # --- 第二趟之一：拟合共享投影模型 ---
    print("\n拟合共享功能词投影（所有书的文本块合起来只拟合一次）...")
    matrices = []
    vocabulary = None
    for item in prepared:
        matrix, vocabulary = function_word_matrix(item["blocks"])
        if matrix is not None:
            matrices.append(matrix)

    model = None
    if matrices:
        stacked = np.vstack(matrices)
        model = build_model(
            stacked,
            vocabulary,
            fitted_on={
                "books": [item["name"] for item in prepared],
                "blocks": int(stacked.shape[0]),
            },
        )
        ratio = model["explainedVarianceRatio"]
        print(f"  训练样本: {stacked.shape[0]} 块 x {stacked.shape[1]} 个功能词")
        print(f"  前两个主成分解释方差: {ratio[0]:.1%} / {ratio[1]:.1%}")
        print(f"  模型编号: {model['modelId']}")
    else:
        print("  警告: 没有任何文本块包含功能词，跳过共享投影（各书将退回单书拟合）")

    # --- 第二趟之二：逐书计算指标，并用同一个模型投影 ---
    all_data = {}
    for item in prepared:
        book_name = item["name"]
        try:
            print(f"  计算各项指标与功能词投影: {book_name}")
            all_data[book_name] = build_book_data(
                item["blocks"],
                text=item["text"],
                projection=model,
                block_size=BLOCK_SIZE,
                overlap=OVERLAP,
            )
        except Exception as e:
            print(f"  ✗ 计算 {book_name} 指标时出错: {e}")
            import traceback
            traceback.print_exc()

    if not all_data:
        return None

    # 全局坐标范围：前端据此固定星系坐标系，切换选书时点不再移动
    if model is not None:
        coords = [
            {"x": entry["value"], "y": entry["value_y"]}
            for book_data in all_data.values()
            for entry in book_data["functionWords"]
        ]
        model["axisExtent"] = axis_extent(coords)
        save_model(model)
        print(f"\n共享投影模型已保存: {MODEL_PATH}")
        for book_data in all_data.values():
            book_data["metadata"]["projection"]["axisExtent"] = model["axisExtent"]

    # 清掉不再对应的旧单书文件，避免上一版数据混在里面被误读
    keep = set(all_data) | {"all_books", "pca_model"}
    for stale in OUTPUT_DIR.glob("*.json"):
        if stale.stem not in keep:
            stale.unlink()
            print(f"  清理过期文件: {stale.name}")

    for book_name, book_data in all_data.items():
        book_output_file = OUTPUT_DIR / f"{book_name}.json"
        with open(book_output_file, "w", encoding="utf-8") as f:
            json.dump(book_data, f, ensure_ascii=False, indent=2)
        print(f"  ✓ {book_name} 处理完成，保存到 {book_output_file}")

    # 保存所有数据
    all_output_file = OUTPUT_DIR / "all_books.json"
    with open(all_output_file, "w", encoding="utf-8") as f:
        json.dump(all_data, f, ensure_ascii=False, indent=2)

    print(f"\n✓ 所有数据处理完成！")
    print(f"  总书籍数: {len(all_data)}")
    print(f"  完整数据保存到: {all_output_file}")

    return all_data

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
