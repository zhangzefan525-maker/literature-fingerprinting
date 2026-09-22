import nltk
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


def get_pca_coordinates(all_blocks, model=None):
    """
    4. 计算 PCA 投影 (Function Words Analysis) - 升级版 (2D)

    保留为兼容入口。不传 model 时按「单本书自己拟合」处理，
    这种情况下坐标不可与其它书直接比较（仅在共享模型缺失时才会走到）。

    Args:
        all_blocks (List[str]): 整本书的所有文本块列表
        model (dict | None): 共享投影模型，见 src/projection.py

    Returns:
        List[{"x": float, "y": float}]
    """
    matrix, _ = function_word_matrix(all_blocks)
    if matrix is None:
        return [{"x": 0.0, "y": 0.0} for _ in all_blocks]

    if model is None:
        model = fit_pca_projection(matrix)

    coords = project_blocks(matrix, model)
    # x 用于热力图（第一主成分），x、y 联合用于风格星系
    return [{"x": float(v[0]), "y": float(v[1])} for v in coords]

    
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
    
    # 3. 获取停用词表 (确保数据已下载)
    try:
        stop_words = set(stopwords.words('english'))
    except LookupError:
        nltk.download('stopwords')
        stop_words = set(stopwords.words('english'))
    
    # 4. 过滤：只保留不在停用词表里的词
    content_words = [w for w in words if w not in stop_words]
    
    # 5. 统计词频
    if not content_words:
        return []
        
    counter = Counter(content_words)
    
    # 6. 获取频率最高的 n 个词
    top_n = counter.most_common(n)
    
    return [word for word, count in top_n]