# 成员C负责写的主逻辑，调用A和B的函数
import streamlit as st
import os
import tempfile
import nltk

# --- 自动处理 NLTK 依赖 ---
# 确保分词和停用词数据包就绪
for res in ['tokenizers/punkt', 'corpora/stopwords']:
    try:
        nltk.data.find(res)
    except LookupError:
        nltk.download(res.split('/')[-1])

# --- 导入项目模块 ---
from src.data_loader import load_clean_text, get_blocks
from src.metrics import (
    calc_sentence_length, 
    calc_simpsons_index, 
    calc_hapax_legomena, 
    get_pca_coordinates
)
from src.visualizer import draw_heatmap

def main():
    # 页面配置：设为 wide 模式以支持并排对比
    st.set_page_config(page_title="Literature Fingerprinting Analysis", layout="wide")
    
    st.title("📚 Literature Fingerprinting: A New Method for Visual Literary Analysis")
    st.markdown("""
    本实验旨在复现 Keim & Oelke (2007) 的经典可视化论文。
    通过计算文本块的统计特征（如平均句长、词汇丰富度等）并以像素图（Pixel Map）形式展示。
    """)

    # --- 侧边栏：设置与输入 ---
    st.sidebar.header("1. Data Input")
    # 允许同时上传多本 .txt
    uploaded_files = st.sidebar.file_uploader("Upload Books (.txt)", type=['txt'], accept_multiple_files=True)

    st.sidebar.header("2. Analysis Parameters")
    metric_options = {
        "Average Sentence Length (Avg Words/Sent)": "sl",
        "Simpson's Index (Vocabulary Richness)": "si",
        "Hapax Legomena (Uniqueness)": "hl",
        "Function Words PCA (1st Dimension)": "pca"
    }
    selected_metric_label = st.sidebar.selectbox("Select Metric", list(metric_options.keys()))
    metric_key = metric_options[selected_metric_label]

    st.sidebar.subheader("Sliding Window Settings")
    block_size = st.sidebar.slider("Block Size (Words)", 1000, 20000, 10000, step=1000)
    overlap = st.sidebar.slider("Overlap (Words)", 0, 19000, 9000, step=1000)
    
    st.sidebar.markdown("---") 
    st.sidebar.header("3. System Control")
    
    if st.sidebar.button("🛑 停止程序 (Stop Server)"):
        st.sidebar.warning("程序已终止。")
        import time
        time.sleep(1) 
        os._exit(0)

    # --- 主逻辑区 ---
    if uploaded_files:
        all_books_results = {} # 存储所有处理结果

        try:
            # 1. 批量处理上传的文件
            for uploaded_file in uploaded_files:
                with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix=".txt", encoding="utf-8") as tmp_file:
                    content = uploaded_file.getvalue()
                    text_content = content.decode("utf-8", errors='ignore') if isinstance(content, bytes) else content
                    tmp_file.write(text_content)
                    tmp_file_path = tmp_file.name

                with st.spinner(f"Processing {uploaded_file.name}..."):
                    # 调用成员 A 的数据处理逻辑
                    raw_text = load_clean_text(tmp_file_path)
                    blocks = get_blocks(raw_text, block_size=block_size, overlap=overlap)
                    
                    if len(blocks) == 0:
                        st.warning(f"文件 '{uploaded_file.name}' 太短，已跳过。")
                        continue

                    # 调用成员 B 的指标计算逻辑
                    if metric_key == "pca":
                        values = get_pca_coordinates(blocks)
                    else:
                        values = []
                        for block in blocks:
                            if metric_key == "sl": val = calc_sentence_length(block)
                            elif metric_key == "si": val = calc_simpsons_index(block)
                            elif metric_key == "hl": val = calc_hapax_legomena(block)
                            values.append(val)
                    
                    all_books_results[uploaded_file.name] = {"values": values, "blocks": blocks}
                
                if os.path.exists(tmp_file_path):
                    os.remove(tmp_file_path)

            # --- 2. 自适应并排展示区 ---
            if all_books_results:
                st.divider()
                
                # 情况 1: 只上传了一本书 -> 实现左右布局 (左图右文)
                if len(all_books_results) == 1:
                    book_name = list(all_books_results.keys())[0]
                    data = all_books_results[book_name]
                    
                    col_left, col_right = st.columns([3, 2])
                    
                    with col_left:
                        st.subheader(f"📖 {book_name} - Visual Fingerprint")
                        fig = draw_heatmap(data["values"], selected_metric_label)
                        st.pyplot(fig)
                        st.caption("Color Map: Red = Low Value, Blue = High Value")
                    
                    with col_right:
                        st.subheader("🔍 Detailed Block Inspector")
                        selected_idx = st.slider(f"Select Block Index", 0, len(data['blocks'])-1, 0)
                        st.metric(label="Metric Value", value=f"{data['values'][selected_idx]:.4f}")
                        st.text_area("Original Text Snippet", data['blocks'][selected_idx][:1000] + "...", height=450)

                # 情况 2: 上传了多本书 -> 实现并排对比模式
                else:
                    st.subheader("📊 Cross-Book Comparative Analysis")
                    cols = st.columns(len(all_books_results))
                    for i, (name, data) in enumerate(all_books_results.items()):
                        with cols[i]:
                            st.subheader(f"📖 {name}")
                            fig = draw_heatmap(data["values"], selected_metric_label)
                            st.pyplot(fig)
                    
                    st.caption("Color Map: Red = Low Value, Blue = High Value")
                    st.divider()
                    
                    # 多书模式下的底部检测器
                    st.subheader("🔍 Comparative Block Inspector")
                    target_book = st.selectbox("Select Book to Inspect", list(all_books_results.keys()))
                    inspect_data = all_books_results[target_book]
                    selected_idx = st.slider(f"Select Block Index for {target_book}", 0, len(inspect_data['blocks'])-1, 0)
                    
                    col_m1, col_m2 = st.columns(2)
                    col_m1.metric(label="Metric Value", value=f"{inspect_data['values'][selected_idx]:.4f}")
                    col_m2.info(f"Currently inspecting: {target_book}")

                    st.text_area("Original Text Snippet", inspect_data['blocks'][selected_idx][:1000] + "...", height=300)

        except Exception as e:
            st.error(f"An error occurred: {e}")
            
    else:
        st.info("👈 Please upload one or more text files from the sidebar to start comparison.")

if __name__ == "__main__":
    main()