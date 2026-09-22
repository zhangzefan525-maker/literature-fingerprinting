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

from src.data_loader import BLOCK_SIZE, OVERLAP, get_chapter_spans
from src.metrics import (
    calc_sentence_length,
    calc_simpsons_index,
    calc_hapax_legomena,
    fit_pca_projection,
    function_word_matrix,
    get_top_keywords,
    project_blocks,
)
from src.projection import projection_metadata

# 数据版本：2 起 metadata 里区分 totalWords / analyzedWords，并带块参数与章节信息。
# 前端据 schemaVersion 判断要不要在内存里兼容升级老数据（磁盘上的旧文件不改写）。
SCHEMA_VERSION = 2


def _ensure_nltk_data():
    """确保 NLTK 数据包就绪（punkt 分词、punkt_tab、stopwords）。

    优先本地查找，命中时零网络开销——避免每次分析都触发 nltk.download()
    联网检查（离线/受限网络下每个包会卡几十秒超时）。
    仅当本地确实缺失时才尝试自动下载；下载失败静默跳过，
    由后续实际调用抛出明确的 LookupError。
    """
    resources = {
        "punkt": "tokenizers/punkt",
        "punkt_tab": "tokenizers/punkt_tab",
        "stopwords": "corpora/stopwords",
    }
    for pkg, resource in resources.items():
        try:
            nltk.data.find(resource)
        except LookupError:
            try:
                nltk.download(pkg, quiet=True)
            except Exception:
                pass


def _preview(text, limit):
    """截取文本块预览，超出部分用省略号标注。"""
    return text[:limit] + "..." if len(text) > limit else text


def build_book_data(blocks, keywords_n=3, text=None, projection=None,
                    block_size=None, overlap=None, include_vectors=False):
    """
    对一批文本块计算全部指标，返回单本书的指纹数据字典。

    Args:
        blocks (List[str]): 滑动窗口切分出的文本块列表
        keywords_n (int): 每个文本块提取的关键词数量
        text (str | None): 清洗后的全文。只有给了它才能算出真实总词数和章节边界——
            blocks 之间大面积重叠，靠 blocks 累加会把词数放大近十倍
        projection (dict | None): 共享投影模型（见 src/projection.py）。
            为 None 时按单本书自己拟合，此时坐标无法与其它书比较，
            metadata.projection.mode 会标成 "perBook"
        block_size / overlap (int | None): 滑窗参数，缺省时按块长推断
        include_vectors (bool): 是否附带逐块功能词向量。这是服务器内部字段
            （只有「我的图书馆」落盘时才需要），HTTP 响应里会被剥掉

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

    # 功能词投影：有共享模型就复用，没有才自己拟合
    matrix, vocabulary = function_word_matrix(blocks)
    if matrix is None:
        coordinates = [{"x": 0.0, "y": 0.0} for _ in blocks]
        used_model = None
        projection_mode = "perBook"
    else:
        projection_mode = "shared" if projection is not None else "perBook"
        used_model = projection if projection is not None else fit_pca_projection(matrix)
        coordinates = [
            {"x": float(item[0]), "y": float(item[1])}
            for item in project_blocks(matrix, used_model)
        ]

    block_size = block_size or len(blocks[0].split())
    overlap = 0 if overlap is None else overlap
    step = block_size - overlap

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
            for i, item in enumerate(coordinates)
        ],
        "metadata": {
            "schemaVersion": SCHEMA_VERSION,
            "totalBlocks": len(blocks),
            # totalWords：这本书一共有多少词（真实词数，不是窗口累加）
            "totalWords": len(text.split()) if text else None,
            # analyzedWords：滑窗覆盖过的词次，比总词数大，用于说明重叠程度
            "analyzedWords": (len(blocks) - 1) * step + block_size,
            "blockSize": block_size,
            "overlap": overlap,
            "step": step,
            # 章节边界：按「空格分词」坐标给出，识别不到时为 None
            "chapters": get_chapter_spans(text) if text else None,
            # 坐标说明：mode=shared 表示与其它书可比，perBook 表示各自为政
            "projection": projection_metadata(used_model, projection_mode),
            "avgSentenceLength": round(sum(sentence_lengths) / len(sentence_lengths), 2),
            "avgSimpsonIndex": round(sum(simpson_indices) / len(simpson_indices), 4),
        },
    }

    if include_vectors and matrix is not None:
        # 只给书库书落盘用：将来重建/换模型时不必要求用户重新上传原文。
        # 圆整到 6 位小数，纯为控制文件体积。
        book_data["_functionWordVectors"] = {
            "vocabulary": vocabulary,
            "matrix": [[round(float(v), 6) for v in row] for row in matrix],
        }

    return book_data
