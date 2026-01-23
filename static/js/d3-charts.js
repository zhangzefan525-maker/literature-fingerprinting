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
    
    // 修复：自动启动文本雨
    setTimeout(() => {
        toggleMatrixRain();
    }, 500);
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
            
         // 添加数据点 (交互核心)
        // 这里的 safeBookID 是为了防止书名中有空格导致选择器报错
        const safeBookID = bookData.book.replace(/[^a-zA-Z0-9]/g, '_');

        g.selectAll(`.point-${safeBookID}`)
            .data(bookData.values) // 使用未平滑的原始数据，保证点击数据的准确性
            .enter()
            .append("circle")
            .attr("class", `data-point point-${safeBookID}`)
            .attr("cx", (d, i) => xScale(i))
            .attr("cy", d => yScale(d.value))
            .attr("r", 3) // 默认半径小一点，不遮挡线条
            .attr("fill", colorScale(bookData.book))
            .attr("stroke", "white")
            .attr("stroke-width", 1.5)
            .style("cursor", "pointer")
            .style("opacity", 0) // 默认隐藏点，只显示线，鼠标放上去再显示点，或者保持 opacity: 1 也可以
            // --- 鼠标悬停事件 ---
            .on("mouseover", function(event, d) {
                // 放大高亮
                d3.select(this)
                    .style("opacity", 1)
                    .transition().duration(100)
                    .attr("r", 6)
                    .attr("stroke", "#f1c40f")
                    .attr("stroke-width", 2);
                
                showTooltip(event, d, bookData.book);
            })
            // --- 鼠标移出事件 ---
            .on("mouseout", function(event, d) {
                d3.select(this)
                    .transition().duration(200)
                    .attr("r", 3)
                    .attr("stroke", "white")
                    .attr("stroke-width", 1.5)
                    .style("opacity", 0); // 如果默认隐藏，这里恢复0；如果默认显示，设为1
                
                hideTooltip();
            })
            // --- 核心新增：点击事件 ---
            .on("click", function(event, d) {
                event.stopPropagation(); // 阻止冒泡
                
                // 视觉反馈：点击时产生一个波纹效果或者保持高亮
                d3.selectAll(".data-point").attr("r", 3).style("opacity", 0); // 重置其他点
                d3.select(this).style("opacity", 1).attr("r", 8).attr("stroke", "#000");

                // 调用侧边栏显示函数
                showDetail(d, bookData.book);
            });
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
// ==========================================
// 🌌 风格星系 (Style Galaxy) - 完整功能版
// ==========================================

let galaxySimulation = null;

function initStyleGalaxy() {
    // 0. 基础检查
    const books = Array.from(selectedBooks);
    if (books.length === 0) {
        const loadingEl = document.getElementById('galaxy-loading');
        if(loadingEl) loadingEl.innerText = "请先在上方选择书籍";
        return;
    }

    const container = document.getElementById('galaxy-container');
    const width = container.clientWidth;
    const height = container.clientHeight;

    // 清理旧画布
    d3.select("#galaxy-container").selectAll("svg").remove();
    const loadingEl = document.getElementById('galaxy-loading');
    if(loadingEl) loadingEl.style.display = 'none';

    // 创建 SVG
    const svg = d3.select("#galaxy-container").append("svg")
        .attr("width", width)
        .attr("height", height)
        .style("background", "radial-gradient(ellipse at center, #1b2735 0%, #090a0f 100%)"); // 深空背景

    // 1. 定义滤镜和渐变 (渲染引擎核心)
    const defs = svg.append("defs");

    // A. 定义发光滤镜 (Glow Filter)
    const filter = defs.append("filter").attr("id", "glow");
    filter.append("feGaussianBlur")
        .attr("stdDeviation", "2.5")
        .attr("result", "coloredBlur");
    const feMerge = filter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    // B. 颜色比例尺
    const colorScale = d3.scaleOrdinal()
        .domain(books)
        .range(['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c']);

    // C. 动态生成每本书的 3D 渐变球纹理
    books.forEach((book) => {
        const baseColor = d3.color(colorScale(book));
        const highlight = baseColor.brighter(1.5); // 高光颜色
        const shadow = baseColor.darker(1.2);      // 阴影颜色
        
        // 创建 ID (移除特殊字符作为ID)
        const gradId = "grad-" + book.replace(/[^a-zA-Z0-9]/g, '');
        
        const gradient = defs.append("radialGradient")
            .attr("id", gradId)
            .attr("cx", "30%")  // 光源在左上角
            .attr("cy", "30%")
            .attr("r", "70%");

        // 光源中心（高光）
        gradient.append("stop")
            .attr("offset", "0%")
            .attr("stop-color", highlight.formatHex())
            .attr("stop-opacity", 1);
        
        // 中间色
        gradient.append("stop")
            .attr("offset", "50%")
            .attr("stop-color", baseColor.formatHex())
            .attr("stop-opacity", 1);

        // 边缘（阴影）
        gradient.append("stop")
            .attr("offset", "100%")
            .attr("stop-color", shadow.formatHex())
            .attr("stop-opacity", 1);
    });

    // 2. 准备数据并计算范围
    let allNodes = [];
    let minMetric = Infinity;
    let maxMetric = -Infinity;

    books.forEach(bookName => {
        // 数据源 A: PCA位置数据 + 长文本 (来自 generate_data.py 修改后的 functionWords)
        const positionData = realData[bookName]['functionWords'];
        // 数据源 B: 显示数值 (来自用户当前选择的指标)
        const displayData = realData[bookName][currentMetric];

        if (positionData && displayData) {
            positionData.forEach((d, i) => {
                const metricItem = displayData[i];
                if (metricItem) {
                    const val = metricItem.value;
                    // 更新最大最小值，用于计算半径
                    if (val < minMetric) minMetric = val;
                    if (val > maxMetric) maxMetric = val;

                    allNodes.push({
                        id: `${bookName}_${d.block}`,
                        book: bookName,
                        blockIndex: d.block,
                        
                        // 位置数据
                        pcaX: d.value,
                        pcaY: d.value_y || (Math.random() - 0.5),
                        
                        // 真实指标数据
                        realValue: val,
                        
                        // 文本数据
                        preview: metricItem.preview, // 短文本 (给Tooltip)
                        // 核心：尝试获取长文本，如果没有则回退到短文本
                        extendedPreview: d.extended_preview || metricItem.preview, 
                        
                        keywords: metricItem.keywords,
                        
                        // 初始位置设为画布中心，产生“大爆炸”效果
                        x: width / 2 + (Math.random() - 0.5) * 50,
                        y: height / 2 + (Math.random() - 0.5) * 50
                    });
                }
            });
        }
    });

    // 3. 半径比例尺：将指标值映射到球体大小
    const radiusScale = d3.scaleSqrt()
        .domain([minMetric, maxMetric])
        .range([4, 18]); // 最小半径 4px，最大 18px

    // 为每个节点计算最终半径
    allNodes.forEach(d => {
        d.r = radiusScale(d.realValue);
    });

    // 4. 坐标比例尺
    const xExtent = d3.extent(allNodes, d => d.pcaX);
    const yExtent = d3.extent(allNodes, d => d.pcaY);
    const padding = 60;
    const xScale = d3.scaleLinear().domain(xExtent).range([padding, width - padding]);
    const yScale = d3.scaleLinear().domain(yExtent).range([padding, height - padding]);

    // 5. 缩放容器
    const g = svg.append("g");
    svg.call(d3.zoom()
        .scaleExtent([0.5, 5]) // 限制缩放范围
        .on("zoom", (event) => {
            g.attr("transform", event.transform);
        }));

    // 6. 物理引擎配置
    if (galaxySimulation) galaxySimulation.stop();

    galaxySimulation = d3.forceSimulation(allNodes)
        // 牵引力
        .force("x", d3.forceX(d => xScale(d.pcaX)).strength(0.8))
        .force("y", d3.forceY(d => yScale(d.pcaY)).strength(0.8))
        // 碰撞力
        .force("collide", d3.forceCollide(d => d.r + 1).strength(1))
        // 电荷力
        .force("charge", d3.forceManyBody().strength(-15))
        .alphaTarget(0)
        .on("tick", ticked);

    // 7. 绘制星球 (Circles)
    const circles = g.selectAll("circle")
        .data(allNodes)
        .enter().append("circle")
        .attr("r", d => d.r)
        // 3D 渐变填充
        .attr("fill", d => `url(#grad-${d.book.replace(/[^a-zA-Z0-9]/g, '')})`)
        .attr("stroke", d => d3.color(colorScale(d.book)).darker(0.5))
        .attr("stroke-width", 0.5)
        .attr("stroke-opacity", 0.8)
        .style("cursor", "pointer")
        .call(d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended));

    // 8. 交互事件 (Updated with Probe Logic)
    circles.on("mouseover", function(event, d) {
        // A. 自身高亮
        d3.select(this)
            .transition().duration(100)
            .attr("r", d.r * 1.5)
            .style("filter", "url(#glow)")
            .attr("stroke", "#fff")
            .attr("stroke-width", 2);
        
        // B. 探针逻辑：寻找邻居
        // 使用 svg.selectAll 获取所有节点数据
        const allCircles = g.selectAll("circle");
        const allNodeData = allCircles.data();
        // 搜索半径 120 像素
        const neighbors = findNeighbors(d, allNodeData, 120); 

        // C. 高亮邻居 (视觉连线效果太卡，改用边框高亮)
        allCircles.filter(node => neighbors.includes(node))
            .transition().duration(100)
            .attr("stroke", "#f1c40f")
            .attr("stroke-width", 1.5)
            .attr("stroke-opacity", 1);

        // D. 数据分析并更新 HUD
        const analysis = analyzeCluster(neighbors);
        // 获取当前指标的中文名，如果没有 getMetricLabel 函数，就直接用 currentMetric
        const label = window.getMetricLabel ? getMetricLabel(currentMetric) : currentMetric;
        updateHUD(analysis, label);

        // E. 原有 Tooltip
        showTooltip(event, {
            block: d.blockIndex,
            value: typeof d.realValue === 'number' ? d.realValue.toFixed(4) : d.realValue,
            keywords: d.keywords,
            preview: d.preview 
        }, d.book);
    })
    .on("mouseout", function(event, d) {
        // A. 恢复自身
        d3.select(this)
            .transition().duration(200)
            .attr("r", d.r)
            .style("filter", null)
            .attr("stroke", d3.color(colorScale(d.book)).darker(0.5))
            .attr("stroke-width", 0.5);

        // B. 恢复邻居
        g.selectAll("circle")
             .transition().duration(200)
             .attr("stroke", node => d3.color(colorScale(node.book)).darker(0.5))
             .attr("stroke-width", 0.5)
             .attr("stroke-opacity", 0.8);
        
        // C. 重置 HUD
        const hud = document.getElementById('galaxy-hud');
        if(hud) {
            hud.querySelector('.hud-title').innerText = "📡 星系探针：待机";
            hud.querySelector('.hud-content').innerHTML = '<p style="color:#7f8c8d; font-size:12px;">鼠标漫游以探测区域风格...</p>';
        }
        
        hideTooltip();
    })
    .on("click", (event, d) => {
        event.stopPropagation(); // 阻止冒泡
        // 打开悬浮详情页 (使用长文本)
        openGalaxyModal(d);
    });

    function ticked() {
        circles
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);
    }

    function dragstarted(event, d) {
        if (!event.active) galaxySimulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
        d3.select(this).style("cursor", "grabbing");
    }

    function dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
    }

    function dragended(event, d) {
        if (!event.active) galaxySimulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
        d3.select(this).style("cursor", "pointer");
    }
}

// ==========================================
// 📜 悬浮页控制函数 (Modal Logic)
// ==========================================

function openGalaxyModal(d) {
    const modal = document.getElementById('galaxy-modal');
    if(!modal) return;

    // 填充数据
    const titleEl = document.getElementById('modal-book-title');
    if(titleEl) titleEl.innerText = d.book;
    
    const blockEl = document.getElementById('modal-block-id');
    if(blockEl) blockEl.innerText = `Block #${d.blockIndex}`;
    
    // 格式化数值显示
    let valDisplay = typeof d.realValue === 'number' ? d.realValue.toFixed(4) : d.realValue;
    const metricEl = document.getElementById('modal-metric-val');
    if(metricEl) metricEl.innerText = `${getMetricLabel(currentMetric)}: ${valDisplay}`;
    
    // 填充关键词
    const keywordContainer = document.getElementById('modal-keywords');
    if(keywordContainer) {
        keywordContainer.innerHTML = '';
        if (d.keywords && d.keywords.length > 0) {
            d.keywords.forEach(kw => {
                const span = document.createElement('span');
                span.innerText = kw;
                keywordContainer.appendChild(span);
            });
        } else {
            keywordContainer.innerHTML = '<span style="color:#666">无关键词</span>';
        }
    }

    // 填充长文本 (使用 extendedPreview)
    const textContainer = document.getElementById('modal-long-text');
    if(textContainer) {
        textContainer.innerText = d.extendedPreview || d.preview || "暂无详细文本内容...";
    }

    // 显示动画
    modal.style.display = 'flex';
    setTimeout(() => {
        modal.classList.add('show');
    }, 10);
}

function closeGalaxyModal() {
    const modal = document.getElementById('galaxy-modal');
    if(!modal) return;
    
    modal.classList.remove('show');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 300);
}

// 点击遮罩层空白处关闭
document.addEventListener('DOMContentLoaded', function() {
    const modal = document.getElementById('galaxy-modal');
    if(modal) {
        modal.addEventListener('click', function(e) {
            if (e.target === this) {
                closeGalaxyModal();
            }
        });
    }
});

// 绑定重置按钮
window.restartGalaxy = function() {
    initStyleGalaxy();
};

// 挂载到主初始化流程
const _prevInit = window.initChart;
window.initChart = function() {
    if (_prevInit) _prevInit();
    // 只有在数据加载后才初始化星系
    if (realData) {
        // 延迟一点执行，避免阻塞UI
        setTimeout(initStyleGalaxy, 500); 
    }
};

// 使函数全局可用
window.selectBook = selectBook;

// ... (保留之前的代码) ...

// ==========================================
// 📡 星系探针分析逻辑 (新增核心)
// ==========================================

// 1. 查找邻居节点 (根据屏幕距离)
function findNeighbors(centerNode, allNodes, radius = 80) {
    // 简单的欧几里得距离计算
    return allNodes.filter(node => {
        const dx = node.x - centerNode.x;
        const dy = node.y - centerNode.y;
        return Math.sqrt(dx*dx + dy*dy) < radius;
    });
}

// 2. 分析邻居并生成报告
function analyzeCluster(neighbors) {
    if (neighbors.length === 0) return null;

    // A. 统计主要作者 (Dominant Book)
    const bookCounts = {};
    neighbors.forEach(n => {
        bookCounts[n.book] = (bookCounts[n.book] || 0) + 1;
    });
    // 找出数量最多的书
    const dominantBook = Object.keys(bookCounts).reduce((a, b) => bookCounts[a] > bookCounts[b] ? a : b);
    const dominanceRate = (bookCounts[dominantBook] / neighbors.length) * 100;

    // B. 计算平均指标 (Average Metric)
    const totalMetric = neighbors.reduce((sum, n) => sum + (n.realValue || 0), 0);
    const avgMetric = totalMetric / neighbors.length;

    // C. 提取高频关键词 (Top Keywords)
    const keywordMap = {};
    neighbors.forEach(n => {
        if(n.keywords) {
            n.keywords.forEach(kw => {
                keywordMap[kw] = (keywordMap[kw] || 0) + 1;
            });
        }
    });
    // 排序并取前5
    const topKeywords = Object.keys(keywordMap)
        .sort((a, b) => keywordMap[b] - keywordMap[a])
        .slice(0, 5);

    return {
        count: neighbors.length,
        dominantBook: dominantBook,
        dominanceRate: dominanceRate,
        avgMetric: avgMetric,
        topKeywords: topKeywords
    };
}

// 3. 更新 HUD 界面
function updateHUD(analysisData, metricLabel) {
    const hud = document.getElementById('galaxy-hud');
    const content = hud.querySelector('.hud-content');
    const title = hud.querySelector('.hud-title');

    if (!analysisData) {
        title.innerText = "📡 星系探针：扫描中...";
        content.innerHTML = `<p style="color:#7f8c8d; font-size:12px;">正在分析区域引力场...</p>`;
        return;
    }

    title.innerHTML = `📡 区域扫描 (包含 ${analysisData.count} 个节点)`;
    
    // 生成动态 HTML
    let html = `
        <div class="hud-row">
            <span class="hud-label">主要归属:</span>
            <span class="hud-value" style="color:white">${analysisData.dominantBook.substring(0, 15)}...</span>
        </div>
        <div class="hud-bar-bg" title="该作者占比 ${analysisData.dominanceRate.toFixed(0)}%">
            <div class="hud-bar-fill" style="width: ${analysisData.dominanceRate}%;"></div>
        </div>
        <div class="hud-row" style="margin-top:8px;">
            <span class="hud-label">区域平均 ${metricLabel}:</span>
            <span class="hud-value" style="color:#f1c40f">${analysisData.avgMetric.toFixed(2)}</span>
        </div>
        <div class="hud-row" style="margin-top:8px;">
            <span class="hud-label">区域共性话题:</span>
        </div>
        <div class="hud-tags">
            ${analysisData.topKeywords.map(k => `<span class="hud-tag">${k}</span>`).join('')}
        </div>
        <div style="margin-top:10px; padding-top:5px; border-top:1px dashed rgba(255,255,255,0.1); font-size:10px; color:#7f8c8d;">
            * 此区域节点因由 PCA (功能词使用习惯) 相近而聚集。
        </div>
    `;

    content.innerHTML = html;
}

// ==========================================
// 🌧️ 黑客帝国文本雨 (Matrix Keyword Rain)
// ==========================================

let matrixInterval = null;
let isMatrixOn = false;

function initMatrixRain() {
    const canvas = document.getElementById('matrix-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // 1. 设置画布全屏
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // 2. 提取关键词池 (Keyword Pool)
    let words = [];
    if (typeof realData !== 'undefined' && realData) {
        // 遍历所有书，提取关键词
        Object.values(realData).forEach(bookData => {
            // 假设我们用 sentenceLength 这个指标下的数据来提取关键词
            const metricData = bookData[currentMetric] || Object.values(bookData)[0];
            if (Array.isArray(metricData)) {
                metricData.forEach(block => {
                    if (block.keywords && Array.isArray(block.keywords)) {
                        // 过滤掉太长的词，保持视觉整洁
                        const shortKws = block.keywords.filter(w => w.length < 10);
                        words.push(...shortKws);
                    }
                });
            }
        });
    }
    
    // 如果没有数据或数据太少，使用默认词库
    if (words.length < 50) {
        words = [
            'Literature', 'Style', 'Twain', 'London', 'Data', 'Visual', 
            'Python', 'Analysis', 'Fingerprint', 'Novel', 'Text', 'Code',
            'Stream', 'Galaxy', 'Emotion', 'Plot', 'Character'
        ];
    }
    
    // 去重
    words = [...new Set(words)];

    // 3. 配置参数
    const fontSize = 14;
    const fontFamily = 'Consolas, monospace';
    // 计算列数 (屏幕宽度 / 字体大小)
    const columns = Math.floor(canvas.width / fontSize);
    
    // 记录每一列当前下落到的 Y 轴位置 (初始化为随机高度，造成参差感)
    const drops = [];
    for (let i = 0; i < columns; i++) {
        drops[i] = Math.random() * -100; // 负数表示从屏幕上方外开始
    }

    // 颜色池
    const colors = ['#3498db', '#e74c3c', '#2ecc71', '#9b59b6', '#f1c40f', '#34495e'];

    // 4. 绘图循环
    function draw() {
        // A. 绘制半透明背景 (制造拖尾效果的核心)
        // 修复：改用白色淡出，因为网页背景是浅色的
        // alpha = 0.1 意味着每一帧只覆盖 10% 的白色，旧的文字会慢慢变淡
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // B. 设置文字样式
        // 修复：随机颜色
        ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
        
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.textAlign = 'center';

        // C. 遍历每一列
        for (let i = 0; i < drops.length; i++) {
            // 随机取一个词
            const text = words[Math.floor(Math.random() * words.length)];
            
            // 绘制文字
            // x = 列索引 * 字体宽度
            // y = 当前下落进度 * 字体高度
            const x = i * fontSize;
            const y = drops[i] * fontSize;

            // 只有在屏幕范围内才绘制，节省性能
            if (y > 0 && y < canvas.height) {
                ctx.fillText(text, x, y);
            }

            // D. 重置逻辑
            // 如果超出了屏幕底部，且随机触发 (让雨滴不是同时回到顶部)
            if (y > canvas.height && Math.random() > 0.975) {
                drops[i] = 0;
            }

            // E. 下落
            drops[i]++;
        }
    }

    // 5. 启动动画循环 (30FPS 左右即可，太快看不清)
    if (matrixInterval) clearInterval(matrixInterval);
    matrixInterval = setInterval(draw, 50); // 50ms 一帧
    
    // 6. 窗口大小改变时重置
    window.onresize = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };
}

// 开关控制函数
function toggleMatrixRain() {
    const canvas = document.getElementById('matrix-canvas');
    const btn = document.getElementById('btn-matrix');
    
    isMatrixOn = !isMatrixOn;

    if (isMatrixOn) {
        // 开启
        initMatrixRain(); // 初始化并开始绘图
        canvas.classList.add('active'); // CSS 渐显
        btn.classList.add('active');
        btn.innerHTML = "🛑 停止文本雨";
    } else {
        // 关闭
        canvas.classList.remove('active'); // CSS 渐隐
        btn.classList.remove('active');
        btn.innerHTML = "🌧️ 激活文本雨";
        
        // 延时清除定时器，等渐隐动画播完
        setTimeout(() => {
            if (matrixInterval) clearInterval(matrixInterval);
            // 清空画布
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }, 1000);
    }
}
