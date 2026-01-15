# Literature Fingerprinting Program

#### 介绍

本项目旨在复现并增强 Keim 和 Oelke 提出的 “文学指纹”（Literature Fingerprinting）可视化方法。该方法通过将文本分割为固定大小的文本块，计算每个块的统计特征（如平均句长、词汇丰富度等），并将其映射为像素网格（Pixel Map）或交互式图表，从而直观地展示不同作家的写作风格差异。

**核心升级：**
我们在原有的 Python 分析引擎之上，全新构建了一套 **基于 D3.js + Flask 的全交互式 Web 可视化系统**。这使得系统不仅具备 Python 强大的数据处理能力，更拥有了 Web 端流畅、精细、多维联动的探索式分析体验。

#### 功能亮点

我们成功实现了从数据处理到交互展示的完整闭环：

- **多维度指标分析**：
  - **Average Sentence Length**: 平均句长（风格复杂度）
  - **Simpson's Index**: 辛普森指数（词汇丰富度）
  - **Hapax Legomena**: 孤词率（词汇独特性）
  - **Function Words PCA**: 功能词主成分分析（语法习惯）
- **深度综合分析仪表盘 (Advanced Dashboard)**：
  - **2x2 联动视图**：同步展示均值（Bar）、波动性（Bar）、分布（Box Plot）和趋势（Line Chart）。
  - **刷选联动 (Brushing & Linking)**：在趋势图上拖拽选区，所有其他图表实时更新，仅展示选中片段的统计特征（实现从宏观到微观的动态聚焦）。
  - **多图高亮 (Linked Highlighting)**：悬停任意元素，所有视图中对应的书籍同步高亮。
  - **深度钻取 (Details-on-Demand)**：点击图表元素，侧边栏展示该书在当前选区内的**Top 3 峰值文本块**及其**原文预览**。
- **灵活的对比模式**：支持单选查看详情，或多选进行并排对比（Small Multiples 热力图 / 多线折线图）。
- **RESTful API 架构**：前后端分离，数据通过 API 动态传输。

#### 软件架构

```
Literature-Fingerprinting/
├── data/                               # 数据存储
│   ├── raw/                            # 原始小说文本 (.txt)
│   └── processed/                      # 预处理后的 JSON 数据 (供前端 API 调用)
├── src/                                # Python 核心逻辑
│   ├── __init__.py
│   ├── data_loader.py                  # 文本清洗与滑动窗口切分
│   ├── metrics.py                      # 核心指标计算 (均值、Simpson、PCA等)
│   ├── visualizer.py                   # Matplotlib 静态绘图 (用于 Streamlit)
│   └── analyzer.py                     # 统计分析与异常检测模块
├── static/                             # D3.js 前端资源
│   ├── css/
│   │   └── d3-style.css                # 仪表盘样式表
│   └── js/
│       └── d3-charts.js                # D3.js 核心绘图与交互逻辑 (含 Dashboard)
├── app.py                              # Streamlit 经典版入口
├── api_server.py                       # Flask API 服务器 (D3 版入口)
├── generate_data.py                    # 批处理脚本 (Raw Text -> JSON)
├── d3_visualization.html               # D3 可视化主页面 HTML
├── requirements.txt  					# 项目依赖
├── start.bat                           # 快速启动
├── README.en.md                        # 项目文档(英文)
└── README.md                           # 项目文档(中文)
```

#### 安装教程

本项目基于 Python 3.8+ 开发。

```
# 1. 克隆项目
git clone [repository_url]
cd Literature-Fingerprinting

# 2. 安装依赖
pip install -r requirements.txt

# 3. (可选) NLTK 数据包会自动下载，如遇网络问题可手动运行：
# python -c "import nltk; nltk.download('punkt'); nltk.download('stopwords')"
```

#### 启动方式

**推荐：使用 D3.js 交互模式**

1. **数据预处理**（首次运行或文本更新后需要执行）：
   计算所有书籍的指纹数据并生成 JSON 文件。

   ```
   python generate_data.py
   ```

2. **启动 API 服务器**：
   开启 Flask 后端服务。

   ```
   python api_server.py
   ```

3. **访问系统**：
   打开浏览器访问：http://localhost:5000/visualization

------



**备选：使用 Streamlit 经典模式**
适合快速查看参数影响。

```
streamlit run app.py
```

#### 交互操作指南

1. **全局筛选与对比**：
   - 顶部点击书籍按钮（支持多选），下方图表自动切换为 **并列热力图** 或 **多线趋势图**。
   - 仪表盘顶部点击 "Jack London" / "Mark Twain" 胶囊，快速按作者筛选显示。
2. **区间刷选 (Brushing)**：
   - 在右下角 **“趋势演变”** 图表上，按住鼠标左键**水平拖拽**。
   - **效果**：创建一个灰色选区（如选择小说的高潮章节），左侧的均值图、波动图和箱线图将**实时重算**，只展示该选区内的数据。
3. **深度钻取 (Drill-down)**：
   - 点击任意柱状图或线条。
   - **效果**：右侧 **“钻取详情”** 面板弹出，列出该书在当前选区内数值最高的 3 个文本块，并显示其原文片段和关键词。支持多次点击不同书籍进行**多书详情堆叠对比**。
4. **排序与高亮**：
   - 点击均值/波动图标题旁的排序图标，切换 **数值降序** / **书名升序**。
   - 鼠标悬停在任意图表元素上，触发**全局联动高亮**，其他非相关元素自动变暗。

#### 实验结果验证

我们选取了 Jack London (*The Call of the Wild*, *White Fang*) 和 Mark Twain (*Tom Sawyer*, *Huckleberry Finn*) 的四本代表作进行验证。

1. **风格差异**：
   - **Jack London** (黄色/绿色)：在均值图中明显较低（~15-18词/句），波动性小，体现了其简洁有力的硬汉派风格。
   - **Mark Twain** (蓝色/红色)：在均值图中较高（~20-25词/句），体现了其描述性强的特点。
2. **特例复现 (\*Huckleberry Finn\* Anomaly)**：
   - 在 D3 仪表盘中，*Huckleberry Finn* (红色) 的均值虽然接近 Twain 的水平，但在 **热力图** 模式下，其色调分布与 *Tom Sawyer* (蓝色) 有显著差异，更偏向暖色调。
   - **解释**：这成功复现了论文结论——由于该书采用第一人称孩童视角和口语方言，其微观层面的“指纹”特征发生了偏移。

#### 团队分工

- **王屹坤 (数据工程)**：构建 data_loader.py，实现符合论文标准的滑动窗口切分算法；协助 JSON 数据结构设计。
- **张泽凡(算法实现)**：开发 metrics.py，实现 Simpson 指数、Hapax Legomena 等核心文学统计算法；优化关键词提取逻辑。
- **孙翌程(全栈可视分析)**：
  - 搭建 Flask + D3.js 架构。
  - 实现 d3-charts.js 中的**多视图联动**、**刷选重算**、**动态钻取**等高级交互逻辑。
  - 设计并美化前端 UI/UX。

#### 参考资料

1. Keim, D. A., & Oelke, D. (2007). *Literature Fingerprinting: A New Method for Visual Literary Analysis*.
2. D3.js Gallery & Documentation.
3. Project Gutenberg (Text Source).
