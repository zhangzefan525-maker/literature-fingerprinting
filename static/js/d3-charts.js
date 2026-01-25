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
let currentTab = 'view-main'; // 新增：记录当前标签页

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    initEventListeners();
    loadBooksList();
    
    // 修复：自动启动文本雨
    setTimeout(() => {
        toggleMatrixRain();
    }, 500);
});

// 新增：Tab 切换逻辑
window.switchTab = function(tabId) {
    currentTab = tabId;

    // 1. 切换按钮状态
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    const clickedBtn = document.querySelector(`.tab-btn[onclick="switchTab('${tabId}')"]`);
    if (clickedBtn) clickedBtn.classList.add('active');

    // 2. 切换内容显示
    document.querySelectorAll('.view-section').forEach(section => {
        section.classList.remove('active');
    });
    const activeSection = document.getElementById(tabId);
    if (activeSection) {
        activeSection.classList.add('active');
        
        // 3. 关键：当视图变可见时，触发对应图表的重绘或调整大小
        // 延迟一点点以确保 DOM 布局已更新
        setTimeout(() => {
            if (tabId === 'view-main' && realData) {
                initChart(); // 重新调整基础图表大小
            } else if (tabId === 'view-galaxy' && realData) {
                initStyleGalaxy(); // 初始化或重绘星系
            } else if (tabId === 'view-dashboard' && realData) {
                if (window.initAdvancedData) window.initAdvancedData(); // 初始化或重绘仪表盘
            }
        }, 50);
    }
};

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
            // 数据变化时，更新所有图表
            refreshAllActiveCharts();
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

// 辅助函数：根据当前 Tab 刷新图表
function refreshAllActiveCharts() {
    if (currentTab === 'view-main') initChart();
    if (currentTab === 'view-galaxy') initStyleGalaxy();
    if (currentTab === 'view-dashboard' && window.initAdvancedData) window.initAdvancedData();
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
    
    // 刷新当前可见的图表
    if (realData) {
        refreshAllActiveCharts();
    }
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
            
            // 初始化当前标签页的图表
            refreshAllActiveCharts();
        } else {
            showError('加载数据失败: ' + data.message);
        }
    } catch (error) {
        console.error('加载数据失败:', error);
        showError('无法加载数据，请检查API服务器是否运行在 http://localhost:5000');
    }
}

// 修改原 initChart，只在 Main Tab 激活时工作
function initChart() {
    // 如果不在主视图，不进行渲染，节省性能
    if (currentTab !== 'view-main') return;

    const svg = d3.select("#main-chart");
    svg.selectAll("*").remove();

    if (!realData || selectedBooks.size === 0) return;

    const booksArray = Array.from(selectedBooks);
    
    // 确保 SVG 容器有宽度 (D3 在 display:none 时宽度为 0)
    const container = svg.node().parentNode;
    if (container.clientWidth === 0) return;

    if (chartType === 'heatmap') {
        drawMultiHeatmap(svg, booksArray); 
    } else {
        drawMultiLineChart(svg, booksArray); 
    }
}

function drawMultiLineChart(svg, booksArray) {
    const chartData = booksArray.map(bookId => ({
        book: bookId,
        values: realData[bookId][currentMetric] || []
    })).filter(d => d.values.length > 0);

    if (chartData.length === 0) { showNoDataMessage(); return; }

    const containerWidth = svg.node().parentNode.getBoundingClientRect().width;
    const height = 400;
    const margin = { top: 40, right: 120, bottom: 50, left: 60 }; 
    const width = containerWidth - margin.left - margin.right;

    svg.attr("viewBox", `0 0 ${containerWidth} ${height}`);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const maxBlocks = d3.max(chartData, d => d.values.length - 1);
    const allValues = chartData.flatMap(d => d.values.map(v => v.value));
    const yMin = d3.min(allValues) * 0.95;
    const yMax = d3.max(allValues) * 1.05;

    const xScale = d3.scaleLinear().domain([0, maxBlocks]).range([0, width]);
    const yScale = d3.scaleLinear().domain([yMin, yMax]).range([height - margin.top - margin.bottom, 0]);

    const colorScale = d3.scaleOrdinal(d3.schemeCategory10).domain(booksArray);

    const chartHeight = height - margin.top - margin.bottom;
    g.append("g").attr("transform", `translate(0,${chartHeight})`).call(d3.axisBottom(xScale));
    g.append("g").call(d3.axisLeft(yScale));
    
    g.append("g").attr("class", "grid").call(d3.axisLeft(yScale).tickSize(-width).tickFormat("")).attr("stroke-opacity", 0.1);

    const line = d3.line()
        .x((d, i) => xScale(i))
        .y(d => yScale(d.value))
        .curve(d3.curveMonotoneX);

    chartData.forEach(bookData => {
        const smoothed = smoothData(bookData.values, smoothness);
        
        g.append("path")
            .datum(smoothed)
            .attr("fill", "none")
            .attr("stroke", colorScale(bookData.book))
            .attr("stroke-width", 2.5)
            .attr("d", line)
            .style("opacity", 0.8)
            .on("mouseover", function() { d3.select(this).attr("stroke-width", 5); })
            .on("mouseout", function() { d3.select(this).attr("stroke-width", 2.5); });
            
        const safeBookID = bookData.book.replace(/[^a-zA-Z0-9]/g, '_');

        g.selectAll(`.point-${safeBookID}`)
            .data(bookData.values) 
            .enter()
            .append("circle")
            .attr("class", `data-point point-${safeBookID}`)
            .attr("cx", (d, i) => xScale(i))
            .attr("cy", d => yScale(d.value))
            .attr("r", 3) 
            .attr("fill", colorScale(bookData.book))
            .attr("stroke", "white")
            .attr("stroke-width", 1.5)
            .style("cursor", "pointer")
            .style("opacity", 0) 
            .on("mouseover", function(event, d) {
                d3.select(this)
                    .style("opacity", 1)
                    .transition().duration(100)
                    .attr("r", 6)
                    .attr("stroke", "#f1c40f")
                    .attr("stroke-width", 2);
                
                showTooltip(event, d, bookData.book);
            })
            .on("mouseout", function(event, d) {
                d3.select(this)
                    .transition().duration(200)
                    .attr("r", 3)
                    .attr("stroke", "white")
                    .attr("stroke-width", 1.5)
                    .style("opacity", 0); 
                
                hideTooltip();
            })
            .on("click", function(event, d) {
                event.stopPropagation(); 
                d3.selectAll(".data-point").attr("r", 3).style("opacity", 0); 
                d3.select(this).style("opacity", 1).attr("r", 8).attr("stroke", "#000");
                showDetail(d, bookData.book);
            });
    });

    const legend = svg.append("g").attr("transform", `translate(${width + 20}, ${margin.top})`);
    chartData.forEach((d, i) => {
        const row = legend.append("g").attr("transform", `translate(0, ${i * 25})`);
        row.append("rect").attr("width", 15).attr("height", 15).attr("fill", colorScale(d.book));
        row.append("text").attr("x", 20).attr("y", 12).text(d.book).style("font-size", "12px").style("fill", "#333");
    });
    
    svg.append("text")
        .attr("x", containerWidth / 2)
        .attr("y", 25)
        .attr("text-anchor", "middle")
        .style("font-size", "16px")
        .style("font-weight", "bold")
        .text(`${getMetricLabel(currentMetric)} - 对比分析`);
}

function drawMultiHeatmap(svg, booksArray) {
    const containerWidth = svg.node().parentNode.getBoundingClientRect().width;
    const padding = 20; 
    const topMargin = 80; 
    const bottomMargin = 50; 
    
    const chartWidth = (containerWidth - 60 - (booksArray.length - 1) * padding) / booksArray.length;
    
    let maxRows = 0;
    let finalBlockSize = 0;
    
    booksArray.forEach(bookId => {
        const data = realData[bookId][currentMetric];
        const n = data.length;
        const cols = Math.ceil(Math.sqrt(n)); 
        const rows = Math.ceil(n / cols);
        const blockSize = Math.floor(chartWidth / cols);
        
        if (rows > maxRows) maxRows = rows;
        if (finalBlockSize === 0) finalBlockSize = blockSize; 
    });
    
    const totalHeight = Math.max(400, topMargin + (maxRows * finalBlockSize) + bottomMargin);
    
    svg.attr("viewBox", `0 0 ${containerWidth} ${totalHeight}`)
       .style("height", totalHeight + "px"); 
    
    let globalMin = Infinity, globalMax = -Infinity;
    booksArray.forEach(bookId => {
        const vals = realData[bookId][currentMetric].map(d => d.value);
        globalMin = Math.min(globalMin, Math.min(...vals));
        globalMax = Math.max(globalMax, Math.max(...vals));
    });
    
    const colorScale = d3.scaleSequential()
        .interpolator(d3.interpolateRdBu)
        .domain([globalMin, globalMax]); 

    booksArray.forEach((bookId, index) => {
        const data = realData[bookId][currentMetric];
        
        const g = svg.append("g")
            .attr("transform", `translate(${30 + index * (chartWidth + padding)}, ${topMargin})`);
            
        const n = data.length;
        const cols = Math.ceil(Math.sqrt(n)); 
        const blockSize = Math.floor(chartWidth / cols);
        
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
                d3.select(this).style("stroke", "#f1c40f").style("stroke-width", "2px");
                showTooltip(event, d, bookId); 
            })
            .on("mouseout", function() {
                d3.select(this).style("stroke", "white").style("stroke-width", "1px");
                hideTooltip();
            })
            .on("click", function(event, d) { showDetail(d, bookId); });

        g.append("text")
            .attr("x", (cols * blockSize) / 2)
            .attr("y", -20) 
            .attr("text-anchor", "middle")
            .style("font-size", "14px")
            .style("font-weight", "bold")
            .style("fill", "#333")
            .text(bookId.length > 18 ? bookId.substring(0, 15) + "..." : bookId); 
    });

    svg.append("text")
        .attr("x", containerWidth / 2)
        .attr("y", 30) 
        .attr("text-anchor", "middle")
        .style("font-size", "18px")
        .style("font-weight", "bold")
        .style("fill", "#2c3e50")
        .text(`${getMetricLabel(currentMetric)} - 指纹对比 (统一色标: ${globalMin.toFixed(1)} ~ ${globalMax.toFixed(1)})`);
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
        refreshAllActiveCharts();
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
    if (!svg) {
        showError("找不到图表元素");
        return;
    }

    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svg);

    if(!source.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)){
        source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    const styleString = `
        <style>
            text { font-family: 'Microsoft YaHei', sans-serif; }
            .heatmap-rect { stroke: white; stroke-width: 1px; }
            .axis path, .axis line { fill: none; stroke: #000; shape-rendering: crispEdges; }
        </style>`;
    source = source.replace('</svg>', styleString + '</svg>');

    const imageSrc = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const img = new Image();

    const svgRect = svg.getBoundingClientRect();
    const scaleFactor = 2; 
    canvas.width = svgRect.width * scaleFactor;
    canvas.height = svgRect.height * scaleFactor;

    img.onload = function() {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const bookName = Array.from(selectedBooks)[0] ? Array.from(selectedBooks)[0].replace(/\s+/g, '_') : 'Comparison';
        
        link.download = `文印_${bookName}_${chartType}_${timestamp}.png`;
        link.href = canvas.toDataURL('image/png');
        
        document.body.appendChild(link); 
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
        </div>
    `;
}

function showNoDataMessage() {
    const detailPanel = document.getElementById('detailPanel');
    detailPanel.innerHTML = `
        <div class="detail-card">
            <h3>📊 无数据可用</h3>
            <p>请先点击"加载真实数据"按钮获取分析结果。</p>
        </div>
    `;
}

// ==========================================
// 🌌 风格星系 (Style Galaxy)
// ==========================================

let galaxySimulation = null;

function initStyleGalaxy() {
    // 检查是否可见
    if (currentTab !== 'view-galaxy') return;

    const books = Array.from(selectedBooks);
    if (books.length === 0) {
        const loadingEl = document.getElementById('galaxy-loading');
        if(loadingEl) loadingEl.innerText = "请先在上方选择书籍";
        return;
    }

    const container = document.getElementById('galaxy-container');
    // 重要：如果容器不可见（clientWidth=0），则中止，防止错误
    if (!container || container.clientWidth === 0) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    d3.select("#galaxy-container").selectAll("svg").remove();
    const loadingEl = document.getElementById('galaxy-loading');
    if(loadingEl) loadingEl.style.display = 'none';

    const svg = d3.select("#galaxy-container").append("svg")
        .attr("width", width)
        .attr("height", height)
        .style("background", "radial-gradient(ellipse at center, #1b2735 0%, #090a0f 100%)"); 

    const defs = svg.append("defs");

    const filter = defs.append("filter").attr("id", "glow");
    filter.append("feGaussianBlur")
        .attr("stdDeviation", "2.5")
        .attr("result", "coloredBlur");
    const feMerge = filter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    const colorScale = d3.scaleOrdinal()
        .domain(books)
        .range(['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c']);

    books.forEach((book) => {
        const baseColor = d3.color(colorScale(book));
        const highlight = baseColor.brighter(1.5); 
        const shadow = baseColor.darker(1.2);      
        
        const gradId = "grad-" + book.replace(/[^a-zA-Z0-9]/g, '');
        
        const gradient = defs.append("radialGradient")
            .attr("id", gradId)
            .attr("cx", "30%") 
            .attr("cy", "30%")
            .attr("r", "70%");

        gradient.append("stop").attr("offset", "0%").attr("stop-color", highlight.formatHex()).attr("stop-opacity", 1);
        gradient.append("stop").attr("offset", "50%").attr("stop-color", baseColor.formatHex()).attr("stop-opacity", 1);
        gradient.append("stop").attr("offset", "100%").attr("stop-color", shadow.formatHex()).attr("stop-opacity", 1);
    });

    let allNodes = [];
    let minMetric = Infinity;
    let maxMetric = -Infinity;

    books.forEach(bookName => {
        const positionData = realData[bookName]['functionWords'];
        const displayData = realData[bookName][currentMetric];

        if (positionData && displayData) {
            positionData.forEach((d, i) => {
                const metricItem = displayData[i];
                if (metricItem) {
                    const val = metricItem.value;
                    if (val < minMetric) minMetric = val;
                    if (val > maxMetric) maxMetric = val;

                    allNodes.push({
                        id: `${bookName}_${d.block}`,
                        book: bookName,
                        blockIndex: d.block,
                        pcaX: d.value,
                        pcaY: d.value_y || (Math.random() - 0.5),
                        realValue: val,
                        preview: metricItem.preview,
                        extendedPreview: d.extended_preview || metricItem.preview, 
                        keywords: metricItem.keywords,
                        x: width / 2 + (Math.random() - 0.5) * 50,
                        y: height / 2 + (Math.random() - 0.5) * 50
                    });
                }
            });
        }
    });

    const radiusScale = d3.scaleSqrt()
        .domain([minMetric, maxMetric])
        .range([4, 18]); 

    allNodes.forEach(d => {
        d.r = radiusScale(d.realValue);
    });

    const xExtent = d3.extent(allNodes, d => d.pcaX);
    const yExtent = d3.extent(allNodes, d => d.pcaY);
    const padding = 60;
    const xScale = d3.scaleLinear().domain(xExtent).range([padding, width - padding]);
    const yScale = d3.scaleLinear().domain(yExtent).range([padding, height - padding]);

    const g = svg.append("g");
    svg.call(d3.zoom()
        .scaleExtent([0.5, 5]) 
        .on("zoom", (event) => {
            g.attr("transform", event.transform);
        }));

    if (galaxySimulation) galaxySimulation.stop();

    galaxySimulation = d3.forceSimulation(allNodes)
        .force("x", d3.forceX(d => xScale(d.pcaX)).strength(0.8))
        .force("y", d3.forceY(d => yScale(d.pcaY)).strength(0.8))
        .force("collide", d3.forceCollide(d => d.r + 1).strength(1))
        .force("charge", d3.forceManyBody().strength(-15))
        .alphaTarget(0)
        .on("tick", ticked);

    const circles = g.selectAll("circle")
        .data(allNodes)
        .enter().append("circle")
        .attr("r", d => d.r)
        .attr("fill", d => `url(#grad-${d.book.replace(/[^a-zA-Z0-9]/g, '')})`)
        .attr("stroke", d => d3.color(colorScale(d.book)).darker(0.5))
        .attr("stroke-width", 0.5)
        .attr("stroke-opacity", 0.8)
        .style("cursor", "pointer")
        .call(d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended));

    circles.on("mouseover", function(event, d) {
        d3.select(this)
            .transition().duration(100)
            .attr("r", d.r * 1.5)
            .style("filter", "url(#glow)")
            .attr("stroke", "#fff")
            .attr("stroke-width", 2);
        
        const allCircles = g.selectAll("circle");
        const allNodeData = allCircles.data();
        const neighbors = findNeighbors(d, allNodeData, 120); 

        allCircles.filter(node => neighbors.includes(node))
            .transition().duration(100)
            .attr("stroke", "#f1c40f")
            .attr("stroke-width", 1.5)
            .attr("stroke-opacity", 1);

        const analysis = analyzeCluster(neighbors);
        const label = window.getMetricLabel ? getMetricLabel(currentMetric) : currentMetric;
        updateHUD(analysis, label);

        showTooltip(event, {
            block: d.blockIndex,
            value: typeof d.realValue === 'number' ? d.realValue.toFixed(4) : d.realValue,
            keywords: d.keywords,
            preview: d.preview 
        }, d.book);
    })
    .on("mouseout", function(event, d) {
        d3.select(this)
            .transition().duration(200)
            .attr("r", d.r)
            .style("filter", null)
            .attr("stroke", d3.color(colorScale(d.book)).darker(0.5))
            .attr("stroke-width", 0.5);

        g.selectAll("circle")
             .transition().duration(200)
             .attr("stroke", node => d3.color(colorScale(node.book)).darker(0.5))
             .attr("stroke-width", 0.5)
             .attr("stroke-opacity", 0.8);
        
        const hud = document.getElementById('galaxy-hud');
        if(hud) {
            hud.querySelector('.hud-title').innerText = "📡 星系探针：待机";
            hud.querySelector('.hud-content').innerHTML = '<p style="color:#7f8c8d; font-size:12px;">鼠标漫游以探测区域风格...</p>';
        }
        
        hideTooltip();
    })
    .on("click", (event, d) => {
        event.stopPropagation(); 
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
// 📜 悬浮页控制函数
// ==========================================

function openGalaxyModal(d) {
    const modal = document.getElementById('galaxy-modal');
    if(!modal) return;

    const titleEl = document.getElementById('modal-book-title');
    if(titleEl) titleEl.innerText = d.book;
    
    const blockEl = document.getElementById('modal-block-id');
    if(blockEl) blockEl.innerText = `Block #${d.blockIndex}`;
    
    let valDisplay = typeof d.realValue === 'number' ? d.realValue.toFixed(4) : d.realValue;
    const metricEl = document.getElementById('modal-metric-val');
    if(metricEl) metricEl.innerText = `${getMetricLabel(currentMetric)}: ${valDisplay}`;
    
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

    const textContainer = document.getElementById('modal-long-text');
    if(textContainer) {
        textContainer.innerText = d.extendedPreview || d.preview || "暂无详细文本内容...";
    }

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

window.restartGalaxy = function() {
    initStyleGalaxy();
};

window.selectBook = selectBook;

// ==========================================
// 📡 星系探针分析逻辑
// ==========================================

function findNeighbors(centerNode, allNodes, radius = 80) {
    return allNodes.filter(node => {
        const dx = node.x - centerNode.x;
        const dy = node.y - centerNode.y;
        return Math.sqrt(dx*dx + dy*dy) < radius;
    });
}

function analyzeCluster(neighbors) {
    if (neighbors.length === 0) return null;

    const bookCounts = {};
    neighbors.forEach(n => {
        bookCounts[n.book] = (bookCounts[n.book] || 0) + 1;
    });
    const dominantBook = Object.keys(bookCounts).reduce((a, b) => bookCounts[a] > bookCounts[b] ? a : b);
    const dominanceRate = (bookCounts[dominantBook] / neighbors.length) * 100;

    const totalMetric = neighbors.reduce((sum, n) => sum + (n.realValue || 0), 0);
    const avgMetric = totalMetric / neighbors.length;

    const keywordMap = {};
    neighbors.forEach(n => {
        if(n.keywords) {
            n.keywords.forEach(kw => {
                keywordMap[kw] = (keywordMap[kw] || 0) + 1;
            });
        }
    });
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

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    let words = [];
    if (typeof realData !== 'undefined' && realData) {
        Object.values(realData).forEach(bookData => {
            const metricData = bookData[currentMetric] || Object.values(bookData)[0];
            if (Array.isArray(metricData)) {
                metricData.forEach(block => {
                    if (block.keywords && Array.isArray(block.keywords)) {
                        const shortKws = block.keywords.filter(w => w.length < 10);
                        words.push(...shortKws);
                    }
                });
            }
        });
    }
    
    if (words.length < 50) {
        words = [
            'Literature', 'Style', 'Twain', 'London', 'Data', 'Visual', 
            'Python', 'Analysis', 'Fingerprint', 'Novel', 'Text', 'Code',
            'Stream', 'Galaxy', 'Emotion', 'Plot', 'Character'
        ];
    }
    
    words = [...new Set(words)];

    const fontSize = 14;
    const fontFamily = 'Consolas, monospace';
    const columns = Math.floor(canvas.width / fontSize);
    
    const drops = [];
    for (let i = 0; i < columns; i++) {
        drops[i] = Math.random() * -100; 
    }

    const colors = ['#3498db', '#e74c3c', '#2ecc71', '#9b59b6', '#f1c40f', '#34495e'];

    function draw() {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
        
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.textAlign = 'center';

        for (let i = 0; i < drops.length; i++) {
            const text = words[Math.floor(Math.random() * words.length)];
            
            const x = i * fontSize;
            const y = drops[i] * fontSize;

            if (y > 0 && y < canvas.height) {
                ctx.fillText(text, x, y);
            }

            if (y > canvas.height && Math.random() > 0.975) {
                drops[i] = 0;
            }

            drops[i]++;
        }
    }

    if (matrixInterval) clearInterval(matrixInterval);
    matrixInterval = setInterval(draw, 50); 
    
    window.onresize = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };
}

function toggleMatrixRain() {
    const canvas = document.getElementById('matrix-canvas');
    const btn = document.getElementById('btn-matrix');
    
    isMatrixOn = !isMatrixOn;

    if (isMatrixOn) {
        initMatrixRain(); 
        canvas.classList.add('active'); 
        btn.classList.add('active');
        btn.innerHTML = "🛑 停止文本雨";
    } else {
        canvas.classList.remove('active'); 
        btn.classList.remove('active');
        btn.innerHTML = "🌧️ 激活文本雨";
        
        setTimeout(() => {
            if (matrixInterval) clearInterval(matrixInterval);
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }, 1000);
    }
}