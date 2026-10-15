from nltk.tokenize import sent_tokenize, word_tokenize
from nltk.corpus import stopwords
from collections import Counter
import numpy as np
import math
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import CountVectorizer

# ---------------------------------------------------------
# 核心指标计算 (Core Metrics)
# ---------------------------------------------------------

def _clean_tokens(text):
    """
    内部辅助函数：清洗文本，去除标点符号，只保留单词。
    """
    # 转小写并分词
    tokens = word_tokenize(text.lower())
    # 只保留由字母组成的单词 (去除标点和数字)
    words = [word for word in tokens if word.isalpha()]
    return words

def calc_sentence_length(text_block):
    """
    1. 计算平均句长 (Average Sentence Length)
    输入：单个文本块字符串
    输出：浮点数
    """
    sentences = sent_tokenize(text_block)
    if not sentences:
        return 0.0
    
    total_words = 0
    for sent in sentences:
        words = _clean_tokens(sent)
        total_words += len(words)
        
    return total_words / len(sentences)

def calc_simpsons_index(text_block):
    """
    2. 计算 Simpson's Index (D值)
    公式：D = sum(n * (n-1)) / (N * (N-1))
    描述：词汇丰富度指标。值越大，词汇越贫乏。
    """
    words = _clean_tokens(text_block)
    N = len(words)
    if N < 2:
        return 0.0
    
    counts = Counter(words)
    numerator = sum(n * (n - 1) for n in counts.values())
    denominator = N * (N - 1)
    
    return numerator / denominator

def calc_hapax_legomena(text_block):
    """
    3. 计算 Honoré's Measure R（兼容旧函数名 calc_hapax_legomena）
    公式：R = 100 * log(N) / (1 - V1/V)
    其中 N 是词元总数，V 是不同词型数，V1 是只出现一次的词型数。
    """
    words = _clean_tokens(text_block)
    N = len(words)
    if N == 0:
        return 0.0
        
    counts = Counter(words)
    V = len(counts)  # 不同词型数
    V1 = sum(1 for count in counts.values() if count == 1)  # 只出现一次的词型数
    
    if V == 0:
        return 0.0
    
    # 避免分母为0
    if V1 == V:
        return 0.0 
        
    R = (100 * math.log(N)) / (1 - (V1 / V))
    return R

# ---------------------------------------------------------
# 功能词 PCA 投影：拆成「向量化 → 拟合 → 投影」三步
# 拆分的原因是跨书可比：多本书必须落在同一个基底上，
# 所以拟合只在数据生成阶段做一次，之后所有书（含用户上传）都复用同一个模型。
# ---------------------------------------------------------

def function_word_matrix(blocks, vocabulary=None):
    """
    把文本块列表转换为功能词「相对用法」矩阵（每行 L1 归一化，即行内求和为 1）。

    归一化是必须的：各个块的总词数并不相同，用原始计数时第一主成分
    会退化成「这一段有多长」而不是「词是怎么用的」。归一化后每一行表示
    该块中各个功能词所占的比例，跨块、跨书才有可比性。

    Args:
        blocks (List[str]): 文本块列表
        vocabulary (List[str] | None): 指定词表；缺省用 NLTK 英语停用词

    Returns:
        (numpy.ndarray | None, List[str]): (矩阵, 实际使用的列顺序)；无有效输入时返回 (None, [])
    """
    if not blocks:
        return None, []

    if vocabulary is None:
        vocabulary = stopwords.words('english')

    vectorizer = CountVectorizer(vocabulary=vocabulary)
    try:
        matrix = vectorizer.fit_transform(blocks).toarray().astype(float)
    except ValueError:
        return None, []

    row_totals = matrix.sum(axis=1, keepdims=True)
    # 极少数块可能一个功能词都没有，这些行保持全 0，避免除零
    np.divide(matrix, row_totals, out=matrix, where=row_totals > 0)

    return matrix, list(vectorizer.get_feature_names_out())


def _degenerate_model(n_features):
    """
    没有可拟合方向的退化模型：所有块的功能词用法完全一样（或一个功能词都没有）。

    与其让 sklearn 在方差为 0 时算出 nan（nan 写进 JSON 不是合法 JSON，
    会让整个数据文件读不出来），不如老老实实给一个零模型，
    投影结果统一落在原点——本来就区分不出任何东西。
    """
    zeros = [0.0] * int(n_features)
    return {
        "mean": list(zeros),
        "components": [list(zeros), list(zeros)],
        "explainedVarianceRatio": [0.0, 0.0],
    }


def fit_pca_projection(matrix):
    """
    在矩阵上拟合 2 维 PCA，返回可持久化的投影模型（不含词表）。

    符号确定化：若某个主成分绝对值最大的载荷为负，就把整个成分取反。
    否则换一个 sklearn 版本或换一批书，成分正负就可能翻转，
    同一段文字会落到相反方向，之前分享出去的链接和导出的图就对不上了。

    svd_solver 固定为 "full"：sklearn 默认的 "auto" 会在行数超过 500 时改用
    randomized SVD（近似解，且同进程重复拟合都可能不一致）。现在 248 行时
    "auto" 恰好解析成 "full"，pin 住不改变任何数值；等以后加了书再漂就晚了。
    """
    data = np.asarray(matrix, dtype=float)
    if data.ndim != 2 or data.shape[0] < 2 or not np.any(data.std(axis=0) > 0):
        return _degenerate_model(data.shape[1] if data.ndim == 2 else 0)

    pca = PCA(n_components=2, svd_solver="full")
    pca.fit(data)

    components = np.array(pca.components_, dtype=float)
    for i in range(components.shape[0]):
        strongest = int(np.argmax(np.abs(components[i])))
        if components[i, strongest] < 0:
            components[i] = -components[i]

    return {
        "mean": [float(v) for v in pca.mean_],
        "components": [list(map(float, row)) for row in components],
        "explainedVarianceRatio": [float(v) for v in pca.explained_variance_ratio_],
    }


def project_blocks(matrix, model):
    """
    用已有模型把矩阵投影成 2 维坐标（不重新拟合，结果与 fit_transform 等价）。

    Returns:
        numpy.ndarray: 形状 (n, 2)
    """
    data = np.asarray(matrix, dtype=float)
    mean = np.asarray(model["mean"], dtype=float)
    components = np.asarray(model["components"], dtype=float)
    return (data - mean) @ components.T

    
# ---------------------------------------------------------
# 任务 E：高频关键词提取 (Keyword Extraction)
# ---------------------------------------------------------

def get_top_keywords(text_block, n=5):
    """
    找出单个文本块中最具代表性的实词（关键词）。
    输入：单个文本块字符串
    输出：List[str] (例如 ['river', 'blood', 'dead', 'fear', 'dark'])
    """
    # 1. 引用必要的库（防止前面没引）
    from nltk.corpus import stopwords
    from collections import Counter
    
    # 2. 复用之前的清洗逻辑拿到单词列表
    words = _clean_tokens(text_block)
    
    # 3. 获取停用词表
    # 下载点全项目只有 src/pipeline.py 的 _ensure_nltk_data() 一处，而且它一定比这里先跑
    # （build_book_data 在本函数之前就调过它）。所以这里**不**再兜一层下载（第五十二批）：
    # 那样写并没有兜住任何东西——下载失败照样抛 LookupError——反而会在断网的机器上
    # 把一次用户请求同步挂住几十秒去等网络。同文件的 function_word_matrix 也是直接取。
    stop_words = set(stopwords.words('english'))

    # 4. 过滤：只保留不在停用词表里的词
    content_words = [w for w in words if w not in stop_words]
    
    # 5. 统计词频
    if not content_words:
        return []
        
    counter = Counter(content_words)
    
    # 6. 获取频率最高的 n 个词
    return top_content_words(counter, n)


# ---------------------------------------------------------
# 任务 E′：特征词提取（对数似然比，第五十九批）
# ---------------------------------------------------------
# 上面那个 get_top_keywords 是「这一段出现最多的实词」，一个字都不动（测试还断言它）。
# 但它有个读者一眼看不出的毛病：一本小说里排前面的永远是主角名和几个高频虚词，
# 书的**任何一段**都是这几个词，等于没告诉你「这一段在讲什么」。
#
# 这一节加的是语言学界做「关键词分析（keyness）」的标准做法：Dunning (1993) 的对数似然比 G²。
# 拿「这一段」当目标语料、「这本书的其它部分」当参考语料，算每个词在 2×2 列联表上的 G²，
# 取**显著偏多**的前几个。同一批片段实测：汤姆第 1 块从 tom/boy/would 变成
# chapter/fence/jim/boy/whitewash（刷栅栏那一章），第 11 块变成 tick/beetle/tooth（教堂看甲虫）。
#
# 口径上的两条边界写在这里，免得以后有人当成统计结论用：
#   1. 片段是 1 万词、重叠 9 千词的滑窗切出来的，彼此完全不独立，所以 G² **只当排序依据**，
#      不当检验结论——不给 p 值、不说「显著差异」（README 第五十七批已经写过这一条）。
#   2. 参考语料是「同一本书的其它部分」。它回答的是「这一段相对这本书自己的常态偏多的是什么」，
#      不是「这个词在英语里罕见」。G² 的**绝对大小只在同一本书内部可比**——块占全书比例不同，
#      同一个效应（块内 8 次 / 参考 0 次）在《汤姆》（块:参考 ≈ 0.16）得 31.4、在《野性》
#      （≈ 0.46）只有 18.2（B 实测）。所以界面上不并排两本书的 G²。

# 特征词的段内最少出现次数。放进模块常量是为了让「数据里记的口径」和「代码用的口径」
# 不可能各说一套——metadata.keywordMethod.minCount 直接引用它。
KEYWORD_MIN_COUNT = 3

# G² 的下限：15.13 是 1 自由度在 p<0.0001 上的临界值。这是一条**卫生下限**，不是结论——
# 这一批仍然不给 p 值、不说「显著」（见上面第 1 条）。为什么还要它：G² 是随语料规模放大的，
# 段内出现 3 次的词在参考里为 0 时就有 11.79，够不上任何像样的证据强度。实测它几乎从不触发
# （251 个片段里只有 1 个的第 3 名低于它），所以加它不改变界面上看到的东西，只是把
# 「万一某本书特别小、候选特别弱」那条路堵上。
MIN_G2 = 15.13

# 古腾堡排版辅文里的词。目录页与版权页落在全文最前面约 1 千词内，而滑窗步长正是 1 千词——
# 于是它们**只**污染第 0 个片段：《汤姆》第 0 块的 chapter 出现 40 次（全书 72 次），
# 于是「chapter」被当成这一段最偏多的词，而它显然不是作者写的东西。
# 只在这一栏的候选池里排除，不动分词、不动三个指标、不动 get_top_keywords（B 实测：
# 加这张表只改动《汤姆》《哈克》第 0 块的前三名，其余片段与另外两本书一个词都不变）。
PARATEXT_WORDS = frozenset({
    'chapter', 'chapters', 'contents', 'illustration', 'illustrations',
    'transcriber', 'gutenberg', 'ebook', 'preface', 'appendix',
})


def content_word_frequencies(text):
    """
    去掉英文停用词之后的实词词频（Counter）。

    两处都用它：整本书的全文 → 特征词的参考语料；单个片段 → 特征词的候选池。
    输入：一段文本
    输出：collections.Counter
    """
    from nltk.corpus import stopwords

    stop_words = set(stopwords.words('english'))
    return Counter(w for w in _clean_tokens(text) if w not in stop_words)


def top_content_words(block_counter, n=5):
    """
    旧口径：按出现次数取前 n 个实词。收 Counter 而不是收文本，理由同 get_distinctive_words——
    一个片段的实词只分词一次，两边共用；否则上传路径白白多花约 20% 的时间。
    """
    return [word for word, _count in block_counter.most_common(n)]


def log_likelihood_ratio(a, b, c, d):
    """
    Dunning (1993) 的对数似然比 G²（2×2 列联表）：

        a = 该词在**目标语料**（这一段）里的次数
        b = 目标语料里其它词的次数
        c = 该词在**参考语料**（这本书的其它部分）里的次数
        d = 参考语料里其它词的次数

    G² = 2 * Σ O * ln(O / E)，E 由行列边际算出。值越大 = 该词在目标语料里越不寻常。
    某个格为 0 时该项贡献 0（0 * ln 0 取极限为 0）。
    """
    n = a + b + c + d
    if n <= 0:
        return 0.0

    total = 0.0
    for observed, row, col in ((a, a + b, a + c), (b, a + b, b + d),
                               (c, c + d, a + c), (d, c + d, b + d)):
        expected = row * col / n
        if observed > 0 and expected > 0:
            total += observed * math.log(observed / expected)

    return 2.0 * total


def get_distinctive_words(block_counter, book_counter, n=3,
                          min_count=KEYWORD_MIN_COUNT, min_g2=MIN_G2):
    """
    找出这一段里「相对这本书其它部分显著偏多」的词（特征词），按对数似然比降序。

    Args:
        block_counter (Counter): 这一段的实词词频（用 content_word_frequencies 算）
        book_counter (Counter): **整本书**的实词词频（含本块）
        n (int): 取前几个
        min_count (int): 段内出现次数低于这个数的词不参与。一两次的出现多半是
            人名、生僻词或排版噪声，放进来会让「特征词」变成随机榜
        min_g2 (float): G² 下限，见 MIN_G2 的注释

    Returns:
        List[Tuple[str, float]]: [(词, G²), ...]，G² 圆整到一位小数；不足 n 个就少给

    调用方传**整本书**的词频，函数内部自己扣掉本块——参考语料是「这本书的其它部分」，
    拿自己比自己恒为 0、没有意义。扣完为负（跨书参考等场景）时按 0 处理。

    只收「多于期望值」的词，不收「偏少」的：这一栏的用途是「这一段在讲什么」，
    某个词在这段**缺席**说明不了这一段在讲什么（偏少的第一名往往是「这一段里没出现的
    主角名」，B 实测《汤姆》第 0 块偏少第一名是 huck，G² 48.6，比多数偏多词还高——
    混排会把「哈克不在场」顶成这一段的关键词）。

    收 Counter 而不是收文本：同一个片段的实词词频在调用方已经为「高频词兜底」算过一次了，
    再分词一次会让上传路径多花约 20% 的时间（C 实测：每块 0.198 s → 0.248 s）。
    """
    block_total = sum(block_counter.values())
    if block_total <= 0:
        return []
    book_total = sum(book_counter.values())

    scored = []
    for word, count in block_counter.items():
        if count < min_count or word in PARATEXT_WORDS:
            continue

        in_block = count
        in_reference = max(0, book_counter.get(word, 0) - count)
        rest_in_block = block_total - in_block
        rest_in_reference = max(0, book_total - block_total - in_reference)

        # 期望值 = 该词在两份语料合计里的占比 × 目标语料规模。只收偏多。
        total = in_block + rest_in_block + in_reference + rest_in_reference
        if total <= 0:
            continue
        expected = (in_block + in_reference) * (in_block + rest_in_block) / total
        if in_block <= expected:
            continue

        score = log_likelihood_ratio(in_block, rest_in_block,
                                     in_reference, rest_in_reference)
        if score < min_g2:
            continue

        scored.append((score, word))

    # 同分时按字母序，保证不同机器、不同次生成的结果一致
    scored.sort(key=lambda item: (-item[0], item[1]))

    return [(word, round(score, 1)) for score, word in scored[:n]]