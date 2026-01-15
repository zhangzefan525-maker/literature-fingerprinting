# Literature Fingerprinting

#### 介绍

本项目旨在复现 Keim 和 Oelke 提出的 “文学指纹”（Literature Fingerprinting）可视化方法。该方法通过将文本分割为固定大小的文本块，计算每个块的统计特征（如平均句长、词汇丰富度等），并将其映射为像素网格（Pixel Map），从而直观地展示不同作家的写作风格差异。

**v2.0 更新：** 我们在原有的 Streamlit 分析系统基础上，新增了基于 **D3.js + Flask** 的 Web 可视化模块。这使得系统不仅具备 Python 的强大计算能力，还拥有了 D3.js 带来的极致前端交互体验（平滑过渡、动态热力图/折线图切换、SVG 导出等）。

我们成功实现了：

- **多维度指标分析**：平均句长、Simpson指数、Hapax Legomena、功能词PCA
- **双模态可视化**：
  - **Streamlit 版**：适合快速验证、参数调试和深度统计分析。
  - **D3.js 版（新增）**：提供 Web 级的高性能交互，支持鼠标悬停探针（Tooltip）、图表平滑过渡、视图动态切换。
- **深度分析功能**：风格分类、异常检测、相似性比较
- **RESTful API 支持**：实现了前后端分离的数据服务架构。

#### 软件架构

Literature-Fingerprinting/
├── data/ # 存放实验用小说文本
│ ├── raw/ # 原始文本 (.txt)
│ └── processed/ # [新增] 预处理后的 JSON 数据 (供 D3 使用)
├── src/ # 源代码目录
│ ├── **init**.py
│ ├── data_loader.py # [成员A] 数据加载与切分
│ ├── metrics.py # [成员B] 指标计算算法
│ ├── visualizer.py # [成员C] Matplotlib/Seaborn 绘图逻辑
│ └── analyzer.py # [新增] 指纹统计分析模块
├── static/ # [新增] D3.js 前端静态资源
│ ├── css/
│ │ └── d3-style.css # 可视化样式表
│ └── js/
│ └── d3-charts.js # D3.js 核心绘图逻辑
├── app.py # [成员C] Streamlit 前端主程序
├── api_server.py # [新增] Flask API 服务器 (为 D3 提供数据)
├── generate_data.py # [新增] 数据预处理脚本 (生成 JSON)
├── d3_visualization.html # [新增] D3 可视化入口页面
├── requirements.txt # 项目依赖库
└── README.md # 项目说明文档

#### 安装教程

本项目基于 Python 3.8+ 开发。请确保已安装 Python 环境。

```
# 1. 克隆或下载本项目
# 2. 安装依赖库
pip install -r requirements.txt

# 3. (可选) NLTK 数据包会自动下载，如遇网络问题可手动运行：
# python -c "import nltk; nltk.download('punkt'); nltk.download('stopwords')"
```

#### 启动方式

本项目支持两种启动模式，可根据需求选择。

### 模式一：D3.js 交互可视化（推荐体验）

这是新增的高级可视化模式，支持平滑动画和更精细的交互。

**第一步：生成数据**
运行数据预处理脚本，计算所有指标并生成 JSON 文件：

```
python generate_data.py
```

**第二步：启动 API 服务器**
启动 Flask 后端，提供数据接口：

```
python api_server.py
```

**第三步：访问**
浏览器访问：http://localhost:5000/visualization

------



### 模式二：Streamlit 分析仪表盘（经典模式）

适合进行参数调试（如调节 Block Size）和查看详细的统计报告。

```
streamlit run app.py
```

#### 使用说明

### 5.1 D3.js 新特性说明

- **视图切换**：点击界面上的下拉框，可以在 **"📈 折线趋势图"** 和 **"▦ 指纹热力图"** 之间无缝切换。
- **智能交互**：
  - **Tooltip**：鼠标悬停在数据点或色块上，实时显示文本块编号、指标具体数值及关键词。
  - **点击详情**：点击任意数据点，右侧面板会展示该文本块的**原文预览**及**高频关键词**。
- **平滑控制**：拖动 "平滑度" 滑块，可以对折线图进行移动平均处理，更清晰地观察风格趋势。
- **图像导出**：支持一键将当前 SVG 图表导出为 PNG 图片。

### 5.2 数据处理策略

- **切分策略**：遵循原论文标准，将整本小说切分为包含 10,000 个单词的文本块（Block），步长（Step）为 1,000 单词。
- **可视化映射**：
  - **热力图**：使用 D3 的 interpolateRdBu 双极色谱（自动归一化），红色代表低值，蓝色代表高值。
  - **自适应布局**：前端自动计算最佳网格行列数（接近正方形布局）。

## 6. 实验结果与验证 (Results & Validation)

我们选取了 Jack London 和 Mark Twain 的四本代表作进行验证。

### 6.1 风格差异验证

| 作家        | 作品                           | 可视化表现     | 风格分析                                        |
| ----------- | ------------------------------ | -------------- | ----------------------------------------------- |
| Jack London | *The Call of the Wild*         | 整体呈红色色调 | 简洁、有力的短句风格（平均句长约 15-18 词）     |
| Mark Twain  | *The Adventures of Tom Sawyer* | 整体呈蓝色色调 | 复杂、描述性强的长句风格（平均句长约 20-25 词） |

### 6.2 关键特例复现 (The "Huckleberry Finn" Anomaly)

- **对象**：Mark Twain 的 *The Adventures of Huckleberry Finn*
- **结果**：在 D3 热力图中，该书呈现出明显的暖色调（红色/浅色），与 Twain 的另一部作品 *Tom Sawyer* 形成鲜明对比。
- **结论**：完美复现了论文发现 —— 孩童视角与口语方言的使用，使得这部作品的“指纹”更接近于简洁风格。

#### 参与贡献

本项目由三人小组协作完成：

### 成员 A（数据处理）

- 负责 data_loader.py，实现了滑动窗口切分算法。
- **新增**：协助适配 JSON 数据格式，确保前后端数据对接。

### 成员 B（核心算法）

- 负责 metrics.py，实现了平均句长、Simpson指数、PCA 等核心算法。
- **新增**：优化了关键词提取算法，为前端 Tooltip 提供数据支持。

### 成员 C（全栈开发与集成）

- 负责 visualizer.py (Matplotlib) 和 app.py (Streamlit)。
- **新增**：引入 **Flask + D3.js** 技术栈。
- **新增**：编写 api_server.py 构建 RESTful API。
- **新增**：开发前端页面 (.html, .css, .js)，实现了动态热力图与交互逻辑。

## 8. 参考资料 (References)

1. Keim, D. A., & Oelke, D. (2007). *Literature Fingerprinting: A New Method for Visual Literary Analysis*. IEEE Symposium on Information Visualization.
2. D3.js Documentation: [https://d3js.org/](https://www.google.com/url?sa=E&q=https%3A%2F%2Fd3js.org%2F)
3. Flask Documentation: [https://flask.palletsprojects.com/](https://www.google.com/url?sa=E&q=https%3A%2F%2Fflask.palletsprojects.com%2F)
4. Streamlit Documentation: [https://docs.streamlit.io/](https://www.google.com/url?sa=E&q=https%3A%2F%2Fdocs.streamlit.io%2F)
