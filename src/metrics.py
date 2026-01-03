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

def get_pca_coordinates(all_blocks):
    """
    4. 计算 PCA 投影 (Function Words Analysis)
    输入：整本书的所有文本块列表 List[str]
    输出：每个文本块在第一主成分上的投影值列表 List[float]
    """
    # 使用 NLTK 的英文停用词作为虚词表 (Function Words)
    # 因为你刚才已经运行成功了下载脚本，这里直接调用肯定没问题
    function_words = stopwords.words('english')
    
    # 仅统计这些虚词的频率
    vectorizer = CountVectorizer(vocabulary=function_words)
    
    try:
        # 生成文档-词频矩阵
        X = vectorizer.fit_transform(all_blocks)
        X_array = X.toarray()
        
        # PCA 降维到 1 维
        pca = PCA(n_components=1)
        X_pca = pca.fit_transform(X_array)
        
        # 展平结果
        return [float(x[0]) for x in X_pca]
        
    except ValueError:
        # 如果数据为空或不足以计算PCA，返回0列表
        return [0.0] * len(all_blocks)