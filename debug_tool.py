from src.data_loader import load_multiple_files
import os

# 定义四本书的路径
paths = [
    "data/The call of the wild.txt",
    "data/White Fang.txt",
    "data/The Adventures of Tom Sawyer.txt",
    "data/The Adventures of Huckleberry Finn.txt"
]

if __name__ == "__main__":
    # 确保 data 目录存在
    existing_paths = [p for p in paths if os.path.exists(p)]
    
    print("--- 多文件加载系统测试 ---")
    results = load_multiple_files(existing_paths)
    
    for book_name, blocks in results.items():
        print(f"书籍: [{book_name}] | 切块数量: {len(blocks)}")
        if blocks:
            print(f"   第一块预览: {blocks[0][:50]}...")
    
    print("\n任务 D 接口验证完成，字典格式已就绪，可交接给 E/F。")