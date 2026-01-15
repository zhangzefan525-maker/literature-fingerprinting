# 成员C负责写的主逻辑，调用A和B的函数
# 修改者：成员B (集成了 Task E 关键词提取功能)
# 新增：集成了指纹分析模块和界面美化
import streamlit as st
import os
import tempfile
import nltk
import numpy as np
# +++ 修复：添加time模块导入 +++
import time
from datetime import datetime

# --- 自动处理 NLTK 依赖 ---
# 确保分词和停用词数据包就绪
for res in ['tokenizers/punkt', 'corpora/stopwords', 'tokenizers/punkt_tab']:
    try:
        nltk.data.find(res)
    except LookupError:
        try:
            nltk.download(res.split('/')[-1])
        except:
            pass # 防止网络问题卡死

# --- 导入项目模块 ---
from src.data_loader import load_clean_text, get_blocks
from src.metrics import (
    calc_sentence_length, 
    calc_simpsons_index, 
    calc_hapax_legomena, 
    get_pca_coordinates,
    get_top_keywords  
)
from src.visualizer import draw_heatmap
from src.analyzer import FingerprintAnalyzer

import streamlit as st
import streamlit.components.v1 as components

def show_d3_visualization():
    # 方法1：直接嵌入代码
    html_code = """
    <!DOCTYPE html>
    <html lang="zh-CN">
    ...（您的完整HTML代码）...
    </html>
    """
    components.html(html_code, height=800, scrolling=True)
    
    # 或方法2：读取外部HTML文件
    # with open("d3_visualization.html", "r", encoding="utf-8") as f:
    #     html_content = f.read()
    # components.html(html_content, height=800, scrolling=True)

# 在合适的地方调用
if st.sidebar.checkbox("📊 显示D3.js交互图表"):
    st.markdown("## 🔬 D3.js交互式可视化分析")
    show_d3_visualization()

# --- 自定义CSS样式 ---
def load_custom_css():
    """加载自定义CSS样式"""
    css = """
    <style>
    /* 主容器美化 */
    .main-container {
        background-color: #f8f9fa;
        padding: 20px;
        border-radius: 15px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.08);
        margin-bottom: 20px;
    }
    
    /* 标题渐变效果 */
    .gradient-title {
        background: linear-gradient(90deg, #3498db, #2ecc71);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
    }
    
    /* 指标卡片 */
    .metric-card {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 20px;
        border-radius: 12px;
        text-align: center;
        box-shadow: 0 6px 12px rgba(0,0,0,0.15);
        transition: transform 0.3s ease;
    }
    
    .metric-card:hover {
        transform: translateY(-5px);
    }
    
    /* 关键词标签 */
    .keyword-tag {
        display: inline-block;
        background: linear-gradient(90deg, #FF9A9E 0%, #FAD0C4 100%);
        color: #2c3e50;
        padding: 6px 12px;
        margin: 3px;
        border-radius: 20px;
        font-size: 14px;
        font-weight: 500;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    
    /* 分析报告美化 */
    .analysis-report {
        background-color: white;
        border-radius: 10px;
        padding: 20px;
        border-left: 5px solid #3498db;
        box-shadow: 0 4px 6px rgba(0,0,0,0.05);
        font-family: 'Monaco', 'Consolas', monospace;
        line-height: 1.6;
    }
    
    /* 区块分隔线 */
    .section-divider {
        height: 3px;
        background: linear-gradient(to right, #3498db, #2ecc71, #f39c12);
        border: none;
        margin: 30px 0;
    }
    
    /* 上传区域美化 */
    .upload-zone {
        border: 3px dashed #3498db;
        border-radius: 15px;
        padding: 30px;
        text-align: center;
        background-color: rgba(52, 152, 219, 0.05);
        transition: all 0.3s ease;
    }
    
    .upload-zone:hover {
        background-color: rgba(52, 152, 219, 0.1);
        border-color: #2980b9;
    }
    
    /* 工具提示样式 */
    .tooltip {
        position: relative;
        display: inline-block;
        border-bottom: 1px dotted #3498db;
        cursor: help;
    }
    
    .tooltip .tooltiptext {
        visibility: hidden;
        width: 200px;
        background-color: #2c3e50;
        color: #fff;
        text-align: center;
        border-radius: 6px;
        padding: 10px;
        position: absolute;
        z-index: 1;
        bottom: 125%;
        left: 50%;
        margin-left: -100px;
        opacity: 0;
        transition: opacity 0.3s;
        font-size: 12px;
    }
    
    .tooltip:hover .tooltiptext {
        visibility: visible;
        opacity: 1;
    }
    
    /* 时间戳样式 */
    .timestamp {
        color: #7f8c8d;
        font-size: 12px;
        font-style: italic;
        text-align: right;
        margin-top: 10px;
    }
    
    /* 响应式调整 */
    @media (max-width: 768px) {
        .main-container {
            padding: 10px;
        }
        .metric-card {
            margin-bottom: 15px;
        }
    }
    </style>
    """
    st.markdown(css, unsafe_allow_html=True)

def main():
    # 页面配置：设为 wide 模式以支持并排对比
    st.set_page_config(
        page_title="Literature Fingerprinting Analysis",
        layout="wide",
        page_icon="📚",
        initial_sidebar_state="expanded"
    )
    
    # 加载自定义CSS
    load_custom_css()
    
    # 页面标题（使用渐变效果）
    st.markdown("""
    <div class="main-container">
        <h1 class="gradient-title">📚 Literature Fingerprinting Analysis</h1>
        <p style="color: #7f8c8d; font-size: 16px;">
        基于 Keim & Oelke (2007) 的可视化文学分析方法，通过计算文本块的统计特征并生成文学指纹图。
        <span style="color: #3498db; font-weight: bold;">支持多种分析指标和深度洞察。</span>
        </p>
    </div>
    """, unsafe_allow_html=True)
    
    # +++ 初始化分析器 +++
    analyzer = FingerprintAnalyzer()

    # --- 侧边栏：设置与输入 ---
    with st.sidebar:
        st.markdown("""
        <div style="background: linear-gradient(135deg, #3498db, #2c3e50); padding: 20px; border-radius: 10px; color: white; margin-bottom: 20px;">
            <h3 style="color: white; margin: 0;">⚙️ 分析配置</h3>
            <p style="font-size: 12px; opacity: 0.9;">调整以下参数以定制分析</p>
        </div>
        """, unsafe_allow_html=True)
        
        # 文件上传区域美化
        st.markdown('<div class="upload-zone">', unsafe_allow_html=True)
        uploaded_files = st.file_uploader(
            "📁 上传书籍文件 (.txt)",
            type=['txt'],
            accept_multiple_files=True,
            help="支持上传多个文本文件进行对比分析"
        )
        st.markdown('</div>', unsafe_allow_html=True)
        
        if uploaded_files:
            st.success(f"✅ 已上传 {len(uploaded_files)} 个文件")
        
        # 分析参数配置
        st.markdown("---")
        st.markdown("### 📊 分析参数")
        
        metric_options = {
            "Average Sentence Length (Avg Words/Sent)": "sl",
            "Simpson's Index (Vocabulary Richness)": "si",
            "Hapax Legomena (Uniqueness)": "hl",
            "Function Words PCA (1st Dimension)": "pca"
        }
        
        selected_metric_label = st.selectbox(
            "选择分析指标",
            list(metric_options.keys()),
            help="选择用于生成指纹图的文本特征指标"
        )
        metric_key = metric_options[selected_metric_label]
        
        # 高级选项
        with st.expander("⚙️ 高级选项", expanded=False):
            show_analysis_report = st.checkbox("显示详细分析报告", value=True)
            show_summary_charts = st.checkbox("显示统计汇总图表", value=True)
        
        # 滑动窗口设置
        st.markdown("---")
        st.markdown("### 🔧 文本块设置")
        
        col_size, col_overlap = st.columns(2)
        with col_size:
            block_size = st.slider(
                "块大小 (单词数)",
                1000, 20000, 10000, step=1000,
                help="每个文本块包含的单词数量"
            )
        with col_overlap:
            overlap = st.slider(
                "重叠大小 (单词数)",
                0, 19000, 9000, step=1000,
                help="相邻文本块之间的重叠单词数"
            )
        
        # 系统控制
        st.markdown("---")
        st.markdown("### ⚡ 系统控制")
        
        if st.button("🛑 停止程序", use_container_width=True, type="secondary"):
            st.warning("程序已终止。")
            time.sleep(1)
            os._exit(0)
        
        # 页脚信息
        st.markdown("---")
        st.markdown("""
        <div style="text-align: center; color: #7f8c8d; font-size: 11px;">
            <p>📅 最后更新: 2024.01</p>
            <p>📖 基于 Keim & Oelke (2007) 论文</p>
            <p>🔬 可视语言与信息可视化实验</p>
        </div>
        """, unsafe_allow_html=True)

    # --- 主逻辑区 ---
    if uploaded_files:
        all_books_results = {} # 存储所有处理结果

        try:
            # 显示处理进度
            progress_bar = st.progress(0)
            status_text = st.empty()
            
            # 1. 批量处理上传的文件
            for idx, uploaded_file in enumerate(uploaded_files):
                status_text.text(f"📖 正在处理: {uploaded_file.name} ({idx+1}/{len(uploaded_files)})")
                progress_bar.progress((idx) / len(uploaded_files))
                
                with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix=".txt", encoding="utf-8") as tmp_file:
                    content = uploaded_file.getvalue()
                    text_content = content.decode("utf-8", errors='ignore') if isinstance(content, bytes) else content
                    tmp_file.write(text_content)
                    tmp_file_path = tmp_file.name

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
            
            progress_bar.progress(1.0)
            status_text.text("✅ 所有文件处理完成！")
            time.sleep(0.5)
            progress_bar.empty()
            status_text.empty()

            # --- 2. 自适应并排展示区 ---
            if all_books_results:
                # 显示成功消息
                st.success(f"🎉 成功处理 {len(all_books_results)} 本书籍，共 {sum(len(data['blocks']) for data in all_books_results.values())} 个文本块")
                
                st.markdown('<hr class="section-divider">', unsafe_allow_html=True)
                
                # 情况 1: 只上传了一本书 -> 实现左右布局 (左图右文)
                if len(all_books_results) == 1:
                    book_name = list(all_books_results.keys())[0]
                    data = all_books_results[book_name]
                    
                    # 显示书籍信息卡片
                    col_info, col_stats = st.columns([2, 1])
                    with col_info:
                        st.markdown(f"""
                        <div class="metric-card">
                            <h3 style="color: white; margin: 0;">📖 {book_name}</h3>
                            <p style="color: rgba(255,255,255,0.9); font-size: 14px;">{selected_metric_label}</p>
                        </div>
                        """, unsafe_allow_html=True)
                    with col_stats:
                        avg_value = np.mean(data['values']) if data['values'] else 0
                        st.markdown(f"""
                        <div class="metric-card" style="background: linear-gradient(135deg, #2ecc71, #27ae60);">
                            <h4 style="color: white; margin: 0;">📊 平均指标值</h4>
                            <h2 style="color: white; margin: 10px 0;">{avg_value:.2f}</h2>
                        </div>
                        """, unsafe_allow_html=True)
                    
                    col_left, col_right = st.columns([3, 2])
                    
                    with col_left:
                        st.markdown("### 🔍 文学指纹图")
                        fig = draw_heatmap(data["values"], selected_metric_label)
                        st.pyplot(fig)
                        
                        # 图例说明
                        st.markdown("""
                        <div style="background: #f8f9fa; padding: 10px; border-radius: 8px; border-left: 4px solid #3498db;">
                            <p style="margin: 0; font-size: 13px; color: #2c3e50;">
                            <strong>🎨 颜色解读：</strong><br>
                            🔵 <strong>蓝色区域</strong>：高值（如长句、高词汇多样性）<br>
                            🔴 <strong>红色区域</strong>：低值（如短句、低词汇多样性）<br>
                            ⚪ <strong>白色区域</strong>：中间值
                            </p>
                        </div>
                        """, unsafe_allow_html=True)
                    
                    with col_right:
                        st.markdown("### 📝 文本块详情")
                        
                        # 滑块选择
                        selected_idx = st.slider(
                            f"选择文本块 (0-{len(data['blocks'])-1})",
                            0, len(data['blocks'])-1, 0,
                            key="block_slider"
                        )
                        
                        # 获取当前选中的文本块
                        current_block_text = data['blocks'][selected_idx]
                        
                        # 指标值显示
                        current_value = data['values'][selected_idx] if selected_idx < len(data['values']) else 0
                        st.markdown(f"""
                        <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 20px; border-radius: 12px; text-align: center; margin-bottom: 20px;">
                            <h4 style="color: white; margin: 0;">📏 当前块指标值</h4>
                            <h1 style="color: white; margin: 10px 0;">{current_value:.4f}</h1>
                            <p style="color: rgba(255,255,255,0.8); margin: 0;">块 #{selected_idx}</p>
                        </div>
                        """, unsafe_allow_html=True)
                        
                        # --- Task E: 关键词显示 ---
                        st.markdown("#### 🔑 高频关键词")
                        keywords = get_top_keywords(current_block_text, n=5)
                        if keywords:
                            keywords_html = " ".join([f'<span class="keyword-tag">{kw}</span>' for kw in keywords])
                            st.markdown(f'<div style="margin: 15px 0;">{keywords_html}</div>', unsafe_allow_html=True)
                        else:
                            st.warning("未提取到关键词")
                        
                        # 原文片段
                        st.markdown("#### 📄 原文片段")
                        text_preview = current_block_text[:800] + ("..." if len(current_block_text) > 800 else "")
                        st.markdown(f"""
                        <div style="background-color: #f8f9fa; border-radius: 8px; padding: 15px; border: 1px solid #ddd; max-height: 300px; overflow-y: auto;">
                            <p style="font-family: 'Georgia', serif; line-height: 1.6; color: #2c3e50;">{text_preview}</p>
                        </div>
                        """, unsafe_allow_html=True)
                        
                        # 块统计信息
                        col_w, col_s, col_c = st.columns(3)
                        with col_w:
                            word_count = len(current_block_text.split())
                            st.metric("单词数", word_count)
                        with col_s:
                            sentence_count = len(nltk.sent_tokenize(current_block_text))
                            st.metric("句子数", sentence_count)
                        with col_c:
                            char_count = len(current_block_text)
                            st.metric("字符数", char_count)

                # 情况 2: 上传了多本书 -> 实现并排对比模式
                else:
                    st.markdown("### 📊 跨书对比分析")
                    st.info("📖 以下展示所有书籍的文学指纹图对比")
                    
                    # 创建标签页显示不同书籍
                    tab_names = [name[:15] + "..." if len(name) > 15 else name for name in all_books_results.keys()]
                    tabs = st.tabs(tab_names)
                    
                    for i, (tab, (name, data)) in enumerate(zip(tabs, all_books_results.items())):
                        with tab:
                            col_chart, col_info = st.columns([3, 1])
                            with col_chart:
                                fig = draw_heatmap(data["values"], f"{name} - {selected_metric_label}")
                                st.pyplot(fig)
                            with col_info:
                                avg_val = np.mean(data['values']) if data['values'] else 0
                                st.markdown(f"""
                                <div style="background: linear-gradient(135deg, #3498db, #2980b9); color: white; padding: 15px; border-radius: 10px; text-align: center;">
                                    <h5 style="color: white; margin: 0;">📈 统计摘要</h5>
                                    <p style="margin: 5px 0;">均值: <strong>{avg_val:.2f}</strong></p>
                                    <p style="margin: 5px 0;">块数: <strong>{len(data['blocks'])}</strong></p>
                                </div>
                                """, unsafe_allow_html=True)
                    
                    st.markdown('<hr class="section-divider">', unsafe_allow_html=True)
                    
                    # 多书模式下的底部检测器
                    st.markdown("### 🔍 详细检查器")
                    target_book = st.selectbox("选择要详细检查的书籍", list(all_books_results.keys()))
                    inspect_data = all_books_results[target_book]
                    
                    col_slider, col_display = st.columns([1, 3])
                    with col_slider:
                        selected_idx = st.slider(
                            f"选择块索引",
                            0, len(inspect_data['blocks'])-1, 0,
                            key=f"multi_block_slider_{target_book}"
                        )
                    with col_display:
                        current_block_text = inspect_data['blocks'][selected_idx]
                        current_value = inspect_data['values'][selected_idx] if selected_idx < len(inspect_data['values']) else 0
                        
                        st.markdown(f"""
                        <div style="background: #e8f4fc; padding: 15px; border-radius: 8px; border-left: 4px solid #3498db;">
                            <p style="margin: 0; color: #2c3e50;">
                            <strong>📖 当前检查:</strong> {target_book}<br>
                            <strong>📏 指标值:</strong> {current_value:.4f}<br>
                            <strong>🔢 块编号:</strong> #{selected_idx}
                            </p>
                        </div>
                        """, unsafe_allow_html=True)
                    
                    # 关键词显示
                    st.markdown("#### 🔑 高频关键词")
                    keywords = get_top_keywords(current_block_text, n=5)
                    if keywords:
                        keywords_html = " ".join([f'<span class="keyword-tag">{kw}</span>' for kw in keywords])
                        st.markdown(f'<div style="margin: 15px 0;">{keywords_html}</div>', unsafe_allow_html=True)
                    
                    # 原文片段
                    st.text_area("原文片段", current_block_text[:1000] + "...", height=250)

                # --- 3. 分析报告区域（显示在页面底部） ---
                st.markdown('<hr class="section-divider">', unsafe_allow_html=True)
                st.markdown("### 📈 深度分析报告")
                
                if show_analysis_report:
                    with st.expander("📋 详细统计分析报告", expanded=True):
                        # 生成分析报告
                        report = analyzer.generate_analysis_report(
                            {k: v for k, v in all_books_results.items()}, 
                            selected_metric_label
                        )
                        st.markdown(f'<div class="analysis-report">{report}</div>', unsafe_allow_html=True)
                
                if show_summary_charts and len(all_books_results) > 0:
                    with st.expander("📊 统计汇总图表", expanded=True):
                        # 生成汇总图表
                        summary_fig = analyzer.create_summary_visualization(
                            {k: v for k, v in all_books_results.items()}, 
                            selected_metric_label
                        )
                        if summary_fig:
                            st.pyplot(summary_fig)
                        else:
                            st.info("📊 图表生成中...")
                
                # --- 快速洞察卡片 ---
                st.markdown('<hr class="section-divider">', unsafe_allow_html=True)
                st.markdown("### 💡 快速洞察")
                
                # 创建洞察卡片
                insight_cols = st.columns(4)
                
                # 确保comparison变量在所有情况下都定义
                comparison = {}
                if len(all_books_results) > 1:
                    try:
                        comparison = analyzer.compare_fingerprints(
                            {k: v for k, v in all_books_results.items()}
                        )
                    except Exception as e:
                        st.warning(f"比较分析时出现错误: {e}")
                        comparison = {}
                
                with insight_cols[0]:
                    if all_books_results:
                        first_book = list(all_books_results.keys())[0]
                        first_stats = analyzer.analyze_single_fingerprint(
                            all_books_results[first_book]['values'],
                            first_book,
                            selected_metric_label
                        )
                        if first_stats:
                            style = first_stats.get('style_category', '未知')
                            primary_style = style.split("|")[0].strip() if "|" in style else style
                            st.markdown(f"""
                            <div class="metric-card" style="background: linear-gradient(135deg, #3498db, #2980b9);">
                                <h4 style="color: white; margin: 0;">📖 主要风格</h4>
                                <p style="color: white; font-size: 18px; margin: 10px 0;"><strong>{primary_style}</strong></p>
                            </div>
                            """, unsafe_allow_html=True)
                
                with insight_cols[1]:
                    if len(all_books_results) > 1 and 'most_unique_book' in comparison:
                        unique_book = comparison['most_unique_book']
                        short_unique = unique_book[:10] + "..." if len(unique_book) > 10 else unique_book
                        st.markdown(f"""
                        <div class="metric-card" style="background: linear-gradient(135deg, #e74c3c, #c0392b);">
                            <h4 style="color: white; margin: 0;">🎯 独特风格</h4>
                            <p style="color: white; font-size: 16px; margin: 10px 0;"><strong>{short_unique}</strong></p>
                        </div>
                        """, unsafe_allow_html=True)
                    else:
                        # 显示默认卡片
                        st.markdown(f"""
                        <div class="metric-card" style="background: linear-gradient(135deg, #95a5a6, #7f8c8d);">
                            <h4 style="color: white; margin: 0;">🎯 独特风格</h4>
                            <p style="color: white; font-size: 16px; margin: 10px 0;"><strong>需多书对比</strong></p>
                        </div>
                        """, unsafe_allow_html=True)
                
                with insight_cols[2]:
                    if len(all_books_results) > 1 and 'most_similar_pair' in comparison:
                        book1, book2 = comparison['most_similar_pair']
                        if book1 and book2:
                            short1 = book1[:8] + "..." if len(book1) > 8 else book1
                            short2 = book2[:8] + "..." if len(book2) > 8 else book2
                            st.markdown(f"""
                            <div class="metric-card" style="background: linear-gradient(135deg, #2ecc71, #27ae60);">
                                <h4 style="color: white; margin: 0;">👥 相似对</h4>
                                <p style="color: white; font-size: 14px; margin: 10px 0;"><strong>{short1} ↔ {short2}</strong></p>
                            </div>
                            """, unsafe_allow_html=True)
                    else:
                        # 显示默认卡片
                        st.markdown(f"""
                        <div class="metric-card" style="background: linear-gradient(135deg, #95a5a6, #7f8c8d);">
                            <h4 style="color: white; margin: 0;">👥 相似对</h4>
                            <p style="color: white; font-size: 14px; margin: 10px 0;"><strong>需多书对比</strong></p>
                        </div>
                        """, unsafe_allow_html=True)
                
                with insight_cols[3]:
                    if len(all_books_results) > 0:
                        total_blocks = sum(len(data['blocks']) for data in all_books_results.values())
                        st.markdown(f"""
                        <div class="metric-card" style="background: linear-gradient(135deg, #f39c12, #d35400);">
                            <h4 style="color: white; margin: 0;">📊 总块数</h4>
                            <p style="color: white; font-size: 24px; margin: 10px 0;"><strong>{total_blocks}</strong></p>
                        </div>
                        """, unsafe_allow_html=True)
                
                # --- 研究洞见 ---
                with st.expander("🔬 研究洞见与解读指南", expanded=False):
                    st.markdown("""
                    <div style="background: #f0f8ff; padding: 20px; border-radius: 10px; border: 1px solid #d6eaf8;">
                    <h4 style="color: #2c3e50;">🎨 颜色解读指南</h4>
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr style="background-color: #e3f2fd;">
                            <td style="padding: 8px; border: 1px solid #ddd;"><strong>🔵 蓝色区域</strong></td>
                            <td style="padding: 8px; border: 1px solid #ddd;">高值区域，表示复杂、描述性强的文本段落</td>
                        </tr>
                        <tr style="background-color: #ffebee;">
                            <td style="padding: 8px; border: 1px solid #ddd;"><strong>🔴 红色区域</strong></td>
                            <td style="padding: 8px; border: 1px solid #ddd;">低值区域，表示简洁、口语化或对话密集段落</td>
                        </tr>
                        <tr style="background-color: #f5f5f5;">
                            <td style="padding: 8px; border: 1px solid #ddd;"><strong>⚪ 白色区域</strong></td>
                            <td style="padding: 8px; border: 1px solid #ddd;">中间值，表示风格过渡或混合区域</td>
                        </tr>
                    </table>
                    
                    <h4 style="color: #2c3e50; margin-top: 20px;">📊 指标意义解析</h4>
                    <ul>
                        <li><strong>平均句长</strong>：衡量写作风格复杂度，值越高表示句子结构越复杂</li>
                        <li><strong>Simpson指数</strong>：评估词汇丰富度，值越低表示词汇多样性越高</li>
                        <li><strong>Hapax Legomena</strong>：测量词汇独特性，值越高表示作者使用独特词汇越多</li>
                        <li><strong>功能词PCA</strong>：分析虚词使用模式，反映作者的语法习惯</li>
                    </ul>
                    
                    <h4 style="color: #2c3e50; margin-top: 20px;">🎯 关键发现参考</h4>
                    <ul>
                        <li><strong>《哈克贝利·费恩》异常现象</strong>：验证了可视化方法的敏感性</li>
                        <li><strong>颜色模式稳定性</strong>：反映作者一致的写作风格</li>
                        <li><strong>颜色突变点</strong>：通常表示场景转换或风格变化</li>
                    </ul>
                    </div>
                    """, unsafe_allow_html=True)
                
                # --- 页脚信息 ---
                st.markdown('<hr class="section-divider">', unsafe_allow_html=True)
                st.markdown(f"""
                <div style="text-align: center; color: #7f8c8d; padding: 20px; background-color: #f8f9fa; border-radius: 10px;">
                    <p style="margin: 5px 0;">📅 分析完成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</p>
                    <p style="margin: 5px 0; font-size: 12px;">🔬 可视语言与信息可视化实验 | 基于 Keim & Oelke (2007) 论文</p>
                    <p style="margin: 5px 0; font-size: 11px;">📚 文学指纹分析系统 v1.0 | 技术支持: Python, Streamlit, NLTK</p>
                </div>
                """, unsafe_allow_html=True)

        except Exception as e:
            st.error(f"❌ 处理过程中出现错误: {e}")
            st.markdown("""
            <div style="background-color: #ffebee; padding: 15px; border-radius: 8px; border-left: 4px solid #e74c3c;">
                <h5 style="color: #c0392b; margin: 0;">🛠️ 故障排除建议</h5>
                <ul style="color: #7f8c8d;">
                    <li>检查上传文件是否为有效的文本文件</li>
                    <li>确保文件编码为 UTF-8</li>
                    <li>尝试重新上传文件</li>
                    <li>如果遇到 NLTK 错误，请尝试重新运行程序</li>
                </ul>
            </div>
            """, unsafe_allow_html=True)
            
    else:
        # 空状态美化
        st.markdown("""
        <div style="text-align: center; padding: 60px 20px; background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); border-radius: 15px; margin: 20px 0;">
            <div style="font-size: 80px; margin-bottom: 20px;">📚</div>
            <h2 style="color: #2c3e50;">欢迎使用文学指纹分析系统</h2>
            <p style="color: #7f8c8d; font-size: 16px; max-width: 600px; margin: 0 auto 30px;">
                上传您的文本文件，开始探索文学作品的隐藏模式和风格特征。
            </p>
            <div style="font-size: 40px; color: #3498db; margin: 30px 0;">👇</div>
            <p style="color: #7f8c8d; font-weight: bold;">请从左侧侧边栏上传一个或多个文本文件</p>
        </div>
        """, unsafe_allow_html=True)
        
        # 功能展示
        st.markdown('<hr class="section-divider">', unsafe_allow_html=True)
        st.markdown("### ✨ 核心功能展示")
        
        feature_col1, feature_col2, feature_col3 = st.columns(3)
        
        with feature_col1:
            st.markdown("""
            <div style="background: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); height: 100%;">
                <div style="font-size: 40px; color: #3498db; text-align: center; margin-bottom: 15px;">🔍</div>
                <h4 style="color: #2c3e50; text-align: center;">文学指纹可视化</h4>
                <ul style="color: #7f8c8d; font-size: 14px;">
                    <li>生成热力图指纹</li>
                    <li>颜色编码指标值</li>
                    <li>直观展示风格模式</li>
                    <li>支持多种分析指标</li>
                </ul>
            </div>
            """, unsafe_allow_html=True)
        
        with feature_col2:
            st.markdown("""
            <div style="background: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); height: 100%;">
                <div style="font-size: 40px; color: #2ecc71; text-align: center; margin-bottom: 15px;">📊</div>
                <h4 style="color: #2c3e50; text-align: center;">深度统计分析</h4>
                <ul style="color: #7f8c8d; font-size: 14px;">
                    <li>多维度指标计算</li>
                    <li>跨书对比分析</li>
                    <li>异常模式检测</li>
                    <li>风格分类识别</li>
                </ul>
            </div>
            """, unsafe_allow_html=True)
        
        with feature_col3:
            st.markdown("""
            <div style="background: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); height: 100%;">
                <div style="font-size: 40px; color: #f39c12; text-align: center; margin-bottom: 15px;">🔧</div>
                <h4 style="color: #2c3e50; text-align: center;">交互式探索</h4>
                <ul style="color: #7f8c8d; font-size: 14px;">
                    <li>文本块详细查看</li>
                    <li>高频词提取</li>
                    <li>参数灵活调整</li>
                    <li>实时结果更新</li>
                </ul>
            </div>
            """, unsafe_allow_html=True)
        
        # 示例展示
        st.markdown('<hr class="section-divider">', unsafe_allow_html=True)
        st.markdown("### 🎯 预期分析结果示例")
        
        example_tab1, example_tab2, example_tab3 = st.tabs(["作者风格对比", "异常检测", "指标解释"])
        
        with example_tab1:
            col_a1, col_a2 = st.columns(2)
            with col_a1:
                st.markdown("""
                <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 20px; border-radius: 10px; text-align: center;">
                    <h5 style="color: white;">马克·吐温</h5>
                    <p style="font-size: 14px; opacity: 0.9;">🔵 蓝色为主</p>
                    <p style="font-size: 12px;">复杂长句风格<br>平均句长: 20-25词</p>
                </div>
                """, unsafe_allow_html=True)
            with col_a2:
                st.markdown("""
                <div style="background: linear-gradient(135deg, #FF9A9E, #FAD0C4); color: #2c3e50; padding: 20px; border-radius: 10px; text-align: center;">
                    <h5 style="color: #2c3e50;">杰克·伦敦</h5>
                    <p style="font-size: 14px;">🔴 红色为主</p>
                    <p style="font-size: 12px;">简洁短句风格<br>平均句长: 15-18词</p>
                </div>
                """, unsafe_allow_html=True)
        
        with example_tab2:
            st.markdown("""
            <div style="background: #fff3cd; padding: 20px; border-radius: 10px; border-left: 5px solid #f39c12;">
                <h5 style="color: #d35400;">《哈克贝利·费恩》异常现象</h5>
                <p style="color: #7f8c8d; font-size: 14px;">
                <strong>📖 作者:</strong> 马克·吐温<br>
                <strong>🎨 指纹特征:</strong> 红色为主 (与其他吐温作品不同)<br>
                <strong>🔍 原因分析:</strong><br>
                • 第一人称儿童视角<br>
                • 大量口语方言使用<br>
                • 非标准语法结构<br>
                • 验证了可视化方法的敏感性
                </p>
            </div>
            """, unsafe_allow_html=True)
        
        with example_tab3:
            col_m1, col_m2, col_m3, col_m4 = st.columns(4)
            with col_m1:
                st.metric("平均句长", "风格复杂度", "值越高越复杂")
            with col_m2:
                st.metric("Simpson指数", "词汇多样性", "值越低越丰富")
            with col_m3:
                st.metric("Hapax Legomena", "词汇独特性", "值越高越独特")
            with col_m4:
                st.metric("功能词PCA", "语法习惯", "反映虚词使用模式")

if __name__ == "__main__":
    main()