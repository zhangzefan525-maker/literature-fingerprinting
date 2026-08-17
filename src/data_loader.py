# A成员的主要任务：升级为多文件对比加载系统
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


def _expand_contractions(text):
    """大小写不敏感地展开常见英语缩写（修复原实现仅小写匹配导致的遗漏）。"""
    return _CONTRACTION_PATTERN.sub(lambda m: CONTRACTIONS[m.group(0).lower()], text)


def load_clean_text(filepath):
    """
    读取并清洗 Project Gutenberg 的文本
    1. 去掉开头结尾的法律声明
    2. 处理换行符和多余空格
    3. 简单的缩写还原 (论文要求)
    """
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. 使用正则表达式定位正文起始位置 (Project Gutenberg 的标准标记)
    start_match = re.search(r"\*\*\* START OF THE PROJECT GUTENBERG EBOOK .* \*\*\*", content)
    end_match = re.search(r"\*\*\* END OF THE PROJECT GUTENBERG EBOOK .* \*\*\*", content)
    
    if start_match and end_match:
        content = content[start_match.end():end_match.start()]

    # 2. 预处理文本：换行变空格，合并多个空格
    content = content.replace('\n', ' ').replace('\r', ' ')
    content = re.sub(r'\s+', ' ', content).strip()

    # 3. 缩写转换 (复现论文 3.2 节的要求，大小写不敏感)
    content = _expand_contractions(content)

    return content

def get_blocks(text, block_size=10000, overlap=9000):
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