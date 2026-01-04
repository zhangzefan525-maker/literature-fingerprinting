# 成员C负责写的主逻辑，调用A和B的函数
import streamlit as st
import os
import tempfile
import nltk

# --- 自动处理 NLTK 依赖 ---
# 确保成员B的代码能够运行，即使本地未手动下载数据
try:
    nltk.data.find('tokenizers/punkt')
except LookupError:
    nltk.download('punkt')

try:
    nltk.data.find('corpora/stopwords')
except LookupError:
    nltk.download('stopwords')

# --- 导入项目模块 ---
# 假设 app.py 在项目根目录，src 在子目录
from src.data_loader import load_clean_text, get_blocks
from src.metrics import (
    calc_sentence_length, 
    calc_simpsons_index, 
    calc_hapax_legomena, 
    get_pca_coordinates
)
from src.visualizer import draw_heatmap

def main():
    # 页面配置
    st.set_page_config(page_title="Literature Fingerprinting Analysis", layout="wide")
    
    st.title("📚 Literature Fingerprinting: A New Method for Visual Literary Analysis")
    st.markdown("""
    本实验旨在复现 Keim & Oelke (2007) 的经典可视化论文。
    通过计算文本块的统计特征（如平均句长、词汇丰富度等）并以像素图（Pixel Map）形式展示，
    我们可以直观地识别不同作者的写作风格差异。
    """)

    # --- 侧边栏：设置与输入 ---
    st.sidebar.header("1. Data Input")
    uploaded_file = st.sidebar.file_uploader("Upload a Book (.txt)", type=['txt'])

    st.sidebar.header("2. Analysis Parameters")
    # 定义指标与函数的映射关系
    metric_options = {
        "Average Sentence Length (Avg Words/Sent)": "sl",
        "Simpson's Index (Vocabulary Richness)": "si",
        "Hapax Legomena (Uniqueness)": "hl",
        "Function Words PCA (1st Dimension)": "pca"
    }
    selected_metric_label = st.sidebar.selectbox("Select Metric", list(metric_options.keys()))
    metric_key = metric_options[selected_metric_label]

    st.sidebar.subheader("Sliding Window Settings")
    # 默认值参考论文：Block Size=10000, Overlap=9000 (即 Step=1000)
    block_size = st.sidebar.slider("Block Size (Words)", 1000, 20000, 10000, step=1000)
    overlap = st.sidebar.slider("Overlap (Words)", 0, 19000, 9000, step=1000)

    # ... (前面的代码) ...
    
    st.sidebar.markdown("---") # 添加一条分割线
    st.sidebar.header("3. System Control")
    
    # 添加一个关闭按钮
    if st.sidebar.button("🛑 停止程序 (Stop Server)"):
        st.sidebar.warning("程序已终止，你可以关闭浏览器标签页了。\n(Server has stopped. You can close the tab.)")
        # 强制结束 Python 进程

        import time
        time.sleep(1) # 等待1秒让提示信息显示出来
        os._exit(0)   # 0 表示正常退出，使用 os._exit 而不是 sys.exit 可以避开 Streamlit 的异常捕获

    # --- 主逻辑区 ---
    if uploaded_file is not None:
           # 使用 tempfile 保存上传的文件
        # mode='w' 表示以文本模式写入，encoding='utf-8' 确保编码正确
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix=".txt", encoding="utf-8") as tmp_file:
            
            # 1. 获取原始内容
            content = uploaded_file.getvalue()
            
            # 2. 【核心修改】智能判断数据类型
            # 如果是二进制(bytes)，就解码成字符串
            if isinstance(content, bytes):
                text_content = content.decode("utf-8", errors='ignore')
            # 如果已经是字符串(str)，就直接使用，不再解码
            else:
                text_content = content
            
            # 3. 写入临时文件
            tmp_file.write(text_content)
            tmp_file_path = tmp_file.name

        try:
            # Step 1: 数据清洗与切分 (调用成员 A 的代码)
            with st.spinner("Processing text... (Loading & Blocking)"):
                raw_text = load_clean_text(tmp_file_path)
                blocks = get_blocks(raw_text, block_size=block_size, overlap=overlap)
            
            st.success(f"File loaded successfully! Total Length: {len(raw_text)} chars. Generated {len(blocks)} blocks.")
            
            if len(blocks) == 0:
                st.error("The text is too short for the current Block Size. Please reduce Block Size or upload a longer text.")
                return

            # Step 2: 指标计算 (调用成员 B 的代码)
            with st.spinner("Calculating metrics..."):
                values = []
                if metric_key == "pca":
                    # PCA 需要一次性传入所有块
                    values = get_pca_coordinates(blocks)
                else:
                    # 其他指标逐块计算
                    progress_bar = st.progress(0)
                    for i, block in enumerate(blocks):
                        if metric_key == "sl":
                            val = calc_sentence_length(block)
                        elif metric_key == "si":
                            val = calc_simpsons_index(block)
                        elif metric_key == "hl":
                            val = calc_hapax_legomena(block)
                        values.append(val)
                        progress_bar.progress((i + 1) / len(blocks))
                    progress_bar.empty()

            # Step 3: 可视化 (调用成员 C 的代码 - src/visualizer.py)
            col_viz, col_detail = st.columns([3, 2])
            
            with col_viz:
                st.subheader("Visual Fingerprint")
                fig = draw_heatmap(values, selected_metric_label)
                st.pyplot(fig)
                st.caption("Color Map: Red = Low Value, Blue = High Value")

            # Step 4: 交互式详细分析 (Interaction)
            # 满足“高分项”：查看具体块的原文
            with col_detail:
                st.subheader("Block Inspector")
                st.info("Slide to inspect specific blocks corresponding to the pixels.")
                
                # 滑动条选择块索引
                selected_idx = st.slider("Select Block Index", 0, len(blocks)-1, 0)
                
                # 显示当前块的指标值
                st.metric(
                    label=f"Metric Value (Block {selected_idx})", 
                    value=f"{values[selected_idx]:.4f}"
                )
                
                # 显示当前块的原文（前 500 字符）
                st.text_area(
                    "Original Text (First 500 chars)", 
                    blocks[selected_idx][:500] + "...", 
                    height=300
                )

        except Exception as e:
            st.error(f"An error occurred: {e}")
        finally:
            # 清理临时文件
            if os.path.exists(tmp_file_path):
                os.remove(tmp_file_path)
    
    else:
        st.info("👈 Please upload a text file from the sidebar to start.")

if __name__ == "__main__":
    main()
