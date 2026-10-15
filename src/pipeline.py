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
    KEYWORD_MIN_COUNT,
    calc_sentence_length,
    calc_simpsons_index,
    calc_hapax_legomena,
    content_word_frequencies,
    fit_pca_projection,
    function_word_matrix,
    get_distinctive_words,
    project_blocks,
    top_content_words,
)
from src.projection import projection_metadata

# 数据版本：2 起 metadata 里区分 totalWords / analyzedWords，并带块参数与章节信息。
# 前端据 schemaVersion 判断要不要在内存里兼容升级老数据（磁盘上的旧文件不改写）。
#
# v3（2026-10-08，第二十四批）：数据形状与 v2 完全一样，只是数值不同——
# 清洗管线补上了排版弯引号归一（见 src/data_loader.py 的 _normalize_quotes）。
# 打新版号是为了让线上/别人克隆里那些 v2 的旧数据被自动判为过期、重算一次：
# 不升版号的话，服务器会一直拿旧数值伺候，本地好、线上差，正是这个项目的老毛病。
#
# v4（2026-10-15，第五十九批）：**字段名没变、含义变了**——`keywords` 从「这一段出现
# 最多的实词」换成「相对本书其它部分显著偏多的词（对数似然比）」，并新增
# `keywordsTop` / `keywordScores`。这类改动最危险的地方恰恰是「读得动、看着也对」：
# 旧的 v3 数据在新前端上不会报错，只会安静地显示旧口径。升版号让 api_server 的
# `_demo_corpus_is_current()` 把它判成过期、自己重算一次。
SCHEMA_VERSION = 4


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


# 片段预览的两种长度。CARD = 卡片/异常面板里那一行小字（只有几十字可见），
# MODAL = 点开「原文片段」时读到的摘录。两者都不等于原文——一个片段有 1 万词。
# 四个指标必须给同样的长度：以前只有 functionWords 带 extended_preview（1200 字），
# 另外三个只有 preview（150 字），于是同一个片段、只换一下「观察角度」，弹窗里的
# 原文就从 1200 字变成 150 字——而标题和按钮都自称是全文。
CARD_PREVIEW_CHARS = 150
MODAL_PREVIEW_CHARS = 1200


def _preview(text, limit):
    """截取文本块预览，超出部分用省略号标注。"""
    return text[:limit] + "..." if len(text) > limit else text


def _block_entry(index, value, keywords_list, blocks, extra=None,
                 keyword_scores_list=None):
    """一个片段在某个指标下的通用字段（四个指标结构一致，只有 value 不同）。

    第五十九批新增 keywordScores：与 keywords 同序的对数似然比（保留一位小数）。
    四个指标各带一份（和 keywords 一样）——导出与卡片会从任意一个 series 里取这个词条，
    只挂在一个 series 上，换个「观察角度」就会读不到。
    """
    entry = {
        "block": index,
        "value": value,
        "keywords": keywords_list[index],
        "preview": _preview(blocks[index], CARD_PREVIEW_CHARS),
        "extended_preview": _preview(blocks[index], MODAL_PREVIEW_CHARS),
        "wordCount": len(blocks[index].split()),
    }
    if keyword_scores_list is not None:
        entry["keywordScores"] = keyword_scores_list[index]
    if extra:
        entry.update(extra)
    return entry


def _reference_word_frequencies(text, blocks, step):
    """
    特征词用的参考语料：整本书的实词词频（Counter）。

    有全文就用全文（最准）。没有全文时按滑窗的定义把原文拼回来：每块只取**前 step 个词**
    （也就是它相对上一块新增的那一段），**最后一块整个算进来**——它比 step 多出来的那
    overlap 个词没有任何后续块覆盖，只取前 step 个的话，拼出来的原文正好短 overlap 个词
    （出厂参数下就是 9000 词——一本十来万词的小说里差到一成，整批关键词都会被牵连，
    而这件事不会报任何错）。

    为什么不能用「各块词频之和」当参考（第五十九批，B 实测）：片段重叠 9 千词，求和会把
    书中间的区域重复计约 10 遍、首尾计得少，参考语料因此变成**位置相关**的，同一本书里
    各块不再同口径——《汤姆》第 30 块的前三名会从 shore/fish/camp 变成 go/shore/fish。
    块不是从 get_blocks 出来的（长度参差、或比 step 还短）时退回整块累加。

    注意这条路径（没有全文）只在测试里走得到：generate_data.py 与上传接口都带全文。
    真要做「书架重建」得先落盘原文，否则重算出来的 G² 量级和出厂值对不上，而且不报错。
    """
    if text:
        return content_word_frequencies(text)

    token_lists = [block.split() for block in blocks]
    if step > 0 and all(len(tokens) >= step for tokens in token_lists):
        pieces = [tokens[:step] for tokens in token_lists[:-1]]
        pieces.append(token_lists[-1])
        joined = " ".join(" ".join(piece) for piece in pieces)
        return content_word_frequencies(joined)

    counter = Counter()
    for block in blocks:
        counter.update(content_word_frequencies(block))
    return counter


def build_book_data(blocks, keywords_n=3, text=None, projection=None,
                    block_size=None, overlap=None, include_vectors=False):
    """
    对一批文本块计算全部指标，返回单本书的指纹数据字典。

    Args:
        blocks (List[str]): 滑动窗口切分出的文本块列表
        keywords_n (int): 每个文本块提取的关键词数量（第五十九批起是「特征词」的个数）
        text (str | None): 清洗后的全文。只有给了它才能算出真实总词数和章节边界——
            blocks 之间大面积重叠，靠 blocks 累加会把词数放大近十倍
        projection (dict | None): 共享投影模型（见 src/projection.py）。
            为 None 时按单本书自己拟合，此时坐标无法与其它书比较，
            metadata.projection.mode 会标成 "perBook"
        block_size / overlap (int | None): 滑窗参数，缺省时按块长推断
        include_vectors (bool): 是否附带逐块功能词向量。这是服务器内部字段
            （只有书架落盘时才需要），HTTP 响应里会被剥掉

    Returns:
        dict | None: 与 all_books.json 单本书相同结构的数据；输入为空时返回 None
    """
    if not blocks:
        return None

    _ensure_nltk_data()

    # 滑窗参数要在算参考语料之前就有（拼回全文时要用到步长），提前到循环外
    block_size = block_size or len(blocks[0].split())
    overlap = 0 if overlap is None else overlap
    step = block_size - overlap

    sentence_lengths = []
    simpson_indices = []
    hapax_values = []
    keywords_list = []
    keyword_scores_list = []

    # 特征词的参考语料（第五十九批）：整本书的实词词频，只算一次。
    reference_counter = _reference_word_frequencies(text, blocks, step)

    for block in blocks:
        sentence_lengths.append(calc_sentence_length(block))
        simpson_indices.append(calc_simpsons_index(block))
        hapax_values.append(calc_hapax_legomena(block))

        # keywords 换成「相对本书其它部分显著偏多」的特征词（对数似然比，第五十九批）。
        # 一个片段的实词词频只算这一次：特征词和高频词兜底用的是同一份 Counter
        # （这正是把 get_distinctive_words 的入参改成 Counter 的原因，见它的注释）。
        block_counter = content_word_frequencies(block)
        distinctive = get_distinctive_words(block_counter, reference_counter, n=keywords_n)

        # 一个特征词都挑不出来时退回旧口径（这一段出现最多的实词）：宁可显示一句
        # 「这一段最常出现的词」，也不要空着——界面里这一栏是「这一段在讲什么」的线索，
        # 空栏会被读成「这一段没有关键词」。退回时 keywordScores 给空数组，长度对不上，
        # 前端据此不显示分数（见 showDetail / exportTableData 的注释）。
        keywords_list.append([word for word, _score in distinctive]
                             or top_content_words(block_counter, keywords_n))
        keyword_scores_list.append([score for _word, score in distinctive])

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

    book_data = {
        "sentenceLength": [
            _block_entry(i, round(val, 4), keywords_list, blocks,
                         keyword_scores_list=keyword_scores_list)
            for i, val in enumerate(sentence_lengths)
        ],
        "simpsonIndex": [
            _block_entry(i, round(val, 6), keywords_list, blocks,
                         keyword_scores_list=keyword_scores_list)
            for i, val in enumerate(simpson_indices)
        ],
        "hapaxLegomena": [
            _block_entry(i, round(val, 4), keywords_list, blocks,
                         keyword_scores_list=keyword_scores_list)
            for i, val in enumerate(hapax_values)
        ],
        # functionWords 额外携带 value_y (PCA 第二主成分)，供「风格星系」视图定位
        "functionWords": [
            _block_entry(i, item["x"], keywords_list, blocks,
                         keyword_scores_list=keyword_scores_list,
                         extra={"value_y": item["y"]})
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
            # keywords 是哪一版算法算出来的（第五十九批）。写进数据是为了让这一批最容易
            # 出的那个错可查：旧数据配新前端不会报错、只会安静地显示旧口径。
            "keywordMethod": {
                "method": "log-likelihood-ratio",   # Dunning (1993) G²
                "reference": "sameBookRest",        # 参考语料 = 本书其它部分
                "minCount": KEYWORD_MIN_COUNT,
                "top": keywords_n,
            },
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
