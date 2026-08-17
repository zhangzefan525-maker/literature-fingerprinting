# 文学指纹 · Literature Fingerprinting

> 不用写代码，也能一眼看懂「不同作家的写作风格差在哪里」。

## 📖 产品介绍

### 这是什么？

「文学指纹」（Literature Fingerprinting）是 Keim & Oelke (2007) 提出的一种方法：把一部小说切成一段一段，计算每一段的平均句长、词汇丰富度等特征，再把这些特征画成像素块和交互图表。每个作家写作的习惯不同，画出来的「指纹」也就不一样——于是你就能直观地看到他们风格的差异。

本项目把它做成了一个开箱即用的网页工具：基于 Python 计算 + D3.js 交互图表，全程可视化操作。

### 能做什么？

- **分析自己的书**：上传任意一部英文小说（`.txt`），几秒钟生成它的「文学指纹」。
- **和名著对比**：与内置的 4 本示例名著（马克·吐温、杰克·伦敦各两本）并列对比。
- **层层下钻**：拖拽、点击、悬停，一路深入到具体段落，看这本书的高潮在哪、哪段最特别。

### 适合谁？

文学研究者、语言学习者、读书爱好者，以及任何想「用数据看文学」的人——**全程不需要写任何代码**。

## 🚀 基本使用步骤

1. **启动**：双击 `start.bat`。
2. **等待**：脚本会自动准备示例数据（首次运行约 1-2 分钟），然后自动打开浏览器。若页面还没加载出来，稍等几秒刷新一次。
3. **看示例**：页面顶部已内置 4 本名著，直接点击书名即可查看它们的指纹。
4. **分析自己的书**：点顶部的「上传文本分析」，选一个英文 `.txt` 文件，几秒后它就会出现在书名列表里，和示例书并列对比。

## 👀 怎么看这些图

1. **选书**：顶部点书名（可一次点多本），图表会自动变成多本书并排对比。
2. **看局部**：在右下角「趋势演变」图上按住鼠标左键左右拖拽，选出一段（比如某个章节），左边所有图会立刻只显示这一段的数据。
3. **看细节**：点任意柱子或线条，右侧会弹出这本书在这一段里数值最高的 3 个段落，附原文片段和关键词。
4. **排序与高亮**：点图表标题旁的排序图标可切换排序；鼠标悬停任一元素，相关的书会被高亮、其余自动变暗。

## 📊 这些指标是什么意思

- **平均句长（Average Sentence Length）**：一句话平均多少个单词，数值越大句子越长、越书面。
- **辛普森指数（Simpson's Index）**：词汇丰富度，越接近 0 用词越丰富，越接近 1 越重复。
- **孤词率（Hapax Legomena）**：只出现一次的词所占比例，越高说明「生僻/独特」用词越多。
- **功能词 PCA（Function Words PCA）**：看「的 / 和 / 是」这类高频小词的使用习惯，反映语法风格。

## ⚠️ 注意事项

- **只支持英文文本**：目前算法按英文设计，中文等其他语言的结果不可靠。
- **文件格式**：请用 `.txt` 纯文本，UTF-8 编码。
- **文本长度**：正文至少约 1 万词，建议几万字——书越长，趋势图越丰富；太短会无法生成指纹。
- **首次运行较慢**：第一次启动要生成示例数据，约 1-2 分钟，之后秒开。
- **页面打不开**：若浏览器没自动打开或页面空白，稍等几秒刷新；若仍不行，可能是 5000 端口被占用，关闭占用程序后重试。
- **隐私安全**：所有分析都在你本机完成，上传的文本不会被上传到任何服务器。

## 🛠️ 进阶（写给开发者）

技术栈：Python（Flask / NLTK / scikit-learn）+ D3.js 前端。

### 项目结构

```text
Literature-Fingerprinting/
├── data/                               # 数据存储
│   ├── raw/                            # 原始小说文本 (.txt)
│   └── processed/                      # 预处理后的 JSON 数据 (供前端 API 调用)
├── src/                                # Python 核心逻辑
│   ├── __init__.py
│   ├── data_loader.py                  # 文本清洗与滑动窗口切分
│   ├── metrics.py                      # 核心指标计算 (句长、Simpson、Hapax、PCA)
│   ├── pipeline.py                     # 共享数据处理管线 (批量生成与上传分析复用)
│   ├── visualizer.py                   # Matplotlib 静态绘图 (用于 Streamlit)
│   └── analyzer.py                     # 统计分析与异常检测模块
├── static/                             # D3.js 前端资源
│   ├── css/
│   │   └── d3-style.css                # 仪表盘样式表
│   └── js/
│       └── d3-charts.js                # D3.js 核心绘图与交互逻辑 (含 Dashboard)
├── tests/                              # 单元测试
│   └── test_metrics.py                 # 指标计算测试
├── app.py                              # Streamlit 经典版入口 (参数调优工作台，已归档/实验性)
├── api_server.py                       # Flask API 服务器 (D3 版入口)
├── generate_data.py                    # 批处理脚本 (Raw Text -> JSON)
├── d3_visualization.html               # D3 可视化主页面 HTML
├── requirements.txt                    # 项目依赖
└── start.bat                           # 快速启动
```

### 本地开发

环境要求：Python 3.10+（开发与测试环境为 Python 3.13）。

```bash
# 1. 克隆项目
git clone [repository_url]
cd Literature-Fingerprinting

# 2. 安装依赖
pip install -r requirements.txt

# 3. (可选) NLTK 数据包会自动下载，如遇网络问题可手动运行：
# python -c "import nltk; nltk.download('punkt'); nltk.download('stopwords')"
```

**手动启动**：预生成示例数据（服务器在首次请求时也会自动生成）：

```bash
python generate_data.py
```

再启动 API 服务器，然后访问 <http://localhost:5000/visualization>：

```bash
python api_server.py
```

**运行测试**：

```bash
python tests/test_metrics.py
```

**Streamlit 经典模式**（⚠️ 已归档，仅作实验性参考；正式产品为上方 D3 版，新用户无需关注）：

```bash
streamlit run app.py
```

### 参考资料

1. Keim, D. A., & Oelke, D. (2007). *Literature Fingerprinting: A New Method for Visual Literary Analysis*.
2. D3.js Gallery & Documentation.
3. Project Gutenberg (Text Source).
