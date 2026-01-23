# B成员的主要任务
import nltk
from nltk.tokenize import sent_tokenize, word_tokenize
from nltk.corpus import stopwords
from collections import Counter
import numpy as np
import math
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import CountVectorizer

# ---------------------------------------------------------
# 成员 B 负责部分：核心指标计算 (Core Metrics)
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
    3. 计算 Hapax Legomena (Honoré's Measure R)
    公式：R = 100 * log(N) / (1 - V1/V)
    描述：V1是只出现一次的词，V是词汇总数。
    """
    words = _clean_tokens(text_block)
    N = len(words)
    if N == 0:
        return 0.0
        
    counts = Counter(words)
    V = len(counts) # 词汇表大小
    V1 = sum(1 for count in counts.values() if count == 1) # 只出现一次的词
    
    if V == 0:
        return 0.0
    
    # 避免分母为0
    if V1 == V:
        return 0.0 
        
    R = (100 * math.log(N)) / (1 - (V1 / V))
    return R

# src/metrics.py

def get_pca_coordinates(all_blocks):
    """
    4. 计算 PCA 投影 (Function Words Analysis) - 升级版 (2D)
    输入：整本书的所有文本块列表 List[str]
    输出：每个文本块的坐标列表 List[{x, y}]
    """
    from nltk.corpus import stopwords
    from sklearn.feature_extraction.text import CountVectorizer
    from sklearn.decomposition import PCA
    
    function_words = stopwords.words('english')
    vectorizer = CountVectorizer(vocabulary=function_words)
    
    try:
        X = vectorizer.fit_transform(all_blocks)
        X_array = X.toarray()
        
        # --- 修改关键点：降维到 2 维 ---
        pca = PCA(n_components=2) 
        X_pca = pca.fit_transform(X_array)
        
        # 返回字典列表，包含 x 和 y
        # x 用于原来的热力图（依然可以用第一主成分），x,y 联合用于星系图
        return [{"x": float(v[0]), "y": float(v[1])} for v in X_pca]
        
    except ValueError:
        return [{"x": 0.0, "y": 0.0} for _ in all_blocks]
    
    
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