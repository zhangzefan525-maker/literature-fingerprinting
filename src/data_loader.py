# A成员的主要任务
import re
import os

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
    # 匹配 *** START OF THE PROJECT GUTENBERG EBOOK ... ***
    start_match = re.search(r"\*\*\* START OF THE PROJECT GUTENBERG EBOOK .* \*\*\*", content)
    end_match = re.search(r"\*\*\* END OF THE PROJECT GUTENBERG EBOOK .* \*\*\*", content)
    
    if start_match and end_match:
        content = content[start_match.end():end_match.start()]

    # 2. 预处理文本：换行变空格，合并多个空格
    content = content.replace('\n', ' ').replace('\r', ' ')
    content = re.sub(r'\s+', ' ', content).strip()

    # 3. 缩写转换 (复现论文 3.2 节的要求)
    replacements = {
        "isn't": "is not", "aren't": "are not", "can't": "cannot",
        "won't": "will not", "don't": "do not", "shouldn't": "should not"
    }
    for short, long_form in replacements.items():
        content = content.replace(short, long_form)
        
    return content

def get_blocks(text, block_size=10000, overlap=9000):
    """
    滑动窗口切分 (论文核心逻辑)
    block_size: 每个块包含的单词数 (默认1万)
    overlap: 重叠的单词数 (默认9千)
    """
    words = text.split() # 按空格分词
    step = block_size - overlap # 移动步长，默认是1000
    
    blocks = []
    for i in range(0, len(words) - block_size + 1, step):
        # 截取单词序列并重新拼成字符串
        block_content = " ".join(words[i : i + block_size])
        blocks.append(block_content)
        
    return blocks

def get_chapters(text):
    """
    根据正则匹配章节 (用于备选分析)
    """
    # 匹配 CHAPTER I, Chapter 1, CHAPTER ONE 等
    chapters = re.split(r'CHAPTER\s+[IVXLCDM\d]+|Chapter\s+[IVXLCDM\d]+', text, flags=re.IGNORECASE)
    # 去除空字符串
    return [c.strip() for c in chapters if len(c.strip()) > 50]