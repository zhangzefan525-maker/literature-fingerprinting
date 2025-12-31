from src.data_loader import load_clean_text, get_blocks

path = "data/White Fang.txt" 

if __name__ == "__main__":
    raw_text = load_clean_text(path)
    print(f"清洗后的总字数: {len(raw_text)}")
    
    blocks = get_blocks(raw_text)
    print(f"生成的滑动窗口块数: {len(blocks)}")
    if len(blocks) > 0:
        print(f"第一个块的前100个字: {blocks[0][:100]}...")