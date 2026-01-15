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
let currentBook = null;
let comparisonMode = false;
let smoothness = 3;

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
        selector.innerHTML = '<p style="color: #e74c3c;">⚠️ 没有找到任何书籍，请确保已将文本文件放置在 data/raw/ 目录下</p>';
        return;
    }
    
    // --- 修改开始 ---
    // 这里的改动是添加了 data-id="${book.id}"
    const buttons = books.map(book => `
        <div class="book-btn" data-id="${book.id}" onclick="selectBook('${book.id}')">
            ${book.name}
        </div>
    `).join('');
    // --- 修改结束 ---
    
    selector.innerHTML = buttons;
    
    // 默认选择第一本书
    if (books.length > 0) {
        selectBook(books[0].id);
    }
}

// static/js/d3-charts.js

function selectBook(bookId) {
    currentBook = bookId;
    comparisonMode = false;
    
    // --- 修改开始 ---
    // 更新UI：不再使用 event.target，而是通过 data-id 匹配
    document.querySelectorAll('.book-btn').forEach(btn => {
        // 先移除所有按钮的激活状态
        btn.classList.remove('active');
        
        // 如果当前按钮的 data-id 等于传入的 bookId，则添加激活状态
        if (btn.getAttribute('data-id') === bookId) {
            btn.classList.add('active');
        }
    });
    // 删除这行导致报错的代码: event.target.classList.add('active');
    // --- 修改结束 ---
    
    document.getElementById('toggleComparison').innerHTML = '🆚 点击切换到多书对比模式';
    
    // 如果已有数据，更新图表
    if (realData && realData[bookId]) {
        initChart();
    }
}
// static/js/d3-charts.js

async function loadRealData() {
    try {
        showLoading('正在加载数据...');
        
        const response = await fetch(API_ENDPOINTS.fingerprintData);
        const data = await response.json();
        
        if (data.status === 'success') {
            realData = data.data;
            showSuccess(`成功加载 ${Object.keys(realData).length} 本书籍的数据`);
            
            // --- 修复代码开始：自动切换到有效书籍 ---
            const availableBooks = Object.keys(realData);
            
            // 如果当前没有选书，或者当前选中的书(currentBook)在加载的数据(realData)里找不到
            if (availableBooks.length > 0) {
                if (!currentBook || !realData[currentBook]) {
                    console.warn(`当前书籍 ${currentBook} 无数据，自动切换到 ${availableBooks[0]}`);
                    // 强制选中数据中存在的第一本书
                    selectBook(availableBooks[0]);
                } else {
                    // 如果当前书籍有效，直接刷新图表
                    initChart();
                }
            } else {
                showError('加载的数据为空');
            }
            // --- 修复代码结束 ---
            
        } else {
            showError('加载数据失败: ' + data.message);
        }
    } catch (error) {
        console.error('加载数据失败:', error);
        showError('无法加载数据，请检查API服务器是否运行在 http://localhost:5000');
    }
}
// 初始化图表
function initChart() {
    const svg = d3.select("#main-chart");
    svg.selectAll("*").remove();
    
    // 获取当前数据
    let chartData;
    if (comparisonMode) {
        // 多书对比模式
        chartData = Object.keys(realData).map(book => ({
            book: book,
            values: realData[book][currentMetric] || []
        })).filter(d => d.values.length > 0);
    } else if (currentBook && realData[currentBook]) {
        // 单书模式
        chartData = [{
            book: currentBook,
            values: realData[currentBook][currentMetric] || []
        }];
    } else {
        // 没有数据
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
    updateLegend(chartData.map(d => d.book), colorScale);
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

function exportChart() {
    const svg = document.getElementById('main-chart');
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    
    canvas.width = svg.clientWidth;
    canvas.height = svg.clientHeight;
    
    img.onload = function() {
        ctx.drawImage(img, 0, 0);
        const link = document.createElement('a');
        link.download = `文印分析_${currentBook || '对比'}_${currentMetric}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
    };
    
    img.src = 'data:image/svg+xml;base64,' + btoa(svgData);
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