# 数据加载与清洗模块（支持多文件对比）
import re
import os

# 常见英语缩写及其展开形式（用于论文 3.2 节的缩写还原）
CONTRACTIONS = {
    "isn't": "is not", "aren't": "are not", "wasn't": "was not",
    "weren't": "were not", "can't": "cannot", "couldn't": "could not",
    "won't": "will not", "wouldn't": "would not", "don't": "do not",
    "doesn't": "does not", "didn't": "did not", "shouldn't": "should not",
    "mustn't": "must not", "haven't": "have not", "hasn't": "has not",
    "hadn't": "had not", "i'm": "i am", "it's": "it is",
    "that's": "that is", "he's": "he is", "she's": "she is",
    "we're": "we are", "they're": "they are", "you're": "you are",
    "i've": "i have", "we've": "we have", "you've": "you have",
    "they've": "they have", "let's": "let us",
}

_CONTRACTION_PATTERN = re.compile(
    r'\b(' + '|'.join(re.escape(k) for k in CONTRACTIONS) + r')\b',
    re.IGNORECASE,
)

# 滑窗参数（论文推荐值）：集中放这里，避免各处硬编码不一致导致块参数对不上
BLOCK_SIZE = 10000
OVERLAP = 9000
STEP = BLOCK_SIZE - OVERLAP


def _expand_contractions(text):
    """大小写不敏感地展开常见英语缩写（修复原实现仅小写匹配导致的遗漏）。"""
    return _CONTRACTION_PATTERN.sub(lambda m: CONTRACTIONS[m.group(0).lower()], text)


def clean_text(content):
    """
    清洗文本，把所有来源的文本统一成同一口径：
    1. 去掉开头结尾的法律声明
    2. 处理换行符和多余空格
    3. 简单的缩写还原 (论文要求)

    抽成独立函数是因为内置书与用户上传的书必须走同一条管线——
    只给内置书清洗、对上传书不清洗，导出里那句
    「文本经 Project Gutenberg 页眉页脚清理与常见缩写还原后」就成了假话。
    """
    # 1. 使用正则表达式定位正文起始位置 (Project Gutenberg 的标准标记)
    start_match = re.search(r"\*\*\* START OF THE PROJECT GUTENBERG EBOOK .* \*\*\*", content)
    end_match = re.search(r"\*\*\* END OF THE PROJECT GUTENBERG EBOOK .* \*\*\*", content)

    if start_match and end_match:
        content = content[start_match.end():end_match.start()]

    # 2. 预处理文本：换行变空格，合并多个空格
    content = content.replace('\n', ' ').replace('\r', ' ')
    content = re.sub(r'\s+', ' ', content).strip()

    # 3. 缩写转换 (复现论文 3.2 节的要求，大小写不敏感)
    return _expand_contractions(content)


def load_clean_text(filepath):
    """读取文件并清洗（清洗规则见 clean_text）。"""
    with open(filepath, 'r', encoding='utf-8') as f:
        return clean_text(f.read())

# ---------------------------------------------------------------
# 语言闸门：本工具的四个指标都建立在英文分词与英文功能词表上，
# 非英文文本喂进来只会得到两种坏结果——
#   中文（无空格）：整本书被当成 1 个「单词」，切不出块，用户看到的是「文本太短」；
#   法文等有空格的语言：能切块，但算出来的是没有意义的数值，而且一路静默地画在图上。
# 所以在上传入口先判一次语言，给出人能看懂的原因。
# 两个信号各管一边，缺一不可（阈值来自四本内置书的实测，见 tests/test_data_loader.py）：
#   1) 非 ASCII 字符占比：英文实测最高 0.0168，阈值 0.15 有约 9 倍余量；中文约 1.00。
#   2) 英文停用词命中率：英文实测 0.497–0.565，法语合成样本 0.046，
#      阈值 0.15 对英文有约 3.3 倍余量。光靠第 1 条抓不到法语（非 ASCII 仅 0.002）。
# ---------------------------------------------------------------
_NON_ASCII_LIMIT = 0.15          # 非 ASCII 字符占比上限
_STOPWORD_HIT_LIMIT = 0.15       # 英文停用词命中率下限
_STOPWORD_MIN_TOKENS = 200       # 词元太少时第 2 条不可靠，直接跳过（交给「文本太短」分支）
_STOPWORD_SAMPLE_CHARS = 20000   # 判定用样本：前 2 万个字符（约 3500 个英文词元），够稳又不用扫全篇
_ASCII_TOKEN_RE = re.compile(r"[A-Za-z']+")

_STOPWORD_CACHE = None


def _english_stopwords():
    """英文停用词表（nltk）。取不到（离线且没装语料）时返回空集合，闸门退化为只看非 ASCII。"""
    global _STOPWORD_CACHE
    if _STOPWORD_CACHE is None:
        try:
            from nltk.corpus import stopwords
            _STOPWORD_CACHE = set(stopwords.words('english'))
        except Exception:
            _STOPWORD_CACHE = set()
    return _STOPWORD_CACHE


def detect_language(text):
    """
    判断文本是否适合本工具分析（英文）。

    返回 (ok, reason, stats)：
      ok      是否通过
      reason  不通过时的中文原因（直接可以给用户看）；通过时为 None
      stats   判定依据的实测值，便于测试与排查
    """
    sample = text or ''
    total_chars = len(sample)
    non_ascii = sum(1 for ch in sample if ord(ch) > 127)
    non_ascii_ratio = (non_ascii / total_chars) if total_chars else 0.0

    tokens = _ASCII_TOKEN_RE.findall(sample[:_STOPWORD_SAMPLE_CHARS].lower())
    stopwords_set = _english_stopwords()
    hits = sum(1 for tok in tokens if tok in stopwords_set)
    hit_ratio = (hits / len(tokens)) if tokens else 0.0

    stats = {
        "totalChars": total_chars,
        "nonAsciiRatio": round(non_ascii_ratio, 4),
        "tokens": len(tokens),
        "stopwordHitRatio": round(hit_ratio, 4),
    }

    if non_ascii_ratio > _NON_ASCII_LIMIT:
        return (
            False,
            f"这份文本看起来不是英文（非英文字符约占 {non_ascii_ratio:.0%}）。"
            "本工具目前只分析英文小说，中文、日文等文本暂时算不出有意义的结果。",
            stats,
        )

    if len(tokens) >= _STOPWORD_MIN_TOKENS and hit_ratio < _STOPWORD_HIT_LIMIT:
        return (
            False,
            f"这份文本看起来不是英文（英文常用词 the/of/and 之类只占 {hit_ratio:.0%}）。"
            "本工具目前只分析英文小说，请换一份英文文本再试。",
            stats,
        )

    return True, None, stats


def get_blocks(text, block_size=BLOCK_SIZE, overlap=OVERLAP):
    """
    滑动窗口切分 (论文核心逻辑)
    block_size: 每个块包含的单词数 (默认1万)
    overlap: 重叠的单词数 (默认9千)
    """
    words = text.split() # 按空格分词
    step = block_size - overlap # 移动步长，默认1000
    
    blocks = []
    # 循环切分
    for i in range(0, len(words) - block_size + 1, step):
        block = " ".join(words[i : i + block_size])
        blocks.append(block)
        
    return blocks

def get_chapters(text):
    """
    根据正则匹配章节 (用于备选分析)
    """
    # 匹配 CHAPTER I, Chapter 1, CHAPTER ONE 等
    chapters = re.split(r'CHAPTER\s+[IVXLCDM\d]+|Chapter\s+[IVXLCDM\d]+', text, flags=re.IGNORECASE)
    # 去除空字符串
    return [c.strip() for c in chapters if len(c.strip()) > 50]

# ---------------------------------------------------------------------------
# 章节识别：把「第几个片段」翻译成「第几章」
# 只依赖章节标题的写法，不需要任何人工标注；识别不到就不给章节信息。
# ---------------------------------------------------------------------------
# CHAPTER I / CHAPTER 12 / CHAPTER ONE / CHAPTER THE LAST（接受三种大小写写法）
_CHAPTER_HEADING_RE = re.compile(
    r'\b(?:CHAPTER|Chapter|chapter)\s+(?:THE\s+)?([IVXLCDM]{1,7}|\d{1,3}|[A-Z]{2,12})\b'
)
# 标题前应当是句子结束符或文本开头。用来排除正文里的
# "...in this chapter I will explain..." 这类把代词 I 当序号的误匹配。
_HEADING_PRECEDING_CHARS = '.?!:"\'”’'
# 目录页里的标题挤在一起（连标题带简介通常只隔几十个词）。
# 取 120：既能把「标题 + 一句简介」的目录条目连成同一簇，又远小于最短的正文章节。
CHAPTER_CLUSTER_GAP_WORDS = 120
# 两章之间的最小词距。取 300：《汤姆·索亚历险记》第 24 章只有 410 词，
# 阈值再高就会把这种真章节当成噪声丢掉。目录簇在上一关已经整体丢掉了。
_CHAPTER_MIN_GAP_WORDS = 300
# 合法的罗马数字写法（"CIVIL" 这类恰好只由 IVXLCDM 组成的单词会被挡掉）
_ROMAN_RE = re.compile(r'^(M{0,4})(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$')
_ROMAN_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
# 章节数超过这个值的「罗马数字」多半不是序号
_ROMAN_MAX = 100
# 「部 / 卷」标题：PART I / BOOK THE SECOND / VOLUME 3。
# 刻意要求全大写——大小写不敏感的写法会命中正文散文里的 "part I"。
_PART_HEADING_RE = re.compile(r'\b(?:PART|BOOK|VOLUME)\s+(?:THE\s+)?([IVXLCDM]{1,7}|\d{1,3})\b')


def _ordinal_key(raw):
    """
    把标题里的序号归一化，用于去重：'I' / 'i' → '1'，'12' → '12'，
    'ONE' → '1'（不认识的单词原样返回，也能参与去重）。
    """
    token = (raw or "").strip().upper()
    if not token:
        return ""
    if token.isdigit():
        return str(int(token))
    if _ROMAN_RE.match(token) and token:
        total = 0
        prev = 0
        for ch in reversed(token):
            value = _ROMAN_VALUES[ch]
            total = total - value if value < prev else total + value
            prev = max(prev, value)
        if 0 < total <= _ROMAN_MAX:
            return str(total)
    return token


def _looks_like_heading(text, start):
    """标题前应当是句子结束符或文本开头（排除正文中的偶然命中）。"""
    prefix = text[:start].rstrip()
    return not prefix or prefix[-1] in _HEADING_PRECEDING_CHARS


def _ordinal_number(key):
    """序号键转数字；'ONE'、'LAST' 这类词转不出来，返回 None。"""
    return int(key) if key and key.isdigit() else None


def _raw_heading_hits(text):
    """全文所有像章节标题的命中（含目录页），按出现顺序返回。"""
    hits = []
    for match in _CHAPTER_HEADING_RE.finditer(text):
        hits.append({
            "title": " ".join(match.group(0).split()),
            "key": _ordinal_key(match.group(1)),
            "charStart": match.start(),
            "wordStart": len(text[:match.start()].split()),
        })
    return hits


def _raw_part_hits(text):
    """
    全文所有像「部 / 卷」标题的命中，按出现顺序返回。

    部标题不产出章节，只用来判断紧跟其后的章节标题处在标题语境里（见 _part_before）。
    """
    hits = []
    for match in _PART_HEADING_RE.finditer(text):
        if not _looks_like_heading(text, match.start()):
            continue
        hits.append({
            "title": " ".join(match.group(0).split()),
            "charStart": match.start(),
            "wordStart": len(text[:match.start()].split()),
        })
    return hits


def _part_before(hit, part_hits, max_gap=CHAPTER_CLUSTER_GAP_WORDS):
    """
    返回紧邻在 hit 之前且词距在 max_gap 以内的部标题命中，没有则返回 None。

    《白牙》这类分「部」的小说，每部都从 CHAPTER I 重新编号，而正文里那一行是
    「PART III / CHAPTER I」——章标题前面是罗马数字，不满足「标题前应是句末符」，
    于是连候选都不是（实测少认 4 章）。部标题本身是标题，可以拿它当锚点。
    """
    nearest = None
    for part in part_hits:  # 按位置升序
        if part["wordStart"] > hit["wordStart"]:
            break
        nearest = part
    if nearest is None:
        return None
    return nearest if hit["wordStart"] - nearest["wordStart"] < max_gap else None


def _in_heading_context(text, hits, index, part_hits=None):
    """
    命中是否处在「标题语境」里：前面是句子结束符，或紧跟在另一个标题之后。

    后者是必须的：目录最后一条与正文第一章常连着排在同一行，
    中间没有句号（例如 "…The Sounding of the Call Chapter I. Into the Primitive"）。
    """
    if _looks_like_heading(text, hits[index]["charStart"]):
        return True
    if (
        index > 0
        and hits[index]["wordStart"] - hits[index - 1]["wordStart"] < CHAPTER_CLUSTER_GAP_WORDS
    ):
        return True
    # 紧跟在「部 / 卷」标题之后的章节标题同样算标题语境（见 _part_before）
    return _part_before(hits[index], part_hits or []) is not None


def _cut_front_matter(cluster, hits):
    """
    一簇挨得极紧的标题通常就是目录页，处理方式分两种：

    1. 序号中途回落到 I（目录末尾直接接上正文第一章）→ 从回落点起保留；
    2. 序号一路递增、整簇都是目录（正文第一章离得较远，不在这一簇里）→ 整簇丢弃。
    （《哈克贝利·费恩》原始命中 84 处，正文只有 43 章，其余全是目录。）

    Returns:
        (List[int], List[int]): (保留的命中下标, 丢弃的命中下标)
    """
    cut = 0
    for i in range(1, len(cluster)):
        previous = _ordinal_number(hits[cluster[i - 1]]["key"])
        current = _ordinal_number(hits[cluster[i]]["key"])
        if previous is not None and current is not None and current < previous:
            cut = i

    if cut == 0 and len(cluster) >= 3:
        return [], list(cluster)
    return list(cluster[cut:]), list(cluster[:cut])


def _repair_missing_ordinals(accepted, hits, dropped):
    """
    按序号缺口回捞被「标题语境」规则误杀的真标题。

    正文第一章有时紧跟在没有句号的一行后面（题词、场景说明、信件落款），
    例如《哈克贝利·费恩》正文首章前是 "…Time: Forty to fifty years ago"，
    于是被误判；但它的序号 I 在已接受的章节里是缺的，可以据此找回来。

    回捞只在目录簇之外的命中里进行，免得又把目录条目捡回来。

    Args:
        accepted (List[int]): 已接受的命中下标（按位置升序）
        hits (List[dict]): 全部命中
        dropped (Set[int]): 被判为目录而丢弃的命中下标

    Returns:
        List[int]: 补齐并按位置排序后的下标列表
    """
    if not accepted:
        return accepted

    pool = [i for i in range(len(hits)) if i not in dropped and i not in set(accepted)]
    additions = []

    def number(index):
        return _ordinal_number(hits[index]["key"])

    # 开头缺号：正文第一章没被认出来
    first = accepted[0]
    first_number = number(first)
    if first_number and first_number > 1:
        wanted = set(range(1, first_number))
        for i in pool:
            if number(i) in wanted and hits[i]["wordStart"] < hits[first]["wordStart"]:
                additions.append(i)
                wanted.discard(number(i))

    # 中间缺号：某几章整体漏掉（正文里序号跳跃）
    for a, b in zip(accepted, accepted[1:]):
        start_number, end_number = number(a), number(b)
        if not start_number or not end_number or end_number - start_number < 2:
            continue
        wanted = set(range(start_number + 1, end_number))
        for i in pool:
            if number(i) in wanted and hits[a]["wordStart"] < hits[i]["wordStart"] < hits[b]["wordStart"]:
                additions.append(i)
                wanted.discard(number(i))

    return sorted(set(accepted) | set(additions), key=lambda i: hits[i]["wordStart"])


def get_chapter_spans(text, min_gap_words=_CHAPTER_MIN_GAP_WORDS):
    """
    识别正文章节边界，返回每章在「空格分词」坐标下的起止词位置。

    用来回答人文研究里最常问的那句「哪一章风格变了」。

    四步清洗，缺一不可：
    1. 标题语境过滤：排除正文里 "...in this chapter I will explain..." 这类把代词 I 当序号的命中；
    2. 目录页截断：密集簇按序号回落点切开，丢掉前半段；
    3. 最小间隔过滤：距上一个被接受的标题不足 min_gap_words 的丢弃；
    4. 序号缺口回捞：把第 1 步误杀、但序号明显缺失的真标题找回来。

    刻意不按序号去重——《白牙》这类分「部」的小说每部都从 CHAPTER I 重新编号，
    去重会把前面几部的章节全部抹掉。

    Args:
        text (str): 清洗后的全文（与 get_blocks 使用的同一份文本）
        min_gap_words (int): 相邻两章之间的最小词距

    Returns:
        List[dict] | None: [{index, title, wordStart, wordEnd, part}, ...]；
        part 是该章所属的「部 / 卷」标题（如 "PART IV"），分不出部时为 None；
        识别到的章节少于 2 个时返回 None（调用方据此省略章节信息）
    """
    if not text:
        return None

    hits = _raw_heading_hits(text)
    part_hits = _raw_part_hits(text)

    clusters = []
    for i in range(len(hits)):
        if not _in_heading_context(text, hits, i, part_hits):
            continue
        if clusters and hits[i]["wordStart"] - hits[clusters[-1][-1]]["wordStart"] < CHAPTER_CLUSTER_GAP_WORDS:
            clusters[-1].append(i)
        else:
            clusters.append([i])

    accepted, dropped = [], set()
    for cluster in clusters:
        kept, cut_off = _cut_front_matter(cluster, hits)
        dropped.update(cut_off)
        for index in kept:
            if accepted and hits[index]["wordStart"] - hits[accepted[-1]]["wordStart"] < min_gap_words:
                dropped.add(index)
                continue
            accepted.append(index)

    accepted = _repair_missing_ordinals(accepted, hits, dropped)

    if len(accepted) < 2:
        return None

    # 部归属：只有真正领起过某一章（就在它前面）的部标题才算数。
    # 目录页里的部标题不会紧跟在被接受的章节标题前面，因此不会张冠李戴。
    anchor_starts = set()
    for index in accepted:
        part = _part_before(hits[index], part_hits)
        if part is not None:
            anchor_starts.add(part["wordStart"])

    def part_of(word_start):
        found = None
        for part in part_hits:
            if part["wordStart"] > word_start:
                break
            if part["wordStart"] in anchor_starts:
                found = part["title"]
        return found

    total_words = len(text.split())
    chapters = []
    for position, index in enumerate(accepted):
        end = hits[accepted[position + 1]]["wordStart"] if position + 1 < len(accepted) else total_words
        chapters.append({
            "index": position,
            "title": hits[index]["title"],
            "part": part_of(hits[index]["wordStart"]),
            "wordStart": hits[index]["wordStart"],
            "wordEnd": end,
        })
    return chapters


def load_multiple_files(paths_list):
    """
    任务 D：多文件对比加载系统
    输入：多个路径的列表 ['data/book1.txt', 'data/book2.txt']
    输出：字典 {文件名: 块列表}
    """
    all_books_dict = {}
    
    for path in paths_list:
        if os.path.exists(path):
            # 提取文件名（不含路径和后缀）作为 key
            file_name = os.path.splitext(os.path.basename(path))[0]
            
            # 顺序调用原有逻辑
            raw_text = load_clean_text(path)
            blocks = get_blocks(raw_text)
            
            # 存储结果
            all_books_dict[file_name] = blocks
        else:
            print(f"Warning: File not found at {path}")
            
    return all_books_dict