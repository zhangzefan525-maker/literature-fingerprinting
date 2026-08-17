# src/pipeline.py
"""
共享数据处理管线
==================
将一批文本块 (List[str]) 计算为完整的指纹数据，输出结构与
data/processed/all_books.json 中的单本书完全一致。

该模块同时被以下两处复用，避免指标计算逻辑漂移：
1. generate_data.py  —— 批量处理 data/raw/ 下的示例书籍
2. api_server.py     —— 用户上传文本后的即时分析 (POST /api/analyze)
"""

import nltk

from src.metrics import (
    calc_sentence_length,
    calc_simpsons_index,
    calc_hapax_legomena,
    get_pca_coordinates,
    get_top_keywords,
)


def _ensure_nltk_data():
    """确保 NLTK 数据包就绪（punkt 分词、stopwords 停用词），缺失时自动下载。

    全新环境（Render 部署、首次 clone）首次运行会在此下载；已下载时开销极小。
    网络失败时静默跳过，交由后续调用抛出明确的 LookupError。
    """
    for pkg in ("punkt", "punkt_tab", "stopwords"):
        try:
            nltk.download(pkg, quiet=True)
        except Exception:
            pass


def _preview(text, limit):
    """截取文本块预览，超出部分用省略号标注。"""
    return text[:limit] + "..." if len(text) > limit else text


def build_book_data(blocks, keywords_n=3):
    """
    对一批文本块计算全部指标，返回单本书的指纹数据字典。

    Args:
        blocks (List[str]): 滑动窗口切分出的文本块列表
        keywords_n (int): 每个文本块提取的关键词数量

    Returns:
        dict | None: 与 all_books.json 单本书相同结构的数据；输入为空时返回 None
    """
    if not blocks:
        return None

    _ensure_nltk_data()

    sentence_lengths = []
    simpson_indices = []
    hapax_values = []
    keywords_list = []

    for block in blocks:
        sentence_lengths.append(calc_sentence_length(block))
        simpson_indices.append(calc_simpsons_index(block))
        hapax_values.append(calc_hapax_legomena(block))
        keywords_list.append(get_top_keywords(block, n=keywords_n))

    # 功能词 PCA 返回字典列表 [{'x':.., 'y':..}]
    pca_coords = get_pca_coordinates(blocks)

    book_data = {
        "sentenceLength": [
            {
                "block": i,
                "value": round(val, 4),
                "keywords": keywords_list[i],
                "preview": _preview(blocks[i], 150),
                "wordCount": len(blocks[i].split()),
            }
            for i, val in enumerate(sentence_lengths)
        ],
        "simpsonIndex": [
            {
                "block": i,
                "value": round(val, 6),
                "keywords": keywords_list[i],
                "preview": _preview(blocks[i], 150),
                "wordCount": len(blocks[i].split()),
            }
            for i, val in enumerate(simpson_indices)
        ],
        "hapaxLegomena": [
            {
                "block": i,
                "value": round(val, 4),
                "keywords": keywords_list[i],
                "preview": _preview(blocks[i], 150),
                "wordCount": len(blocks[i].split()),
            }
            for i, val in enumerate(hapax_values)
        ],
        # functionWords 额外携带 value_y (PCA 第二主成分)，供「风格星系」视图定位
        "functionWords": [
            {
                "block": i,
                "value": item["x"],
                "value_y": item["y"],
                "keywords": keywords_list[i],
                "preview": _preview(blocks[i], 150),
                "extended_preview": _preview(blocks[i], 1200),
                "wordCount": len(blocks[i].split()),
            }
            for i, item in enumerate(pca_coords)
        ],
        "metadata": {
            "totalBlocks": len(blocks),
            "totalWords": sum(len(block.split()) for block in blocks),
            "avgSentenceLength": round(sum(sentence_lengths) / len(sentence_lengths), 2),
            "avgSimpsonIndex": round(sum(simpson_indices) / len(simpson_indices), 4),
        },
    }

    return book_data
