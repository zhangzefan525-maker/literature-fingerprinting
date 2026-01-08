# Literature Fingerprinting

#### 介绍
本项目旨在复现 Keim 和 Oelke 提出的 “文学指纹”（Literature Fingerprinting）可视化方法。该方法通过将文本分割为固定大小的文本块，计算每个块的统计特征（如平均句长、词汇丰富度等），并将其映射为像素网格（Pixel Map），从而直观地展示不同作家的写作风格差异。

我们利用 Python 和 Streamlit 搭建了一个交互式的可视分析系统，成功区分了 Jack London 和 Mark Twain 的写作风格，并复现了论文中关于《哈克贝利・费恩历险记》（*The Adventures of Huckleberry Finn*）风格异常的关键发现。

我们成功实现了：

多维度指标分析：平均句长、Simpson指数、Hapax Legomena、功能词PCA

交互式可视化：实时调整参数、块级详细查看、多书对比

深度分析功能：风格分类、异常检测、相似性比较

美观的Web界面：使用Streamlit构建，支持响应式设计

#### 软件架构

Literature-Fingerprinting/
├── data/                               # 存放实验用小说文本 (.txt)
│   ├── The call of the wild.txt        # Jack London
│   ├── White Fang.txt                  # Jack London
│   ├── The Adventures of Tom Sawyer.txt      # Mark Twain
│   └── The Adventures of Huckleberry Finn.txt # Mark Twain (特例验证)
├── src/                                # 源代码目录
│   ├── __init__.py
│   ├── data_loader.py                  # [成员A] 数据加载与切分
│   ├── metrics.py                      # [成员B] 指标计算算法
│   ├── visualizer.py                   # [成员C] 绘图逻辑实现
│   └── analyzer.py                     # [新增] 指纹分析模块
├── app.py                              # [成员C] Streamlit前端主程序
├── debug_tool.py                       # 调试工具
├── requirements.txt                    # 项目依赖库
├── start.bat                           # Windows一键启动脚本
├── README.md                           # 项目说明文档（中文）
└── README.en.md                        # 项目说明文档（英文）


#### 安装教程

本项目基于 Python 3.8+ 开发。请确保已安装 Python 环境。

```bash
# 1. 克隆或下载本项目
# 2. 安装依赖库
pip install -r requirements.txt

# 3. (可选) NLTK 数据包会自动下载，如遇网络问题可手动运行：
# python -c "import nltk; nltk.download('punkt'); nltk.download('stopwords')"
```

### 启动方式

#### 方式一：使用脚本一键启动（推荐）

双击项目根目录下的 `启动程序.bat` 即可自动打开浏览器。

#### 方式二：命令行启动

在终端（Terminal）中运行以下命令：

```bash
streamlit run app.py --server.port 8502
```


#### 使用说明

### 5.1 数据处理

- **切分策略**：遵循原论文标准，将整本小说切分为包含 10,000 个单词的文本块（Block），步长（Step）为 1,000 单词，即重叠部分（Overlap）为 9,000 单词。这保证了可视化的平滑性和连续性。

### 5.2 可视化映射

- **像素布局**：将一维的文本块序列排列为二维网格（近似正方形）。

- 颜色编码

  ：使用 RdBu（红 - 白 - 蓝）双极色谱：

  - 红色：代表低数值（如短句、低词汇多样性）
  - 蓝色：代表高数值（如长句、高词汇多样性）

- **统一标尺 (Unified Scale)**：为了进行跨书籍对比，我们在 “平均句长” 指标上固定了映射范围（vmin=10, vmax=35），避免因单本书的数据分布导致颜色偏差。

## 6. 实验结果与验证 (Results & Validation)

我们选取了 Jack London 和 Mark Twain 的四本代表作进行验证，实验结果成功复现了论文结论。

### 6.1 风格差异验证

| 作家        | 作品                           | 可视化表现     | 风格分析                                        |
| ----------- | ------------------------------ | -------------- | ----------------------------------------------- |
| Jack London | *The Call of the Wild*         | 整体呈红色色调 | 简洁、有力的短句风格（平均句长约 15-18 词）     |
| Mark Twain  | *The Adventures of Tom Sawyer* | 整体呈蓝色色调 | 复杂、描述性强的长句风格（平均句长约 20-25 词） |

### 6.2 关键特例复现 (The "Huckleberry Finn" Anomaly)

- **对象**：Mark Twain 的 *The Adventures of Huckleberry Finn*
- **结果**：尽管作者是 Twain，但热力图呈现出与 London 相似的大片红色
- **结论**：这完美复现了论文的核心发现 —— 由于该书采用第一人称（孩童视角）和大量口语方言写作，其 “文学指纹” 实际上偏离了 Twain 的惯用风格，而更接近简洁风格。这证明了本可视化系统能够深入揭示文本的内在属性。

## 7. 交互功能 (Interactive Features)

1. **参数调节**：支持用户自定义 Block Size 和 Overlap，探索不同粒度下的可视化效果。
2. **Block Inspector**：在前端右侧实现了交互式探针，用户拖动滑块即可定位到具体的像素点，查看该文本块对应的原始文本片段及具体数值。
3. **统一标尺控制**：支持开启 / 关闭 Unified Scale，灵活切换 “单书对比” 和 “跨书对比” 模式。

#### 参与贡献


本项目由三人小组协作完成，代码结构清晰，模块化程度高。

### 成员 A（数据处理）

- 负责 `src/data_loader.py`
- 实现了 `load_clean_text` 和 `get_blocks` 接口
- 完成了文本清洗、分词，以及按论文要求的 “滑动窗口”（Sliding Window）切分算法（Block Size=10000, Overlap=9000）

### 成员 B（核心算法）

- 负责 `src/metrics.py`
- 实现了多种文本特征计算算法，包括：
  - 平均句长（Average Sentence Length）
  - Simpson's Index（词汇多样性）
  - Hapax Legomena（仅出现一次的词汇数）
  - 基于功能词的 PCA 分析
- 配置了 `requirements.txt` 依赖环境

### 成员 C（可视化与前端集成）

- 负责 `src/visualizer.py` 和 `app.py`
- 设计了基于 Seaborn 和 Matplotlib 的热力图绘制逻辑，实现了自适应网格布局与双极色谱映射
- 搭建了 Streamlit 交互式 Web 应用，集成了成员 A 和 B 的模块
- 实现了交互式细节查看（Block Inspector）与统一标尺（Unified Scale）控制

## 8. 参考资料 (References)

1. Keim, D. A., & Oelke, D. (2007). *Literature Fingerprinting: A New Method for Visual Literary Analysis*. IEEE Symposium on Information Visualization.
2. Streamlit Documentation: https://docs.streamlit.io/
3. NLTK Documentation: https://www.nltk.org/
#### 特技

1.  使用 Readme\_XXX.md 来支持不同的语言，例如 Readme\_en.md, Readme\_zh.md
2.  Gitee 官方博客 [blog.gitee.com](https://blog.gitee.com)
3.  你可以 [https://gitee.com/explore](https://gitee.com/explore) 这个地址来了解 Gitee 上的优秀开源项目
4.  [GVP](https://gitee.com/gvp) 全称是 Gitee 最有价值开源项目，是综合评定出的优秀开源项目
5.  Gitee 官方提供的使用手册 [https://gitee.com/help](https://gitee.com/help)
6.  Gitee 封面人物是一档用来展示 Gitee 会员风采的栏目 [https://gitee.com/gitee-stars/](https://gitee.com/gitee-stars/)
