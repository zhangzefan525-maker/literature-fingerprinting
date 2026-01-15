// static/js/d3-charts.js

// API配置
const API_BASE_URL = 'http://localhost:5000';
const API_ENDPOINTS = {
    fingerprintData: `${API_BASE_URL}/api/fingerprint-data`,
    books: `${API_BASE_URL}/api/books`
};

// 全局变量
let realData = null;
let currentMetric = 'sentenceLength';
let selectedBooks = new Set(); 
let comparisonMode = false;
let smoothness = 3;
let chartType = 'line';
// 初始化
document.addEventListener('DOMContentLoaded', function() {
    initEventListeners();
    loadBooksList();
});

// 初始化事件监听器
function initEventListeners() {
    // 加载真实数据
    document.getElementById('loadRealData').addEventListener('click', loadRealData);
    
    // 切换视图
    document.getElementById('toggleView').addEventListener('click', toggleMetric);
    
    // 切换对比模式
    document.getElementById('toggleComparison').addEventListener('click', toggleComparisonMode);
    
    // 指标选择
    document.getElementById('metricSelect').addEventListener('change', function(e) {
        currentMetric = e.target.value;
        if (realData) {
            initChart();
        }
    });
    
    // 平滑度调整
    document.getElementById('smoothness').addEventListener('input', function(e) {
        smoothness = parseInt(e.target.value);
        if (realData) {
            initChart();
        }
    });
    
    // 导出图像
    document.getElementById('exportBtn').addEventListener('click', exportChart);

    // 新增：图表类型切换监听
    document.getElementById('chartTypeSelect').addEventListener('change', function(e) {
        chartType = e.target.value;
        if (realData) {
            initChart();
        }
        
        // 热力图模式下，隐藏多书对比按钮（热力图通常只看一本书）
        const compareBtn = document.getElementById('toggleComparison');
        if (chartType === 'heatmap') {
            compareBtn.style.display = 'none';
            comparisonMode = false; // 强制单书模式
        } else {
            compareBtn.style.display = 'block';
        }
    });
}

// 加载书籍列表
async function loadBooksList() {
    try {
        const response = await fetch(API_ENDPOINTS.books);
        const data = await response.json();
        
        if (data.status === 'success') {
            updateBookSelector(data.books);
        } else {
            console.error('加载书籍列表失败:', data.message);
            showError('无法加载书籍列表，请检查API服务器是否运行');
        }
    } catch (error) {
        console.error('网络错误:', error);
        showError('无法连接到API服务器，请确保已运行 python api_server.py');
    }
}

// static/js/d3-charts.js

function updateBookSelector(books) {
    const selector = document.getElementById('bookSelector');
    if (!books || books.length === 0) {
        selector.innerHTML = '<p style="color: #e74c3c;">⚠️ 没有找到任何书籍...</p>';
        return;
    }
    
    const buttons = books.map(book => `
        <div class="book-btn" data-id="${book.id}" onclick="selectBook('${book.id}')">
            ${book.name}
        </div>
    `).join('');
    
    selector.innerHTML = buttons;
    
    // 默认选中第一本书
    if (books.length > 0) {
        selectBook(books[0].id); 
    }
}

// static/js/d3-charts.js

function selectBook(bookId) {
    const btn = document.querySelector(`.book-btn[data-id='${bookId}']`);
    
    if (selectedBooks.has(bookId)) {
        // 如果已经选中，且不是唯一选中的书，则取消选中
        if (selectedBooks.size > 1) {
            selectedBooks.delete(bookId);
            btn.classList.remove('active');
        }
    } else {
        // 如果未选中，则添加
        selectedBooks.add(bookId);
        btn.classList.add('active');
    }

    // 更新对比模式提示文字
    const compareBtn = document.getElementById('toggleComparison');
    if (selectedBooks.size > 1) {
        compareBtn.innerHTML = `📚 当前对比模式：已选 ${selectedBooks.size} 本书`;
        comparisonMode = true;
    } else {
        compareBtn.innerHTML = '🆚 点击上方按钮可多选进行对比';
        comparisonMode = false;
    }
    
    // 刷新图表
    if (realData) {
        initChart();
    }
    // 如果还没加载数据，这里不操作，等点击“加载真实数据”时会读取 selectedBooks
}

async function loadRealData() {
    try {
        showLoading('正在加载数据...');
        
        const response = await fetch(API_ENDPOINTS.fingerprintData);
        const data = await response.json();
        
            if (data.status === 'success') {
        realData = data.data;
        showSuccess(`成功加载 ${Object.keys(realData).length} 本书籍的数据`);
        
        // 确保 selectedBooks 中的书在数据中存在
        const availableBooks = Object.keys(realData);
        if (selectedBooks.size === 0 && availableBooks.length > 0) {
            selectBook(availableBooks[0]); // 如果没选，默认选第一本
        }
        
        initChart();
    } else {
            showError('加载数据失败: ' + data.message);
        }
    } catch (error) {
        console.error('加载数据失败:', error);
        showError('无法加载数据，请检查API服务器是否运行在 http://localhost:5000');
    }
}

function initChart() {
    const svg = d3.select("#main-chart");
    svg.selectAll("*").remove();

    if (!realData || selectedBooks.size === 0) return;

    // 准备绘图数据：提取所有被选中的书的数据
    const booksArray = Array.from(selectedBooks);
    
    if (chartType === 'heatmap') {
        drawMultiHeatmap(svg, booksArray); // 新增的多图绘制函数
    } else {
        drawMultiLineChart(svg, booksArray); // 新增的多线绘制函数
    }
}

// --- 修改 6: 绘制多条折线图 ---
function drawMultiLineChart(svg, booksArray) {
    // 1. 数据准备
    const chartData = booksArray.map(bookId => ({
        book: bookId,
        values: realData[bookId][currentMetric] || []
    })).filter(d => d.values.length > 0);

    if (chartData.length === 0) { showNoDataMessage(); return; }

    // 2. 设置尺寸
    const containerWidth = svg.node().parentNode.getBoundingClientRect().width;
    const height = 400;
    const margin = { top: 40, right: 120, bottom: 50, left: 60 }; // 右侧留出图例空间
    const width = containerWidth - margin.left - margin.right;

    svg.attr("viewBox", `0 0 ${containerWidth} ${height}`);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // 3. 计算全局比例尺 (所有书的最大最小值)
    const maxBlocks = d3.max(chartData, d => d.values.length - 1);
    const allValues = chartData.flatMap(d => d.values.map(v => v.value));
    const yMin = d3.min(allValues) * 0.95;
    const yMax = d3.max(allValues) * 1.05;

    const xScale = d3.scaleLinear().domain([0, maxBlocks]).range([0, width]);
    const yScale = d3.scaleLinear().domain([yMin, yMax]).range([height - margin.top - margin.bottom, 0]);

    // 颜色比例尺
    const colorScale = d3.scaleOrdinal(d3.schemeCategory10).domain(booksArray);

    // 4. 绘制坐标轴
    const chartHeight = height - margin.top - margin.bottom;
    g.append("g").attr("transform", `translate(0,${chartHeight})`).call(d3.axisBottom(xScale));
    g.append("g").call(d3.axisLeft(yScale));
    
    // 添加网格线
    g.append("g").attr("class", "grid").call(d3.axisLeft(yScale).tickSize(-width).tickFormat("")).attr("stroke-opacity", 0.1);

    // 5. 绘制线条
    const line = d3.line()
        .x((d, i) => xScale(i))
        .y(d => yScale(d.value))
        .curve(d3.curveMonotoneX); // 平滑曲线

    chartData.forEach(bookData => {
        // 数据平滑
        const smoothed = smoothData(bookData.values, smoothness);
        
        // 画线
        g.append("path")
            .datum(smoothed)
            .attr("fill", "none")
            .attr("stroke", colorScale(bookData.book))
            .attr("stroke-width", 2.5)
            .attr("d", line)
            .style("opacity", 0.8)
            // 鼠标悬停加粗效果
            .on("mouseover", function() { d3.select(this).attr("stroke-width", 5); })
            .on("mouseout", function() { d3.select(this).attr("stroke-width", 2.5); });
            
        // (可选) 可以在这里添加散点，但多条线时点会很乱，建议省略或只在Hover时显示
    });

    // 6. 绘制右侧图例
    const legend = svg.append("g").attr("transform", `translate(${width + 20}, ${margin.top})`);
    chartData.forEach((d, i) => {
        const row = legend.append("g").attr("transform", `translate(0, ${i * 25})`);
        row.append("rect").attr("width", 15).attr("height", 15).attr("fill", colorScale(d.book));
        row.append("text").attr("x", 20).attr("y", 12).text(d.book).style("font-size", "12px").style("fill", "#333");
    });
    
    // 标题
    svg.append("text")
        .attr("x", containerWidth / 2)
        .attr("y", 25)
        .attr("text-anchor", "middle")
        .style("font-size", "16px")
        .style("font-weight", "bold")
        .text(`${getMetricLabel(currentMetric)} - 对比分析`);
}

// --- 修改 7: 绘制并列热力图 (Small Multiples) ---
// --- 修改 7: 绘制并列热力图 (修复版：自适应高度 + 修复重叠) ---
function drawMultiHeatmap(svg, booksArray) {
    const containerWidth = svg.node().parentNode.getBoundingClientRect().width;
    const padding = 20; // 图表左右间距
    const topMargin = 80; // 增加顶部边距，给主标题和子标题留出空间
    const bottomMargin = 50; // 底部边距
    
    // 1. 计算每个小图的宽度
    // (总宽 - 左边距 - 右边距 - 中间间隙) / 数量
    const chartWidth = (containerWidth - 60 - (booksArray.length - 1) * padding) / booksArray.length;
    
    // 2. 预计算最大行数和块大小，以确定 SVG 的总高度
    let maxRows = 0;
    let finalBlockSize = 0;
    
    booksArray.forEach(bookId => {
        const data = realData[bookId][currentMetric];
        const n = data.length;
        const cols = Math.ceil(Math.sqrt(n)); 
        const rows = Math.ceil(n / cols);
        const blockSize = Math.floor(chartWidth / cols);
        
        if (rows > maxRows) maxRows = rows;
        // 取第一本书计算出的块大小作为参考（或者取最小的以适应所有）
        if (finalBlockSize === 0) finalBlockSize = blockSize; 
    });
    
    // 动态计算 SVG 高度：顶部边距 + (行数 * 块大小) + 底部边距
    // 至少保证有 400px 高度
    const totalHeight = Math.max(400, topMargin + (maxRows * finalBlockSize) + bottomMargin);
    
    // 设置 SVG 尺寸
    svg.attr("viewBox", `0 0 ${containerWidth} ${totalHeight}`)
       .style("height", totalHeight + "px"); // 显式设置 CSS 高度
    
    // 3. 计算全局颜色映射范围 (Unified Scale)
    let globalMin = Infinity, globalMax = -Infinity;
    booksArray.forEach(bookId => {
        const vals = realData[bookId][currentMetric].map(d => d.value);
        globalMin = Math.min(globalMin, Math.min(...vals));
        globalMax = Math.max(globalMax, Math.max(...vals));
    });
    
    const colorScale = d3.scaleSequential()
        .interpolator(d3.interpolateRdBu)
        .domain([globalMin, globalMax]); 

    // 4. 循环绘制每个子图
    booksArray.forEach((bookId, index) => {
        const data = realData[bookId][currentMetric];
        
        // 创建子图组，向下移动 topMargin 的距离
        const g = svg.append("g")
            .attr("transform", `translate(${30 + index * (chartWidth + padding)}, ${topMargin})`);
            
        // 计算网格
        const n = data.length;
        const cols = Math.ceil(Math.sqrt(n)); 
        const blockSize = Math.floor(chartWidth / cols);
        
        // 绘制方块
        g.selectAll("rect")
            .data(data)
            .enter()
            .append("rect")
            .attr("class", "heatmap-rect")
            .attr("x", (d, i) => (i % cols) * blockSize)
            .attr("y", (d, i) => Math.floor(i / cols) * blockSize)
            .attr("width", blockSize)
            .attr("height", blockSize)
            .attr("fill", d => colorScale(d.value))
            // 交互
            .on("mouseover", function(event, d) { 
                // 热力图特殊处理：稍微调亮边框
                d3.select(this).style("stroke", "#f1c40f").style("stroke-width", "2px");
                showTooltip(event, d, bookId); 
            })
            .on("mouseout", function() {
                d3.select(this).style("stroke", "white").style("stroke-width", "1px");
                hideTooltip();
            })
            .on("click", function(event, d) { showDetail(d, bookId); });

        // 子图标题 (书名) - 放在热力图上方 20px 处
        g.append("text")
            .attr("x", (cols * blockSize) / 2)
            .attr("y", -20) 
            .attr("text-anchor", "middle")
            .style("font-size", "14px")
            .style("font-weight", "bold")
            .style("fill", "#333")
            .text(bookId.length > 18 ? bookId.substring(0, 15) + "..." : bookId); 
    });

    // 5. 绘制主标题 - 放在最顶部 (y=30)
    svg.append("text")
        .attr("x", containerWidth / 2)
        .attr("y", 30) 
        .attr("text-anchor", "middle")
        .style("font-size", "18px")
        .style("font-weight", "bold")
        .style("fill", "#2c3e50")
        .text(`${getMetricLabel(currentMetric)} - 指纹对比 (统一色标: ${globalMin.toFixed(1)} ~ ${globalMax.toFixed(1)})`);
}


function drawHeatmap(svg) {
    // 确保有选中的书
    if (!currentBook || !realData[currentBook]) {
        showNoDataMessage();
        return;
    }

    const data = realData[currentBook][currentMetric] || [];
    if (data.length === 0) return;

    // --- 1. 计算网格布局 ---
    const n = data.length;
    // 计算列数：取平方根向上取整，让它接近正方形
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);

    // --- 2. 设置尺寸 ---
    const containerWidth = svg.node().parentNode.getBoundingClientRect().width;
    const margin = { top: 40, right: 30, bottom: 20, left: 30 };
    
    // 计算每个方块的大小 (根据宽度自适应)
    const blockSize = Math.floor((containerWidth - margin.left - margin.right) / cols);
    const width = cols * blockSize + margin.left + margin.right;
    const height = rows * blockSize + margin.top + margin.bottom;

    // 调整 SVG 大小
    svg.attr("viewBox", `0 0 ${width} ${height}`)
       .style("height", height + "px"); // 强制高度适应

    const g = svg.append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // --- 3. 颜色比例尺 (RdBu) ---
    // 提取所有值来确定最大最小值
    const values = data.map(d => d.value);
    const extent = d3.extent(values);
    
    // 使用 Red-White-Blue 插值器 (类似于 Seaborn 的 RdBu)
    // 注意：d3.interpolateRdBu 通常 0 是红，1 是蓝。
    // 如果想要 低值=红，高值=蓝，直接映射即可。
    const colorScale = d3.scaleSequential()
        .interpolator(d3.interpolateRdBu)
        .domain([extent[0], extent[1]]); // domain 对应 min -> max

    // --- 4. 绘制方块 ---
    g.selectAll("rect")
        .data(data)
        .enter()
        .append("rect")
        .attr("class", "heatmap-rect")
        .attr("x", (d, i) => (i % cols) * blockSize)
        .attr("y", (d, i) => Math.floor(i / cols) * blockSize)
        .attr("width", blockSize)
        .attr("height", blockSize)
        .attr("fill", d => colorScale(d.value))
        .on("mouseover", function(event, d) {
            // 鼠标悬停变色 (CSS处理了边框，这里处理Tooltip)
            showTooltip(event, d, currentBook);
        })
        .on("mouseout", function() {
            hideTooltip();
        })
        .on("click", function(event, d) {
            showDetail(d, currentBook);
        });

    // --- 5. 添加标题 ---
    g.append("text")
        .attr("x", (width - margin.left - margin.right) / 2)
        .attr("y", -15)
        .attr("text-anchor", "middle")
        .style("font-size", "16px")
        .style("font-weight", "bold")
        .style("fill", "#2c3e50")
        .text(`${currentBook} - ${getMetricLabel(currentMetric)} (指纹图)`);
        
    // --- 6. 简单的图例 (Gradient Bar) ---
    const legendWidth = 200;
    const legendHeight = 10;
    
    // 创建线性渐变定义
    const defs = svg.append("defs");
    const linearGradient = defs.append("linearGradient")
        .attr("id", "linear-gradient");
    
    // 渐变色停止点
    linearGradient.selectAll("stop")
        .data([
            {offset: "0%", color: colorScale(extent[0])},
            {offset: "50%", color: colorScale((extent[0]+extent[1])/2)},
            {offset: "100%", color: colorScale(extent[1])}
        ])
        .enter().append("stop")
        .attr("offset", d => d.offset)
        .attr("stop-color", d => d.color);

    // 绘制图例矩形
    const legendG = g.append("g")
        .attr("transform", `translate(${(width - margin.left - margin.right)/2 - legendWidth/2}, ${rows * blockSize + 10})`);
        
    legendG.append("rect")
        .attr("width", legendWidth)
        .attr("height", legendHeight)
        .style("fill", "url(#linear-gradient)");
        
    // 图例文本 (Min / Max)
    legendG.append("text")
        .attr("x", -10)
        .attr("y", 10)
        .style("text-anchor", "end")
        .style("font-size", "10px")
        .text(extent[0].toFixed(2));
        
    legendG.append("text")
        .attr("x", legendWidth + 10)
        .attr("y", 10)
        .style("text-anchor", "start")
        .style("font-size", "10px")
        .text(extent[1].toFixed(2));
}

// 初始化图表
function drawLineChart(svg) {
    
    // 获取当前数据
      let chartData;
    if (comparisonMode) {
        chartData = Object.keys(realData).map(book => ({
            book: book,
            values: realData[book][currentMetric] || []
        })).filter(d => d.values.length > 0);
    } else if (currentBook && realData[currentBook]) {
        chartData = [{
            book: currentBook,
            values: realData[currentBook][currentMetric] || []
        }];
    } else {
        showNoDataMessage();
        return;
    }
    
    // 设置图表尺寸
    const width = svg.node().getBoundingClientRect().width;
    const height = 400;
    const margin = { top: 40, right: 30, bottom: 50, left: 60 };
    
    svg.attr("viewBox", `0 0 ${width} ${height}`)
       .attr("preserveAspectRatio", "xMidYMid meet");
    
    const g = svg.append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);
    
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;
    
    // 创建比例尺
    const maxBlocks = d3.max(chartData, d => d.values.length - 1);
    const xScale = d3.scaleLinear()
        .domain([0, maxBlocks])
        .range([0, chartWidth]);
    
    const allValues = chartData.flatMap(d => d.values.map(v => v.value));
    const yScale = d3.scaleLinear()
        .domain([d3.min(allValues) * 0.95, d3.max(allValues) * 1.05])
        .range([chartHeight, 0]);
    
    // 创建颜色比例尺
    const colorScale = d3.scaleOrdinal()
        .domain(chartData.map(d => d.book))
        .range(['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c']);
    
    // 创建线生成器
    const line = d3.line()
        .x((d, i) => xScale(i))
        .y(d => yScale(d.value))
        .curve(d3.curveMonotoneX);
    
    // 添加网格线
    g.append("g")
        .attr("class", "grid")
        .attr("transform", `translate(0,${chartHeight})`)
        .call(d3.axisBottom(xScale)
            .tickSize(-chartHeight)
            .tickFormat("")
        )
        .selectAll("line")
        .attr("stroke", "#eee")
        .attr("stroke-dasharray", "3,3");
    
    g.append("g")
        .attr("class", "grid")
        .call(d3.axisLeft(yScale)
            .tickSize(-chartWidth)
            .tickFormat("")
        )
        .selectAll("line")
        .attr("stroke", "#eee")
        .attr("stroke-dasharray", "3,3");
    
    // 添加坐标轴
    g.append("g")
        .attr("transform", `translate(0,${chartHeight})`)
        .call(d3.axisBottom(xScale))
        .append("text")
        .attr("x", chartWidth / 2)
        .attr("y", 40)
        .attr("fill", "#2c3e50")
        .attr("font-weight", "bold")
        .style("text-anchor", "middle")
        .text("文本块序列");
    
    g.append("g")
        .call(d3.axisLeft(yScale))
        .append("text")
        .attr("transform", "rotate(-90)")
        .attr("x", -chartHeight / 2)
        .attr("y", -40)
        .attr("fill", "#2c3e50")
        .attr("font-weight", "bold")
        .style("text-anchor", "middle")
        .text(getMetricLabel(currentMetric));
    
    // 绘制每条线
    chartData.forEach(bookData => {
        // 平滑处理
        const smoothedData = smoothData(bookData.values, smoothness);
        
        // 绘制线
        g.append("path")
            .datum(smoothedData)
            .attr("fill", "none")
            .attr("stroke", colorScale(bookData.book))
            .attr("stroke-width", 3)
            .attr("opacity", 0.8)
            .attr("d", line);
        
        // 添加数据点
        g.selectAll(`.point-${bookData.book.replace(/\s+/g, '-')}`)
            .data(bookData.values)
            .enter()
            .append("circle")
            .attr("class", `data-point point-${bookData.book.replace(/\s+/g, '-')}`)
            .attr("cx", (d, i) => xScale(i))
            .attr("cy", d => yScale(d.value))
            .attr("r", 4)
            .attr("fill", colorScale(bookData.book))
            .attr("stroke", "white")
            .attr("stroke-width", 2)
            .style("cursor", "pointer")
            .on("mouseover", function(event, d) {
                showTooltip(event, d, bookData.book);
                d3.select(this)
                    .transition()
                    .duration(200)
                    .attr("r", 6)
                    .attr("fill", "#f1c40f");
            })
            .on("mouseout", function(event, d) {
                hideTooltip();
                d3.select(this)
                    .transition()
                    .duration(200)
                    .attr("r", 4)
                    .attr("fill", colorScale(bookData.book));
            })
            .on("click", function(event, d) {
                showDetail(d, bookData.book);
            });
    });
    
    // 更新图例
  const legend = document.getElementById('legend');
}

// 工具函数
function smoothData(data, windowSize) {
    if (windowSize <= 1 || !data || data.length === 0) return data;
    
    return data.map((d, i, arr) => {
        const start = Math.max(0, i - Math.floor(windowSize / 2));
        const end = Math.min(arr.length, i + Math.floor(windowSize / 2) + 1);
        const windowData = arr.slice(start, end);
        const avg = windowData.reduce((sum, item) => sum + item.value, 0) / windowData.length;
        
        return {
            ...d,
            value: avg
        };
    });
}

function showTooltip(event, data, bookName) {
    const tooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("opacity", 0)
        .style("left", (event.pageX + 10) + "px")
        .style("top", (event.pageY - 10) + "px");
    
    tooltip.html(`
        <div style="margin-bottom: 5px;">
            <strong>${bookName}</strong>
        </div>
        <div style="margin-bottom: 3px;">
            <strong>文本块:</strong> ${data.block + 1}
        </div>
        <div style="margin-bottom: 3px;">
            <strong>${getMetricLabel(currentMetric)}:</strong> ${data.value}
        </div>
        ${data.keywords ? `<div style="margin-top: 5px;"><strong>关键词:</strong> ${data.keywords.join(', ')}</div>` : ''}
    `);
    
    tooltip.transition()
        .duration(200)
        .style("opacity", 1);
}

function hideTooltip() {
    d3.selectAll(".tooltip")
        .transition()
        .duration(200)
        .style("opacity", 0)
        .remove();
}

function showDetail(data, bookName) {
    const detailPanel = document.getElementById('detailPanel');
    
    const detailHTML = `
        <div class="detail-card">
            <h3>📖 ${bookName}</h3>
            <p><strong>文本块编号:</strong> #${data.block + 1}</p>
            <div class="value">${data.value}</div>
            <p><strong>${getMetricLabel(currentMetric)}</strong></p>
            
            ${data.keywords && data.keywords.length > 0 ? `
            <div style="margin: 15px 0;">
                <h4>🔑 关键词</h4>
                <div class="keywords">
                    ${data.keywords.map(keyword => 
                        `<span class="keyword-tag">${keyword}</span>`
                    ).join('')}
                </div>
            </div>` : ''}
            
            ${data.preview ? `
            <div>
                <h4>📄 原文片段</h4>
                <p style="margin-top: 10px; color: #7f8c8d; font-style: italic;">
                    "${data.preview}"
                </p>
            </div>` : ''}
        </div>
    `;
    
    detailPanel.innerHTML = `
        <h3>📊 数据详情</h3>
        <p>当前选择：${bookName} - ${getMetricLabel(currentMetric)}</p>
        ${detailHTML}
    `;
}

function updateLegend(books, colorScale) {
    const legend = document.getElementById('legend');
    legend.innerHTML = '<h4 style="margin-right: 15px;">📚 图例：</h4>' + 
        books.map(book => `
            <div class="legend-item">
                <div class="legend-color" style="background: ${colorScale(book)}"></div>
                <span>${book}</span>
            </div>
        `).join('');
}

function getMetricLabel(metric) {
    const labels = {
        sentenceLength: '平均句长 (词/句)',
        simpsonIndex: 'Simpson指数',
        hapaxLegomena: 'Hapax Legomena',
        functionWords: '功能词PCA得分'
    };
    return labels[metric] || metric;
}

function toggleMetric() {
    const metrics = ['sentenceLength', 'simpsonIndex', 'hapaxLegomena', 'functionWords'];
    const current = document.getElementById('metricSelect').value;
    const currentIndex = metrics.indexOf(current);
    const nextIndex = (currentIndex + 1) % metrics.length;
    
    document.getElementById('metricSelect').value = metrics[nextIndex];
    currentMetric = metrics[nextIndex];
    
    if (realData) {
        initChart();
    }
}

function toggleComparisonMode() {
    comparisonMode = !comparisonMode;
    const button = document.getElementById('toggleComparison');
    button.innerHTML = comparisonMode ? 
        '📖 点击切换到单书分析模式' : 
        '🆚 点击切换到多书对比模式';
    
    if (realData) {
        initChart();
    }
}

// static/js/d3-charts.js

// --- 替换原有的 exportChart 函数 ---

function exportChart() {
    const svg = document.getElementById('main-chart');
    if (!svg) {
        showError("找不到图表元素");
        return;
    }

    // 1. 获取 SVG 的 XML 字符串
    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svg);

    // 2. 补全命名空间（防止某些浏览器解析失败）
    if(!source.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)){
        source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    // 3. 处理 CSS 样式丢失问题 (将 d3-style.css 中的关键样式内联进去)
    // 主要是针对热力图的白色边框效果
    const styleString = `
        <style>
            text { font-family: 'Microsoft YaHei', sans-serif; }
            .heatmap-rect { stroke: white; stroke-width: 1px; }
            .axis path, .axis line { fill: none; stroke: #000; shape-rendering: crispEdges; }
        </style>`;
    source = source.replace('</svg>', styleString + '</svg>');

    // 4. 关键修复：解决中文乱码导致 btoa 报错的问题
    // 使用 encodeURIComponent 而不是 btoa
    const imageSrc = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const img = new Image();

    // 5. 提高导出图片的分辨率 (2倍清晰度)
    const svgRect = svg.getBoundingClientRect();
    const scaleFactor = 2; 
    canvas.width = svgRect.width * scaleFactor;
    canvas.height = svgRect.height * scaleFactor;

    img.onload = function() {
        // 6. 绘制白色背景 (防止 PNG 透明背景变黑)
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        
        // 绘制图像
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        // 7. 触发下载
        const link = document.createElement('a');
        // 生成带时间戳的文件名
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const bookName = currentBook ? currentBook.replace(/\s+/g, '_') : 'Comparison';
        
        link.download = `文印_${bookName}_${chartType}_${timestamp}.png`;
        link.href = canvas.toDataURL('image/png');
        
        document.body.appendChild(link); // 兼容 Firefox
        link.click();
        document.body.removeChild(link);
    };

    img.onerror = function(e) {
        console.error("图像导出失败:", e);
        showError("图像生成失败，请查看控制台详情。");
    };

    img.src = imageSrc;
}

// UI辅助函数
function showLoading(message) {
    const detailPanel = document.getElementById('detailPanel');
    detailPanel.innerHTML = `
        <h3>⏳ ${message}</h3>
        <p>正在从API服务器获取数据...</p>
        <div style="text-align: center; margin-top: 20px;">
            <div style="border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 2s linear infinite; margin: 0 auto;"></div>
            <style>@keyframes spin {0% {transform: rotate(0deg);} 100% {transform: rotate(360deg);}}</style>
        </div>
    `;
}

function showSuccess(message) {
    const detailPanel = document.getElementById('detailPanel');
    detailPanel.innerHTML = `
        <div class="detail-card" style="border-left-color: #2ecc71;">
            <h3 style="color: #2ecc71;">✅ ${message}</h3>
            <p>现在可以点击图表中的数据点查看详细信息。</p>
        </div>
    `;
}

function showError(message) {
    const detailPanel = document.getElementById('detailPanel');
    detailPanel.innerHTML = `
        <div class="detail-card" style="border-left-color: #e74c3c;">
            <h3 style="color: #e74c3c;">❌ 错误</h3>
            <p>${message}</p>
            <p style="margin-top: 10px; font-size: 14px;">
                请确保已执行以下步骤：
                <ol style="margin-left: 20px;">
                    <li>运行API服务器: <code>python api_server.py</code></li>
                    <li>检查API是否可访问: <a href="http://localhost:5000" target="_blank">http://localhost:5000</a></li>
                </ol>
            </p>
        </div>
    `;
}

function showNoDataMessage() {
    const detailPanel = document.getElementById('detailPanel');
    detailPanel.innerHTML = `
        <div class="detail-card">
            <h3>📊 无数据可用</h3>
            <p>请先点击"加载真实数据"按钮获取分析结果。</p>
            <p>或者确保您选择的书籍有"${getMetricLabel(currentMetric)}"数据。</p>
        </div>
    `;
}

// 使函数全局可用
window.selectBook = selectBook;