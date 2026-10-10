// static/js/d3-charts.js

// API配置（同源部署：本地与 Render 均使用空路径，自动指向当前站点）
const API_BASE_URL = '';
const API_ENDPOINTS = {
    fingerprintData: `${API_BASE_URL}/api/fingerprint-data`,
    books: `${API_BASE_URL}/api/books`
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function isLocalHost() {
    const hostname = (window.location.hostname || '').toLowerCase();
    return LOCAL_HOSTNAMES.has(hostname);
}

// 导出物里跟在「在线视图」后面的本机说明（第四十批）。屏幕上、本机打开时链接是
// localhost，发给别人打不开；导出物离开这台机器之后没人能补上这句话，所以凡是要写
// 「在线视图」的地方都带上它。线上部署时地址是公网地址，返回空串。
function localUrlNote() {
    return isLocalHost() ? '；在线视图指向本机地址，只有本机可以打开' : '';
}

// 这行和下面那句隐私说明一起，构成首屏那条常驻提示。原来两句加起来约 130 字，1000px 宽的
// 窗口里要折三行、整条 120px 高，而其中「勾选「存入我的图书馆」后……」半句与勾选框自己的
// title 逐字重复（那个 title 里说得很完整），删掉；剩下的隐私告知必须留在明面上——折进
// 抽屉反而是想藏起来的样子——所以是压缩措辞，不是折叠。
// 必须与 d3_visualization.html 里 #upload-status 的初始文案逐字一致：这一份是
// 上传出错后「恢复默认提示」用的，两处写得不一样就会变成前后两句话（第十一批栽过）。
const DEFAULT_UPLOAD_STATUS = '支持英文纯文本（.txt），建议 1 万词以上；超长篇（几十万词）请分次上传。Word 文档请先「另存为 → 纯文本」。';

// 全局变量
let realData = null;
let currentMetric = 'sentenceLength';
let selectedBooks = new Set();
let smoothness = 3;
let chartType = 'heatmap';
let currentTab = 'view-main'; // 记录当前标签页
let builtinBookNames = [];    // 服务器上常驻的示例书（用作解读参照基准，不含用户自己上传的）

// 本次会话吃到的这份语料的内容指纹（服务端在 /api/fingerprint-data 的 ETag 头上给，
// 内容一变它就变）。导出的摘要和数据表会写上它（第四十批）：导出物离开这个页面之后，
// 读的人（导师说「重算一遍」）需要知道当时算的是哪一份数据。它是**整份语料一个指纹**，
// 不是每本书一个；上传/删除一本书，所有书的这一行都会一起变。
let corpusFingerprint = null;

// 「全书对比」页那两块结论的最近一次渲染结果，由页面内另一段脚本在渲染时写入
// （本文件先于那段脚本加载，所以在这里声明不会撞上暂时性死区）。导出摘要与
// 「复制结论」都读它——屏幕上是哪几句，导出的就是哪几句，不另算一套。
let lastInsightLines = [];    // 一句话解读（含框选口径说明那句）
// 值得一看的片段：**每本书一条** {book, displayName, metricLabel, mean, brushScoped, items}。
// 顺序与「全书对比」页当前选中的书一致；某本书的请求还没回来时那一格是 null。
// 以前这里是单个对象，只装得下第一本书——同屏选了好几本时，屏幕和导出里都只有
// 第一本的偏离片段，而同页左边的「一句话解读」早就逐本遍历了。
let lastAnomalyReports = [];
// 与 lastAnomalyReports 一一对应的书名表（{name, displayName}），顺序即面板上的顺序。
// 面板重绘、以及「这本书的报告还没回来」时要显示哪本书的名字，都得靠它。
let lastAnomalyBooks = [];

const METRIC_KEYS = ['sentenceLength', 'simpsonIndex', 'hapaxLegomena', 'functionWords'];
const VIEW_IDS = ['view-main', 'view-galaxy', 'view-dashboard'];
const DEFAULT_SMOOTHNESS = 3;

// 「全书对比」页那排柱子（整体水平对比）的排序，四个状态由 advCycleSort 循环产生。
// 第一项就是页面打开时的默认值，链接里只在不是它的时候才写出来。
// 默认值只在这一份定义：页面内那段脚本要用它复位，走的是同一个常量，不另抄一遍。
const ADV_SORT_STATES = ['value-desc', 'value-asc', 'name-asc', 'name-desc'];
const DEFAULT_ADV_SORT = ADV_SORT_STATES[0];

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    // 先按状态设置视图，再加载数据。
    // 链接里有认得的参数就以链接为准——别人发来的、自己存下来发的，都必须赢过本机记忆，
    // 否则「打开即还原本次选择」这个承诺就废了。打开根地址（链接没带参数）时接着上次：
    // 写论文是几周里反复回来的事，每天都从默认那两本重新选起，人就只好一直开着页面不敢关。
    const linkState = readUrlState();
    const fromLink = linkState && Object.keys(linkState).length > 0;
    applyUrlState(fromLink ? linkState : (readSavedViewState() || linkState));
    initEventListeners();
    initTabKeyboard();
    applyQuickStartVisibility();
    updateChartTypeUI();
    setUploadStatus(`${DEFAULT_UPLOAD_STATUS} ${getUploadPrivacyNotice()}`);
    syncSaveToggleDefault();
    updateMetricHint();
    syncShareLinkTitle();
    trackDashboardCharts();
    loadBooksList();

    // 系统开了「减少动态效果」就不自动启动文本雨（按钮仍然可以手动打开）
    setMatrixRain(!prefersReducedMotion());
});

// ==========================================
// 🔗 视图状态放进网址（能分享、能复现）
// ==========================================
// 只写「看得见的选择」：指标、选中的书、标签页、图表类型、平滑度、框选范围。
// 用 replaceState 而不是 pushState——不往浏览器历史里塞记录，返回键行为不变。
let pendingUrlBooks = null;
let pendingUrlBrush = null;

// params 可以不传（默认取当前网址的查询串）。传进来的那一份给「上次离开时的视图」用
// （见 readSavedViewState）：它存的也是同一套查询串，于是两处共用同一份白名单校验，
// 不会出现「链接里校验过的值，从本机记忆里读出来却没人管」。
function readUrlState(params) {
    if (!params) {
        try {
            params = new URLSearchParams(window.location.search);
        } catch (e) {
            return null; // 极老的浏览器没有 URLSearchParams，当作没有链接状态
        }
    }

    const state = {};
    const metric = params.get('metric');
    if (metric && METRIC_KEYS.includes(metric)) state.metric = metric;
    const chart = params.get('chart');
    if (chart === 'line' || chart === 'heatmap') state.chartType = chart;
    const smooth = Number(params.get('smooth'));
    if (isFiniteNumber(smooth) && smooth >= 1 && smooth <= 10) state.smoothness = smooth;
    const view = params.get('view');
    if (view && VIEW_IDS.includes(view)) state.tab = view;
    const books = params.get('books');
    if (books) {
        const list = books.split('|').map(item => item.trim()).filter(Boolean);
        if (list.length > 0) state.books = list;
    }
    const brush = params.get('brush');
    if (brush && /^\d+(\.\d+)?-\d+(\.\d+)?$/.test(brush)) state.brush = brush.split('-').map(Number);
    // 白名单校验，和 metric / chart 一个规矩：链接是手打的、也会被聊天软件截断，
    // 认不出来的值一律当没写，不能让一个错参数把页面带到别处去
    const sort = params.get('sort');
    if (sort && ADV_SORT_STATES.includes(sort)) state.sort = sort;
    return state;
}

function applyUrlState(state) {
    if (!state) return;

    if (state.metric) {
        currentMetric = state.metric;
        const select = document.getElementById('metricSelect');
        if (select) select.value = state.metric;
    }
    if (state.chartType) {
        chartType = state.chartType;
        const select = document.getElementById('chartTypeSelect');
        if (select) select.value = state.chartType;
    }
    if (isFiniteNumber(state.smoothness)) {
        smoothness = state.smoothness;
        const slider = document.getElementById('smoothness');
        if (slider) slider.value = String(state.smoothness);
    }
    // 「全书对比」页柱子的排序。它也是「看得见的选择」：老师按书名排好再发链接，
    // 收链接的人却看到按数值排的那一份，这个链接就没做到它自称的「打开即还原本次选择」。
    // 就地改字段、不换掉整个对象：页面内几处渲染会先取到 config 再读它。
    if (state.sort) {
        try {
            const parts = state.sort.split('-');
            advState.sortConfig.mean.mode = parts[0];
            advState.sortConfig.mean.order = parts[1];
            // 光改状态不够：标题右边那行「数值/书名」和图标是 updateSortUI 画的，
            // 而它平时只在重画图表时才跑，此刻一张图都还没建（首次渲染会直接 return）
            if (typeof updateSortUI === 'function') updateSortUI();
        } catch (e) { /* 看板状态还没建起来，就保持默认排序 */ }
    }
    // 先记住链接里的选书再切标签：switchTab 会顺手把状态写回网址，
    // 晚一步记就会把 books 参数抹掉
    if (state.books) {
        pendingUrlBooks = state.books;
        selectedBooks = new Set(state.books);
    }
    if (state.brush) pendingUrlBrush = state.brush;

    // 按链接还原视图时不滚：这时数据还没到、三个视图都是空盒子，滚过去只会落在
    // 一个「正在加载…」上；而且浏览器自己的滚动位置还原会跟这里抢。
    // 打开链接的人该先看到的是「这台机器上有哪些书、选中了哪几本」。
    if (state.tab) window.switchTab(state.tab, { scroll: false });

    updateMetricHint();
}

// 把当前视图状态写回网址栏（不产生历史记录）
function syncUrlState() {
    if (!window.history || !window.history.replaceState) return;
    const url = buildStateUrl();
    window.history.replaceState(null, '', url);
    // 顺手记到本机：下次打开根地址时接着上次（链接里有认得的参数时链接优先，
    // 见 DOMContentLoaded 里那一段）。放在这里是因为这个函数就是「视图变了」的唯一出口，
    // 另外挂几处的话，迟早有一处新加的改状态忘了记。
    rememberViewState(url);
}

// 当前状态对应的完整链接。分两种用途，靠 options.shareable 区分（第四十六批）：
//   · 默认（地址栏、刷新要回到自己的书）：带上所选的全部书；
//   · shareable（所有要离开浏览器的产物——复制链接、导出摘要、复制结论、引用条目）：
//     剔掉自己上传的那几本。
// 为什么剔：内置书在别人的服务器上也有，上传的书没有。名字带上去对方也打不开，
// 而摘要里紧接着就有一句「链接里没有《X》」，URL 里却白纸黑字写着它——同一个链接，
// 两句话打架；「复制此链接」的回执也早写着「不含你上传的 N 本」，而它复制的 URL 里带着。
// 判据只写在这里一份（getUnsharedUploadedBooks），几处口径不会再各说一套。
function buildStateUrl({ shareable = false } = {}) {
    const params = new URLSearchParams();
    if (currentMetric !== METRIC_KEYS[0]) params.set('metric', currentMetric);
    if (chartType !== 'heatmap') params.set('chart', chartType);
    if (smoothness !== DEFAULT_SMOOTHNESS) params.set('smooth', String(smoothness));
    if (currentTab !== VIEW_IDS[0]) params.set('view', currentTab);
    // 「全书对比」页上以该页的书籍筛选为准，链接打开后看到的就是同一批书
    let books = Array.from(getActiveBookSet());
    if (shareable) {
        const unshared = getUnsharedUploadedBooks();
        books = books.filter(name => !unshared.includes(name));
    }
    if (books.length > 0) params.set('books', books.join('|'));

    // advState 定义在页面内的另一段脚本里，取不到就当没有框选
    try {
        const brushRange = (typeof advState !== 'undefined' && advState) ? advState.brushRange : null;
        if (Array.isArray(brushRange) && brushRange.length === 2 && brushRange.every(isFiniteNumber)) {
            params.set('brush', `${brushRange[0].toFixed(4)}-${brushRange[1].toFixed(4)}`);
        }
    } catch (e) { /* 没有框选状态，忽略 */ }

    // 「全书对比」页柱子的排序：只在不是默认顺序时才写。默认顺序带上去只会让链接
    // 长出一串没人改过的参数，而链接是要被念出来、被微信折行的。
    try {
        const meanSort = (typeof advState !== 'undefined' && advState) ? advState.sortConfig.mean : null;
        if (meanSort) {
            const key = `${meanSort.mode}-${meanSort.order}`;
            if (key !== DEFAULT_ADV_SORT) params.set('sort', key);
        }
    } catch (e) { /* 没有看板状态，按默认排序 */ }

    const query = params.toString();
    return `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ''}`;
}

// ---- 上次离开时的视图（本机记住，下次打开接着上次）----
// 存的就是查询串本身（buildStateUrl 产出的「?」之后那一段），不另立一套字段：同一个格式、
// 同一份白名单校验（readUrlState），两份格式迟早会有一份忘了跟着改。键名带版本号——
// 将来字段变了，旧值直接读不出来、退回默认，而不是把页面带到一个半旧半新的状态上。
const LAST_VIEW_KEY = 'wf-last-view-v1';

function readSavedViewState() {
    if (!window.localStorage) return null;
    try {
        const raw = window.localStorage.getItem(LAST_VIEW_KEY);
        if (!raw) return null;
        return readUrlState(new URLSearchParams(raw));
    } catch (e) {
        return null; // 无痕模式 / 存储被禁用 / 旧值不是合法查询串：一律当作没有记忆
    }
}

function rememberViewState(url) {
    if (!window.localStorage) return;
    try {
        const cut = url.indexOf('?');
        const query = cut < 0 ? '' : url.slice(cut + 1);
        // 全默认时本来就不该留下痕迹（buildStateUrl 对默认值不写参数，所以这里一般是空）
        if (!query) { window.localStorage.removeItem(LAST_VIEW_KEY); return; }
        window.localStorage.setItem(LAST_VIEW_KEY, query);
    } catch (e) { /* 存不下就算了：记不住状态而已，不能因为这件事打断任何一次操作 */ }
}

// 「链接里没有哪几本」。内置书在别人的服务器上也有，自己上传的那几本没有——对方打开时
// 那几本会静默消失（url 里那个名字对不上任何一本书），而发链接的人以为分享的是完整结果。
// 复制链接、导出摘要两处都要说同一件事，所以判据只写在这里一份。
// builtinBookNames 还没建好时（书单还在加载）不做判断，免得全被当成上传的。
function getUnsharedUploadedBooks() {
    if (builtinBookNames.length === 0) return [];
    return Array.from(getActiveBookSet()).filter(name => !builtinBookNames.includes(name));
}

// 摘要里的「在线视图」链接有两件事必须说清，否则收件人打开看到的会是另一份分析，
// 而摘要里没有一个字解释为什么对不上。BibTeX 导出里一直有本机地址那一句，摘要里没有
// （同一份分析的两个导出物说法不一致），第三十九批补齐。
function buildShareCaveats() {
    const notes = [];
    if (isLocalHost()) {
        notes.push('- 上面的链接指向本机地址，仅本机可以打开；如需发送给他人，请连同本摘要一起发送。');
    }
    const uploaded = getUnsharedUploadedBooks();
    if (uploaded.length > 0) {
        const names = uploaded.map(getBookDisplayName).join('、');
        notes.push(`- 链接里没有《${names}》（共 ${uploaded.length} 本）：这是你自己上传的文本，`
            + '他人打开链接时看不到这几本，看到的会是少掉这几本的另一份分析。');
    }
    return notes;
}

// 「链接里不含你上传的那几本」——一句跟在链接后面的短注（第四十六批）。
// 摘要里有 buildShareCaveats 那一条独立的提醒，但复制结论、方法说明、引用条目
// 这三处没有那个块，链接却一样会离开浏览器。共用同一个判据，不各写一份。
function unsharedUploadedNote() {
    const uploaded = getUnsharedUploadedBooks();
    if (uploaded.length === 0) return '';
    const names = uploaded.map(getBookDisplayName).join('、');
    return `；链接里不含你上传的 ${uploaded.length} 本（《${names}》），他人打开时看不到这几本`;
}

// 「复制此链接」按钮的说明必须与它真能做的事一致（第四十二批）。
// 第四十批把 HTML 里写死的「发给同事即可复现」留着没动，理由是线上（公网地址）那句是真的、
// 只有本机是假的，不想为了本机把线上的话改少。可问题是同一个控件点下去的回执偏偏写着
// 「本机地址，只有本机能打开」——一个按钮前后两句互相打脸，而拿它做判断的正是第一次来的老师。
// 所以既不删掉线上的承诺、也不留本机那句假话：按当前地址给对应的那一句。
// 判断口径与点击后的回执同源（都用 isLocalHost），说明和回执不会再各说一套。
function syncShareLinkTitle() {
    const btn = document.getElementById('copyLinkBtn');
    if (!btn) return;
    btn.title = isLocalHost()
        ? '把当前指标、选书、视图复制成链接；本机地址只有这台电脑能打开，如需发送给他人，请改用「更多导出 → 导出摘要」'
        : '把当前指标、选书、视图复制成链接，他人打开即可复现（你自己上传的文本不在链接里）';
}

// 「复制此链接」：把当前视图（指标/选书/标签页/图形/框选）发给同事
function copyShareLink(button) {
    syncUrlState();
    const uploaded = getUnsharedUploadedBooks();
    // 本机打开时复制出来的是 localhost 链接（buildStateUrl 用的是浏览器当前地址）。
    // 按钮说明由 syncShareLinkTitle 按地址给，这里只管点下去之后的回执。
    const localPart = isLocalHost() ? '（本机地址，只有本机能打开）' : '';
    const okText = uploaded.length
        ? `✓ 链接已复制${localPart}（不含你上传的 ${uploaded.length} 本）`
        : `✓ 链接已复制${localPart}`;
    copyTextToClipboard(buildStateUrl({ shareable: true }), button, okText);
    // 两条提醒都往同一条状态栏写，所以合成一句再发一次——分两次调用的话后一条会把
    // 前一条顶掉（两条同时成立时用户只看得到后半句，本机地址那句就白说了）。
    const notices = [];
    if (isLocalHost()) {
        notices.push('这条链接指向本机地址，只有这台电脑能打开。');
    }
    if (uploaded.length > 0) {
        const names = uploaded.map(getBookDisplayName).join('、');
        const where = isLocalHost() ? '这台电脑' : '这个服务器';
        notices.push(`链接里没有《${names}》：这是你自己上传的文本，只存在${where}上，他人打开链接时看不到。`);
    }
    if (notices.length > 0) {
        notices.push('如需分享完整结果，请用「更多导出 → 导出摘要」。');
        setGlobalStatus('notice', notices.join(''));
    }
}

// 取走链接里带的框选范围（仪表盘初始化时用，取一次就清掉）
function consumePendingUrlBrush() {
    const range = pendingUrlBrush;
    pendingUrlBrush = null;
    return Array.isArray(range) && range.length === 2 ? range : null;
}

// 「存入我的图书馆」勾选框：本地默认勾选（本机留档安全），远程默认不勾（默认不落盘）
function syncSaveToggleDefault() {
    const cb = document.getElementById('save-upload');
    if (cb) cb.checked = isLocalHost();
}

// 上传是否要写入「我的图书馆」：以勾选框为准；找不到勾选框时本机默认保存、远程不保存
function isUploadSaveWanted() {
    const cb = document.getElementById('save-upload');
    if (cb) return cb.checked;
    return isLocalHost();
}

function getUploadPrivacyNotice() {
    if (isLocalHost()) {
        return '分析只在本机进行，不上传服务器。';
    }
    return '文件会发到本服务器分析、未加密传输，请不要上传敏感或未获授权的文本。';
}

function setUploadStatus(message, state = '') {
    const statusEl = document.getElementById('upload-status');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = `upload-status${state ? ` ${state}` : ''}`;
}

function setUploadBusy(isBusy) {
    const bar = document.getElementById('upload-bar');
    const fileInput = document.getElementById('file-upload');
    const uploadBtn = document.getElementById('upload-btn');
    if (bar) bar.setAttribute('aria-busy', String(isBusy));
    // 忙时禁用 input 本身就够了：它既不可点也不在 Tab 序列里，
    // 屏幕阅读器读到的也是「不可用」。原来那句 aria-disabled 挂在 label 上，
    // 而 label 没有能承载它的角色，等于没用。
    if (fileInput) fileInput.disabled = isBusy;
    if (uploadBtn) uploadBtn.classList.toggle('is-busy', isBusy);
}

// 「已等待 X 秒」：长文分析动辄几十秒，只有一句「请勿关闭页面」没有任何时间感。
// 两处刻意的设计：
//   1) 按墙钟算（Date.now 差值），不是数 setInterval 触发了几次——后台标签页里
//      setInterval 会被浏览器节流到远低于每秒一次，数 tick 秒表会越走越慢；
//   2) 只写给独立的 #upload-elapsed（aria-hidden），绝不写进 #upload-status——
//      那是 aria-live="polite" 区域，每秒整句重写会让读屏一秒念一遍。
// 也刻意不挂在 setUploadBusy 上：删书流程也会调它，会冒出莫名其妙的秒表。
let uploadTicker = null;
let uploadStartedAt = 0;

function stopUploadTicker() {
    if (uploadTicker !== null) {
        clearInterval(uploadTicker);
        uploadTicker = null;
    }
    const el = document.getElementById('upload-elapsed');
    if (el) {
        el.hidden = true;
        el.textContent = '';
    }
}

function startUploadTicker() {
    stopUploadTicker(); // 先清旧的：绝不并存两个 interval（连传两个文件时）
    const el = document.getElementById('upload-elapsed');
    if (!el) return;
    uploadStartedAt = Date.now();
    el.hidden = false;
    el.textContent = '已等待 0 秒';
    uploadTicker = setInterval(() => {
        el.textContent = `已等待 ${Math.floor((Date.now() - uploadStartedAt) / 1000)} 秒`;
    }, 1000);
}

function getErrorMessage(response, result) {
    // 先认服务端给的 message，再管状态码。原来的顺序反了：413 一律被下面这句硬编码的
    // 「不能超过 50 MB」顶掉，而那个数字在线上是错的（nginx 在 20 MB 就拦），
    // 连服务端自己写好的解释也一并丢掉。走到兜底 413 只剩一种情况——请求根本没到应用，
    // 是 nginx 直接回的 HTML 错误页，那种响应里读不到 message。
    if (result && result.message) return result.message;
    if (response.status === 413) {
        return '文件太大，服务器不接受这么大的上传。请先截取要研究的章节，或拆成几个文件分次上传。';
    }
    // 状态码不再拼进给读者看的那句话（第三十五批）。读这句话的人是文学研究者，
    // 「HTTP 500」对他没有任何可操作性；代码改走 console.warn，排障时照样找得到。
    if (!response.ok) {
        console.warn('[分析服务] HTTP', response.status);
        return '服务器暂时无法完成分析，请稍后重试。';
    }
    return '服务器返回了无法识别的结果，请稍后重试。';
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function truncateText(value, length = 18) {
    const text = String(value ?? '');
    return text.length > length ? text.substring(0, length - 3) + '…' : text;
}

// 每个指标的显示精度（唯一来源，别在各处另写 toFixed）。
// 原来的 formatMetricValue(value, digits=2) 已并入 formatMetric：
// 默认 2 位正是「用词重复度」被压成 0.01 的根因，所以不再保留那个容易误用的默认值。
// 依据是 data/processed/all_books.json 里四本内置书的真实取值范围：
//   平均句长    14.2 – 32.4       → 2 位够
//   用词重复度  0.0089 – 0.0155   → 必须 4 位，2 位会把四本书全压成「0.01」，屏幕上看着一模一样
//   独特词丰富度 1725 – 2516（Honoré R）→ 取整
//   风格走向    ±0.07（二维坐标）  → 3 位
const METRIC_DIGITS = {
    sentenceLength: 2,
    simpsonIndex: 4,
    hapaxLegomena: 0,
    functionWords: 3
};

function getMetricDigits(metric = currentMetric) {
    return isFiniteNumber(METRIC_DIGITS[metric]) ? METRIC_DIGITS[metric] : 2;
}

// 显示指标数值统一走这个函数：位数跟着指标走，四个出口（详情面板 / 图注 / 摘要 / 悬停）口径一致
function formatMetric(value, metric = currentMetric) {
    if (!isFiniteNumber(value)) return '暂无';
    const digits = getMetricDigits(metric);
    return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
}

// 导出数据表里的数字格式（第四十批）。表格原先直接把原始浮点数写进去，于是出现
// 0.009052769287855193 这种 18 位小数——屏幕上是 2–4 位，两边对不上；而 18 位里
// 没有任何一位是真实的（分词规则和窗口大小决定不了小数点后第 18 位）。
// 规则取「4 位有效数字」，不是「4 位小数」：坐标量级只有 ±0.009，取 4 位小数只剩
// 2 位有效数字（0.0091），等于把值抹掉。极小的数退化成科学计数法时按原值输出，别
// 让表格里出现「1.2e-7」这种在 Excel/R 里要靠猜的写法。
function formatExportNumber(value) {
    if (!isFiniteNumber(value)) return '';
    if (value === 0) return '0';
    const text = Number(value).toPrecision(4);
    return text.includes('e') ? String(Number(value)) : text;
}

function getMetricValues(bookName, metric) {
    const values = realData && realData[bookName] ? realData[bookName][metric] : null;
    if (!Array.isArray(values)) return [];
    return values.filter(d => d && isFiniteNumber(d.value));
}

function getBookButtonById(bookId) {
    return Array.from(document.querySelectorAll('.book-btn'))
        .find(btn => btn.dataset.id === bookId) || null;
}

function normalizeExtent(extent, fallback = 0) {
    let [min, max] = extent;
    if (!isFiniteNumber(min) || !isFiniteNumber(max)) return [fallback - 1, fallback + 1];
    if (min === max) return [min - 1, max + 1];
    return [min, max];
}

// 「这把尺子量得出差别吗」——按**屏幕上显示得出来的精度**判（formatMetric），不是按浮点数
// 是否严格相等。原来的判据是 min === max：于是「最小 14.481、最大 14.482」这种（显示出来
// 都是 14.48）会走进正常那条路，radiusScale 把整段 [4,14] 铺在这个 0.001 的跨度上——
// 读者看到 3.5 倍的圆点大小差，而屏幕上两边的数字一模一样。图在替一个看不见的差别大声说话。
// 改成「两个端点显示成同一个数」之后，这种情形与「所有值完全相同」走同一条路（见下面
// renderGalaxySizeLegend 与 initStyleGalaxy 两处调用），圆点大小也就基本一样了。
// 数字取到几位是现成的口径（METRIC_DIGITS），这里直接复用，免得又出现一套「多少算一样」。
function sizeExtentIsFlat(extent) {
    const [min, max] = extent;
    if (!isFiniteNumber(min) || !isFiniteNumber(max)) return true;
    return formatMetric(min) === formatMetric(max);
}

// ==========================================
// ✧ 风格星系的跨书可比性
// ==========================================
// 只有出自同一个投影模型（mode = "shared"）的书，坐标才落在同一个基底上、才能画进同一张图。
// 老书库（v1）是在各自书上单独拟合的，把它们混画在一起会让人读出并不存在的差异。
function getGalaxyComparability(books) {
    const shared = [];
    const others = [];
    books.forEach((book) => {
        const meta = normalizeBookMeta(book);
        const proj = meta && meta.projection;
        if (proj && proj.mode === 'shared' && proj.axisExtent) shared.push({ book, proj });
        else others.push(book);
    });

    const modelIds = Array.from(new Set(shared.map(item => item.proj.modelId || 'unknown')));
    if (modelIds.length > 1) {
        // 出自不同模型 = 两套基底，同样不能混画
        return {
            plotBooks: [], independentBooks: books.slice(),
            axisExtent: null, axisLabels: [], modelId: null, mixedModel: true
        };
    }

    const first = shared[0] || null;
    return {
        plotBooks: shared.map(item => item.book),
        independentBooks: others,
        axisExtent: first ? first.proj.axisExtent : null,
        axisLabels: first ? (first.proj.axisLabels || []) : [],
        // 各成分解释了多大比例的差异，横轴纵轴各一个（第三十六批）。
        // 这是解读这张图的前提：横轴 69%、纵轴 8.5%，差八倍——「两点靠得近」
        // 几乎完全由横向位置决定。以前这个数只出现在导出的 BibTeX 里，图上没有。
        explainedVarianceRatio: first ? (first.proj.explainedVarianceRatio || []) : [],
        modelId: first ? first.proj.modelId : null,
        mixedModel: false
    };
}

// 坐标系范围：优先用模型给出的固定范围，切换选书时点不会乱跳。
// 若数据的坐标超出该范围（例如上传了一本风格差别很大的书），才扩展范围并如实说明。
function resolveGalaxyExtent(nodes, fixedExtent) {
    const xs = nodes.map(d => d.pcaX).filter(isFiniteNumber);
    const ys = nodes.map(d => d.pcaY).filter(isFiniteNumber);
    const pad = (range) => {
        const span = (range[1] - range[0]) || 1;
        return [range[0] - span * 0.05, range[1] + span * 0.05];
    };

    if (fixedExtent && Array.isArray(fixedExtent.x) && Array.isArray(fixedExtent.y)) {
        const x = pad(fixedExtent.x);
        const y = pad(fixedExtent.y);
        const outX = xs.some(v => v < x[0] || v > x[1]);
        const outY = ys.some(v => v < y[0] || v > y[1]);
        return {
            x: outX ? [Math.min(x[0], d3.min(xs)), Math.max(x[1], d3.max(xs))] : x,
            y: outY ? [Math.min(y[0], d3.min(ys)), Math.max(y[1], d3.max(ys))] : y,
            outOfRange: outX || outY
        };
    }
    return {
        x: normalizeExtent(d3.extent(xs)),
        y: normalizeExtent(d3.extent(ys)),
        outOfRange: false
    };
}

// 把「这批点能不能互相比较」写在图下面，别让用户自己去猜
function renderGalaxyNote(comparability, extent, droppedBlocks) {
    const el = document.getElementById('galaxy-axis-note');
    if (!el) return;
    const lines = [];
    let warn = false;

    if (comparability.plotBooks.length === 0) {
        warn = true;
        lines.push('⚠ 当前选中的书没有共同的坐标基准（多为旧版数据或不同模型生成的坐标），下面按「各书各自计算」的方式摆放：点与点之间的距离不可直接比较。重新上传一次 .txt 即可获得可比坐标。');
    } else {
        (comparability.axisLabels || []).forEach(text => lines.push(text));

        // 两个轴各自承担了多少差异，是解读这张图的前提，以前只出现在导出的 BibTeX 里。
        // 不说的话，读者会把「靠得近」当成整体风格接近，其实那几乎全是横向位置在说话
        // （第三十六批）。
        //
        // 第四十三批把括号里的两个百分数删了。它们本来就是为了说明「横向远多于纵向」，
        // 而那两行轴标题就在正上方，逐字写着「第 1 主成分 · 解释 69.2% 的差异」——
        // 同一块面板里同样的两个数挨着印两遍。结论（横向为主）留着，数由轴标题去说。
        const ratios = (comparability.explainedVarianceRatio || []).slice(0, 2).filter(isFiniteNumber);
        if (ratios.length === 2) {
            lines.push('横轴承担的差异远多于纵轴，所以「靠得近」主要说明横向位置接近；'
                + '坐标原点是内置语料的平均水平。');
        }

        // 可比时用的是与内置示例书共用的那套固定坐标范围（resolveGalaxyExtent 的
        // fixedExtent 分支），不随选书改变，所以只选一两本时点只会占到画布的一角。
        // 实测 1440 与 900 两种宽度下点云都只占到画布宽度的三成上下——这是设计，不是画坏了，
        // 但页面从来没说过，用户容易以为图出问题了。第三十六批补上坐标轴之后，
        // 空出来的地方不再只是一片空白，而是「有刻度的余地」，所以这句话也改写：
        // 原来写「集中在中间一小块」，实测点聚在**左**半边，说「中间」反而对不上。
        //
        // 条件必须卡在这里：独立模式（各书各自算，范围不共享）下这句话是假话，
        // 而且会和同一个面板上的「各书各自计算」告警直接打架；outOfRange 时范围已经
        // 被扩展过去容纳超界的数据，点也不再挤在一角，说了反而误导。
        if (extent && !extent.outOfRange) {
            lines.push('（空出的部分来自「与内置示例书共用坐标范围」，并非漏画。需要更细时可滚轮放大，坐标轴会随之重新标注。）');
        }

        // 力导向的碰撞力会把点从真实坐标上推开一点才不重叠，读者有权知道位置是近似值
        lines.push('（为避免点互相遮挡，点的位置做过轻微推开，因此图上位置是近似值。）');

        // 同色浅色区域的说明（第三十七批）。画面上多了一层编码，就得有一句话说它是什么，
        // 否则读者只会看到几块「不知道哪来的底色」。只在真的画了两本以上时才说：
        // 一本书的轮廓说不了「重叠」这件事，讲了反而让人去找一块并不存在的叠加区。
        if (comparability.plotBooks.length >= 2) {
            lines.push('（同一本书的点被一块同色的浅色区域圈住；两块区域叠在一起，说明这两本书的风格区间有重叠。）');
            // 记号只画在球心，不解释就没人认得（第三十八批）。只在两本以上时说：
            // 一本书不需要靠记号分辨，讲了反而多一句读者用不上的话。
            lines.push('（球心上的纸色记号 — ｜ ＋ 也用于区分书籍：颜色不易分辨时，可对照上方图例辨认。）');
        }
        if (comparability.independentBooks.length > 0) {
            warn = true;
            const names = comparability.independentBooks.map(getBookDisplayName).join('、');
            lines.push(`⚠ 《${names}》的坐标是旧版数据、没有共同基准，因此没有画进这张图；重新上传同名 .txt 即可获得可比坐标。`);
        }
        if (comparability.mixedModel) {
            warn = true;
            lines.push('⚠ 选中的书来自不同的坐标模型，无法直接比较，本图未画入。');
        }
        if (extent && extent.outOfRange) {
            warn = true;
            lines.push('⚠ 有片段的坐标超出了内置示例书的范围，图已自动扩展显示。');
        }
        if (droppedBlocks > 0) {
            lines.push(`（有 ${droppedBlocks} 个片段缺少坐标数据，未画入。）`);
        }
        if (lines.length === 0) {
            el.hidden = true;
            el.innerHTML = '';
            return;
        }
    }

    el.hidden = false;
    el.className = 'galaxy-note' + (warn ? ' galaxy-note-warn' : '');
    el.innerHTML = lines
        .map(text => `<span class="galaxy-note-line">${escapeHtml(text)}</span>`)
        .join('');
}


// 吸顶的页签条挡在视口顶端，滚上去的内容标题会正正压在它底下，所以要先量它多高。
// 这个高度不是常量：窄屏（≤560px）改过字号和内边距，三个按钮 flex-wrap 换行后还会更高，
// 与其在 CSS 里写一个必然在某些宽度下遮住标题的 scroll-margin-top，不如每次实测。
function stickyTabsOffset() {
    const nav = document.querySelector('.tab-navigation');
    if (!nav) return 0;
    // +8：页签条底下还挂着 box-shadow(0 8px 14px -10px)，留一点缝免得标题贴着边
    return Math.ceil(nav.getBoundingClientRect().height) + 8;
}

// 元素在文档里的**布局**位置（offsetTop 逐级相加），不含 CSS transform。
// 这里不能用 getBoundingClientRect()：.view-section 每次显示都会重跑一遍
// fadeIn 动画（CSS `animation: fadeIn 0.4s`，from 状态是 translateY(10px)），
// 切页签的那一刻量到的是被动画挪下去 10px 的假位置，照着它滚就会多滚 10px——
// 正好把这行注释下面留的那点缝吃干净，标题还会压进吸顶条两像素。
// offsetTop 反映的是布局盒，动画在跑也不受影响。
function layoutOffsetTop(el) {
    let top = 0;
    for (let node = el; node; node = node.offsetParent) top += node.offsetTop;
    return top;
}

// 把某个视图的顶部滚到吸顶条下沿。用 window.scrollTo 而不是 scrollIntoView：
// 吸顶高度是动态的，反正都要实测，直接算 Y 更短、更显式，也能自己夹住顶部。
function scrollToSection(section) {
    if (!section) return;
    const top = layoutOffsetTop(section) - stickyTabsOffset();
    // behavior 必须显式传，而且必须自己问 prefersReducedMotion()：
    // JS 传进来的 behavior 会覆盖 CSS，CSS 里那条 scroll-behavior: auto !important
    // （prefers-reduced-motion 媒体查询下）保护不了这条路。
    window.scrollTo({
        top: Math.max(0, top),
        behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    });
}

// Tab 切换逻辑
window.switchTab = function(tabId, options) {
    currentTab = tabId;

    // 同步 tab/tabpanel 语义，让键盘和读屏用户知道当前视图
    document.querySelectorAll('.tab-btn').forEach(btn => {
        const isActive = btn.getAttribute('aria-controls') === tabId;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
        btn.setAttribute('tabindex', isActive ? '0' : '-1');
    });

    document.querySelectorAll('.view-section').forEach(section => {
        const isActive = section.id === tabId;
        section.classList.toggle('active', isActive);
        section.hidden = !isActive;
    });

    const activeSection = document.getElementById(tabId);
    if (activeSection) {
        // 滚到刚切出来的这块内容。放在这里、不进下面的 setTimeout：
        // 视图顶部的 Y 只由它上面的内容决定（header/选书/上传/工具条都是固定高），
        // 图表渲染在视图内部、位于这个锚点之下，撑高多少都不移动它。
        // 上面压着约 630px 的工具区，不滚的话切了页签也看不见图。
        if (!options || options.scroll !== false) scrollToSection(activeSection);

        // 延迟一点点以确保 DOM 布局已更新
        setTimeout(() => {
            if (tabId === 'view-main' && realData) {
                initChart();
            } else if (tabId === 'view-galaxy' && realData) {
                initStyleGalaxy();
            } else if (tabId === 'view-dashboard' && realData) {
                if (window.initAdvancedData) window.initAdvancedData();
            }
        }, 50);
    }

    syncUrlState();
};

// 初始化事件监听器
function initEventListeners() {
    // 指标选择
    document.getElementById('metricSelect').addEventListener('change', function(e) {
        currentMetric = e.target.value;
        // 右侧详情卡里的数值是按上一个指标算出来的，图重画之后它就成了「另一张图上的数字」
        resetDetailPanelIfStale('换过观察角度');
        updateMetricHint();
        if (realData) {
            // 数据变化时，更新所有图表
            refreshAllActiveCharts();
        }
        // 面板空闲时那块「先看这 3 段」也是按指标算的，换指标必须跟着重算，
        // 否则它会停在上一套数字上（图已经换了，卡片没换——正是最容易被当成 bug 的那种）
        renderQuickPreviewIfIdle();
        syncUrlState();
    });

    // 平滑度调整。滑块拖动时 input 是连续触发的，而 initChart() 第一步就把
    // svg 里所有元素 remove 掉再整张重画（轴、网格、每本书的曲线、上百个数据点、
    // 图例），代价随「书数 × 片段数」增长——不节流的话拖一次要重画几十遍，
    // 表现就是拖不动、松手才跟上。
    // 用 rAF 合并成每帧最多画一次：取的是 module 级的 smoothness，永远是当前值，
    // 所以中途丢帧只是少画一次，不会画成旧值。URL 同步照旧每次 input 都做，
    // 免得标签页在后台时 rAF 不触发、分享链接停在半路的值上。
    let smoothnessFrame = null;
    document.getElementById('smoothness').addEventListener('input', function(e) {
        smoothness = parseInt(e.target.value);
        syncUrlState();
        if (!realData || smoothnessFrame) return;
        smoothnessFrame = requestAnimationFrame(() => {
            smoothnessFrame = null;
            initChart();
        });
    });

    // 导出图像 / 导出摘要 / 复制链接
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportChart);
    const exportSummaryBtn = document.getElementById('exportSummaryBtn');
    if (exportSummaryBtn) exportSummaryBtn.addEventListener('click', exportSummary);
    const exportSvgBtn = document.getElementById('exportSvgBtn');
    if (exportSvgBtn) exportSvgBtn.addEventListener('click', exportVectorChart);
    const exportDataBtn = document.getElementById('exportDataBtn');
    if (exportDataBtn) exportDataBtn.addEventListener('click', exportTableData);
    const exportCiteBtn = document.getElementById('exportCiteBtn');
    if (exportCiteBtn) exportCiteBtn.addEventListener('click', exportCitation);
    const copyLinkBtn = document.getElementById('copyLinkBtn');
    if (copyLinkBtn) copyLinkBtn.addEventListener('click', () => copyShareLink(copyLinkBtn));
    const copyConclusionBtn = document.getElementById('copyConclusionBtn');
    if (copyConclusionBtn) copyConclusionBtn.addEventListener('click', () => copyConclusion(copyConclusionBtn));
    // 「更多导出」是个纯显隐开关：四个低频按钮平时收在 #export-more 里（[hidden] 让它们
    // 连 Tab 都进不去），点一下就地展开。aria-expanded 是标准属性，读屏会念出「已展开/已折叠」。
    // 这里只翻这两个状态，**不碰按钮文字**：切到「收起导出」会让同一个控件的可访问名变来变去,
    // 而且用 textContent 整体重写会把箭头那个 span 一起删掉。箭头朝向交给 CSS 按 aria-expanded 转。
    const exportGroup = document.querySelector('.export-group');
    const exportMoreBtn = document.getElementById('exportMoreBtn');
    const exportMore = document.getElementById('export-more');
    if (exportGroup && exportMoreBtn && exportMore) {
        const setExportMore = function(open) {
            exportMore.hidden = !open;
            exportMoreBtn.setAttribute('aria-expanded', String(open));
        };

        exportMoreBtn.addEventListener('click', function() {
            setExportMore(exportMore.hidden);
        });

        // Escape 收起。监听挂在 .export-group 上而不是 document：keydown 只会从组内有焦点的
        // 子元素冒泡上来，「焦点在组内」这条前提是白拿的，所以结构上不可能抢走别处（星系弹窗）
        // 的同一个 Escape。收起必须显式把焦点还给切换钮——面板里的按钮会跟着一起 hidden，
        // 浏览器接着把焦点丢给 <body>，键盘用户当场丢位置。
        // 不写 preventDefault / stopPropagation：Escape 在这条路径上没有浏览器默认行为，
        // 拦下来只会让别的监听者收不到。
        exportGroup.addEventListener('keydown', function(e) {
            if (e.key !== 'Escape' || exportMore.hidden) return;
            setExportMore(false);
            exportMoreBtn.focus();
        });
    }

    // 新增：图表类型切换监听
    document.getElementById('chartTypeSelect').addEventListener('change', function(e) {
        chartType = e.target.value;
        updateChartTypeUI();
        if (realData) {
            initChart();
        }
        syncUrlState();
    });

    // 上传自定义文本
    const fileInput = document.getElementById('file-upload');
    if (fileInput) fileInput.addEventListener('change', handleFileUpload);
}

// tablist 键盘操作：← → 切换视图，Home / End 跳到首尾（WAI-ARIA tabs 的惯例）
function initTabKeyboard() {
    const tabs = Array.from(document.querySelectorAll('.tab-btn'));
    if (tabs.length === 0) return;

    tabs.forEach((tab, index) => {
        tab.addEventListener('keydown', (event) => {
            let next = null;
            if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
            else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
            else if (event.key === 'Home') next = tabs[0];
            else if (event.key === 'End') next = tabs[tabs.length - 1];
            if (!next) return;

            event.preventDefault();
            const viewId = next.getAttribute('aria-controls');
            if (viewId) window.switchTab(viewId);
            // 不让 focus 参与滚动：focus() 默认会把元素滚进视口，而页签条是吸顶的、
            // 本来就在视口里，可它会在平滑滚动还在途中时把页面拽回去，两个偏移打架。
            // 滚动只归 switchTab 里的 scrollToSection 管。
            next.focus({ preventScroll: true });
        });
    });
}

// 挑出当前观察角度下「差别最明显的一对」：均值最小与最大的两本书。
//
// 候选优先只用内置示例书——与 getMetricContextLine 的参照基准同一条原则：
// 用户自己上传的书不该被拿来当基准。内置书不够两本，才退回全部已加载的书。
// 抽成函数是因为有两处要用：下面的「载入对比示例」按钮，以及首屏的默认选中。
function pickMostDifferentPair() {
    const candidates = (builtinBookNames.length > 0 ? builtinBookNames : Object.keys(realData || {}))
        .filter(name => getMetricValues(name, currentMetric).length > 0);
    if (candidates.length === 0) return [];
    if (candidates.length === 1) return [candidates[0]];

    const ranked = candidates
        .map(name => ({ name, mean: d3.mean(getMetricValues(name, currentMetric).map(d => d.value)) }))
        .filter(item => isFiniteNumber(item.mean))
        .sort((a, b) => a.mean - b.mean);
    return ranked.length > 1 ? [ranked[0].name, ranked[ranked.length - 1].name] : candidates.slice(0, 2);
}

// 当前选中的，是不是「工具替你挑的那一对」（首屏默认，或点过「载入对比示例」）。
// 默认选书是替读者做了一次主：挑的是当前指标下差别最大的两本，而不是随便两本。
// 这件事原来只在加载时弹一句提示，滚过去就没了——而它会跟着「复制结论」「导出摘要」
// 一起离开这个页面，读的人（导师、同门）看不到那句提示（第四十批）。
function isAutoPickedPair() {
    if (!selectedBooks || selectedBooks.size !== 2) return false;
    const picks = pickMostDifferentPair();
    if (picks.length !== 2) return false;
    return picks.every(name => selectedBooks.has(name));
}

// 「整体」这类数字的口径提醒（第四十批）。它回答读者拿到一个平均数后一定会问的问题：
// 这个平均数背后有没有起伏、这些数能不能当样本用。
// 片段是重叠滑窗切出来的（默认相邻重叠 9000 词），把它们当成互相独立的样本会高估样本量，
// 在近重复的序列上算出来的「标准差」也就不是它字面上给人的那个意思。
//
// 第四十三批删掉了结尾那半句「本工具不做显著性判断」。同一块面板下方「值得一看的片段」
// 的脚注（ANOMALY_GLOBAL_NOTE）就紧跟着说同一件事，导出摘要里两节也挨着——同一屏里
// 同一句提醒说两遍。留下的是「片段之间有重叠、不是独立样本、只适合描述和定位」这层事实，
// 它才是「别拿去做检验」的**理由**；结论那半句由下面那处说。两处共用同一个判据，
// 不存在「删了这句就没人说」的缺口（导出物里还有方法说明那一段兜底）。
function buildAveragingNote(books) {
    const metas = (books || []).map(name => normalizeBookMeta(name)).filter(Boolean);
    if (metas.length === 0) return '';
    const overlaps = Array.from(new Set(metas.map(m => m.overlap).filter(isFiniteNumber)));
    const overlapText = overlaps.length === 1 && overlaps[0] > 0
        ? `相邻片段之间重叠约 ${overlaps[0]} 词`
        : '相邻片段之间有大段重叠';
    return `这里的「整体」是各片段数值的平均数，${overlapText}、彼此并不是独立的样本；`
        + '所以这些数只适合用来描述和定位片段。';
}

// 三个标量指标能不能跨书比（第四十批）。原来的可比较性说明只讲了功能词投影，
// 对平均句长 / 用词重复度 / 独特词丰富度一个字都没有，读者只能自己猜。
// 判据是实测的：四本内置书的每一个片段都正好是 blockSize 词，三个标量因此是在
// 等长样本上算出来的。块长不一致时不能这么说，退回到不承诺。
function buildScalarComparabilityNote(books) {
    const metas = (books || []).map(name => normalizeBookMeta(name)).filter(Boolean);
    if (metas.length < 2) return '';
    const sizes = Array.from(new Set(metas.map(m => m.blockSize).filter(isFiniteNumber)));
    if (sizes.length !== 1) {
        return '这几本书的片段长度不一致，平均句长、用词重复度、独特词丰富度不宜直接跨书比较，请以走势图和原文为准。';
    }
    return `平均句长、用词重复度、独特词丰富度都是在同样长度的片段（每段 ${sizes[0]} 词）上算出来的，`
        + '所以这三个数可以跨书直接比较；独特词丰富度随篇幅变化很小（公式里篇幅取的是对数），字数相差不大时也可比。';
}

// 「载入对比示例」：挑出在当前观察角度下差别最大的两本内置书
// （帮第一次来的用户一键看到「对比」长什么样，而不是自己盲选）
function loadComparisonExample() {
    if (!realData) {
        setUploadStatus('数据仍在加载中，请稍候重试。', 'error');
        return;
    }

    const picks = pickMostDifferentPair();
    if (picks.length === 0) {
        setUploadStatus('暂时没有可用来做示例的书。', 'error');
        return;
    }

    selectedBooks = new Set(picks);
    syncBookButtonStates();
    updateMetricHint(); // 指标提示里那句「你选中的 N 本」要跟着选中数走，否则会停在初始的「1 本」
    resetDetailPanelIfStale('换过书');
    syncUrlState();
    renderQuickPreviewIfIdle(); // 面板里那块内容也要跟着换的书重算
    // 这个按钮的承诺是「看看这个工具能做什么」，而结论（一句话解读、值得一看的片段）
    // 都长在「全书对比」页上。原地点完之后用户还站在基础图表页，看到的还是同一张热力图，
    // 等于什么都没发生——所以直接把页签切过去（switchTab 自己会重画目标页，不必先白画一遍当前页）。
    window.switchTab('view-dashboard');
    setUploadStatus(
        `已选中《${picks.map(getBookDisplayName).join('》《')}》：它们的「${getMetricLabel(currentMetric)}」差异最大，适合先看差别。更换「观察角度」可另选一组。`,
        'success'
    );
    // 上面那句写在上传区里，而这时候页面已经滚到「全书对比」页、上传区在屏幕外。
    announceOrNotice('已切到「全书对比」页，这一页的几条结论是自动生成的。');
}

// 快速开始条：点 ✕ 收起，之后不再自动出现（记在本机浏览器里）
const QUICKSTART_HIDDEN_KEY = 'wenxin.quickstartHidden';

function applyQuickStartVisibility() {
    const el = document.getElementById('quickstart');
    if (!el) return;
    let hidden = false;
    try {
        hidden = window.localStorage.getItem(QUICKSTART_HIDDEN_KEY) === '1';
    } catch (e) {
        hidden = false;
    }
    el.hidden = hidden;
    setDemoEntryVisible(hidden);
}

// 「载入对比示例」的常驻入口长在「基础趋势分析」页的标题行里，和快速开始条互斥：
// 条子在的时候它多余，条子被 ✕ 收起之后它接班。
// 没有这一条，✕ 就等于把这个功能整个从界面上删掉了——它记在本机，换页面、换天也不会回来。
function setDemoEntryVisible(visible) {
    const entry = document.getElementById('demo-entry');
    if (entry) entry.hidden = !visible;
}

window.hideQuickStart = function() {
    const el = document.getElementById('quickstart');
    if (el) el.hidden = true;
    setDemoEntryVisible(true);
    try {
        window.localStorage.setItem(QUICKSTART_HIDDEN_KEY, '1');
    } catch (e) { /* 存不了就这次会话内收起 */ }
};

window.loadComparisonExample = loadComparisonExample;

// 根据当前图表类型控制「曲线平滑」的显隐：热力图是像素块，没有曲线可平滑。
//
// 「多书对比」那行提示曾经也一并藏起来，理由是「热力图不支持多书对比」——那是错的：
// drawMultiHeatmap 本来就按 booksArray 循环，每本书各占一列（列数 ceil(sqrt(n))，
// 可用宽度按书数均分），选 3 本会并排画出三张网格。也就是说那句「可多选对比」的提示
// 在热力图下同样为真，跟着藏起来等于把一句真话收走了。
// 它本身只是个 <div> 提示语（没有点击处理器），显不显示都不影响图表行为。
function updateChartTypeUI() {
    const smoothnessGroup = document.getElementById('smoothnessGroup');

    if (smoothnessGroup) {
        smoothnessGroup.style.display = chartType === 'heatmap' ? 'none' : 'flex';
    }

    // 热力图色标是相对刻度（取当前选中这几本书的最小值~最大值），必须说明；
    // 折线图的纵轴自带数字，这句反而会误导，所以只在热力图下显示。
    const scaleNote = document.getElementById('heatmap-scale-note');
    if (scaleNote) scaleNote.hidden = chartType !== 'heatmap';
}

// 上传自定义文本并即时分析
async function handleFileUpload(event) {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;

    // 后缀闸门与后端同一条（api_server.py 的 analyze_upload）。放在这里只是为了不白跑一趟网络。
    // 提示必须说「怎么办」：用户手上多半就是一份 Word 文档，只说「仅支持 .txt」等于把人堵死。
    // 编码不在这里判——后端现在会自己认 GBK/ANSI（见 src/data_loader.py 的 decode_upload），
    // 再让用户「另存为 UTF-8」就是让他做一件没必要做的事。
    if (!file.name.toLowerCase().endsWith('.txt')) {
        setUploadStatus('只支持纯文本文件（.txt）。Word 文档请先在 Word 里'
            + '「文件 → 另存为 → 纯文本 (*.txt)」再上传；'
            + '如果它本来就是纯文本，把文件名后缀改成 .txt 也能上传。', 'error');
        input.value = '';
        return;
    }

    // 这次上传会不会把书架上同名的那本整份换掉？会就先问一句再上传。
    // 判据见 isOverwriteCandidate：只在「勾了保存」且书名真的已在书架上时才问，
    // 所以绝大多数上传（新书、没勾保存）一个字都不会多。
    if (isOverwriteCandidate(file.name)) {
        openOverwriteModal(file);
        return; // 等用户在弹窗里点「替换」；那时才调 proceedUpload
    }

    return proceedUpload(file);
}

// 真正把文件发出去分析。
// 从 handleFileUpload 里拆出来，是因为「同名覆盖」那条路要先去问一句、用户点了
// 「替换」才走到这里——两条路共用同一段流程，以后改上传逻辑不会只改到其中一条。
async function proceedUpload(file) {
    const input = document.getElementById('file-upload');
    setUploadBusy(true);
    setUploadStatus(`正在分析「${file.name}」（长文本可能需要一些时间），请勿关闭页面…`, 'loading');
    startUploadTicker();

    const formData = new FormData();
    formData.append('file', file);
    if (isUploadSaveWanted()) formData.append('save', '1');

    try {
        const resp = await fetch(`${API_BASE_URL}/api/analyze`, { method: 'POST', body: formData });
        const contentType = resp.headers.get('content-type') || '';
        const result = contentType.includes('application/json') ? await resp.json() : null;

        if (!resp.ok || !result || result.status !== 'success') {
            setUploadStatus(getErrorMessage(resp, result), 'error');
            return;
        }

        if (!realData) realData = {};
        realData[result.book] = result.data; // 一律以服务端返回的 result.book 作为键
        // 同名重传后，缓存里的旧摘录必须作废，否则「复制更长的摘录」会给出上一版正文
        _excerptCache.clear();
        selectedBooks.add(result.book);
        // 保存下来的书要记住服务端发的删除令牌，之后删它时才认得出是「保存这本书的浏览器」
        if (result.saved && result.deleteToken) rememberDeleteToken(result.book, result.deleteToken);
        // 同名覆盖的判据要用最新的书架名单：刚存进去的这本书，下次再传同名文件就该触发确认。
        // 不更新的话，第二次上传会静默覆盖（名单还停在页面加载时那一份）——正是本批要挡的事。
        if (result.saved) libraryBookNames.add(result.book);
        addUploadedBookButton(result.book, { deletable: !!result.saved });
        updateCompareButtonLabel();
        syncUrlState();
        const nBlocks = result.data && result.data.metadata ? result.data.metadata.totalBlocks : 0;
        const savedMsg = result.saved
            // 「只有这个浏览器能看到」必须说出来：书架是按浏览器里的一枚编号分开放的，
            // 不说的话，用户会以为别人也能看到、或者以为自己换个设备还找得回来。
            ? '已存入「我的图书馆」（只有这个浏览器能看到），刷新后仍在，可点书名旁 ✕ 删除。'
            : (result.warning ? '' : '本次未勾选保存，刷新后不会保留。');
        // 书名跟用户以为的不一致时，必须说出来。三种情况，后果完全不同：
        //   1) renamedFrom   —— 撞了内置示例书，存成了《X（我的）》，谁都没被覆盖；
        //   2) replacedExisting —— 同名旧书被这次的结果整份替换掉了，上一版没了；
        //   3) shadowsExisting  —— 这次没保存，但书名和书库里那本重名：屏幕上看到的是
        //                          新的，书库里留着的还是旧的，两个「同一本」不同内容。
        const newName = `《${getBookDisplayName(result.book)}》`;
        const notes = [];
        if (result.renamedFrom) {
            const oldName = `《${getBookDisplayName(result.renamedFrom)}》`;
            notes.push(result.saved
                ? `${oldName}是内置示例书的书名，这次存为${newName}，示例书不受影响。`
                : `${oldName}是内置示例书的书名，这次的分析以${newName}显示。`);
        }
        if (result.replacedExisting) {
            notes.push(`你书架上同名的${newName}已被这次的结果整份替换，上一版分析不再保留。`);
        } else if (result.shadowsExisting) {
            notes.push(`书名和你已保存的${newName}重名：屏幕上显示的是这次的分析结果，`
                + '书架里存着的仍是上次保存的那一份（这次未勾选保存）。');
        }
        // 「刷新后不会保留」只说了一半：没保存的上传还留在内存里，图能照画、原文摘录也取得到，
        // 用户于是以为一切正常。真正做不到的是**要回头问服务器**的那一步——「全书对比」里的
        // 异常片段分析走 /api/analysis，读的是服务器上那份语料，不含没落盘的上传。
        // 不说这句，用户会在切到那一页、看到红字时才第一次知道，而那时只能重传一遍。
        if (!result.saved && !result.warning) {
            notes.push('「全书对比」里的异常片段分析要回头问服务器，这一步算不了没保存的上传，'
                + '切到那一页会显示取不到；本页的图和原文摘录不受影响。');
        }
        if (result.warning) notes.push(result.warning);
        setUploadStatus(
            `「${getBookDisplayName(result.book)}」分析完成，共划分 ${nBlocks} 个片段。${savedMsg}${notes.join('')}`,
            result.warning ? 'error' : 'success'
        );
        updateMetricHint();
        refreshAllActiveCharts();
        renderQuickPreviewIfIdle(); // 新书进来后，面板空闲时也该有内容可点
    } catch (e) {
        console.error('上传分析失败:', e);
        // 同 :1399——「请确认服务器已启动」是给部署者的话（第三十五批）。
        setUploadStatus('上传失败：暂时无法连接到分析服务，请检查网络后稍后重试。', 'error');
    } finally {
        stopUploadTicker();
        setUploadBusy(false);
        if (input) input.value = ''; // 允许重复上传同一文件
    }
}

// ---------------------------------------------------------------------------
// 「同名会整份替换」的事前确认（第二十五批）
//
// 服务端对「书架上已有同名书」是沿用同名、原地替换（见 _resolve_final_name），
// 旧的分析就此消失。改好文稿重传恰好是最常见的用法，所以不能一律拒绝，
// 但也绝不能默默换掉。挡在上传之前问一次，是唯一还能保住旧数据的位置——
// 响应里那句 replacedExisting 是**事后**说的，那时旧的已经没了。
//
// 判据必须与服务端逐字一致：服务端的 base_name = Path(file.filename).stem，
// 也就是剥掉**末尾最后一个**扩展名（Python 的 stem：'a.b.txt' → 'a.b'），
// 再交给 sanitize_book_name（见 api_server.py）。所以这里用 replace(/\.txt$/i, '')
// 而不是 split('.')[0]——后者对「Tom.Sawyer.txt」算出来是 'Tom'，两边名字不一致，
// 弹窗就永远不出现。
//
// sanitizeBookName() 是那个 Python 函数的镜像。**只需要在「名字会被改动」时才准**：
//   1) Python 的 stem 只剥最后一个扩展名 —— 用正则而不是 split 就对了；
//   2) 非法字符 < > : " / \ | ? * 与控制字符 → '_' 并合并重复下划线；
//   3) 首尾的 '_' '.' 与空白去掉（注意只去首尾，中间的 '.' 保留）；
//   4) Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）加 '_' 前缀；
//   5) 截断到 200 字符。
// 两边万一漂移，最坏结果是「该问的没问」——静默退化成旧行为，但**不会更糟**：
// 服务端照旧在响应里带 replacedExisting，界面上那句事后说明还在。
// 所以这里是「多挡一层」，不是唯一一道门。
// ---------------------------------------------------------------------------
let libraryBookNames = new Set();   // 这个书架上的书名（来自 /api/books 的 source==='library'）
let pendingOverwriteFile = null;    // 等用户回答的那个文件

const _BOOK_NAME_FORBIDDEN_RE = /[<>:"/\\|?*\x00-\x1f\x7f]/g;
const _BOOK_NAME_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

function sanitizeBookName(raw) {
    let name = String(raw == null ? '' : raw);
    // 丢掉除普通空格以外的空白（对应 Python 的 ch.isspace()，但半角空格要留）
    name = name.replace(/[^\S ]/g, '');
    name = name.replace(_BOOK_NAME_FORBIDDEN_RE, '_').replace(/_+/g, '_');
    name = name.replace(/^[ _.]+/, '').replace(/[ _.]+$/, '');
    if (!name) return 'book';
    if (_BOOK_NAME_RESERVED_RE.test(name)) name = '_' + name;
    return name.slice(0, 200);
}

function rememberLibraryBooks(books) {
    libraryBookNames = new Set(
        (books || [])
            .filter(b => b && b.source === 'library' && b.name)
            .map(b => b.name)
    );
}

function isOverwriteCandidate(fileName) {
    // 没勾保存 = 不落盘 = 谁也不会被覆盖，不必打扰
    if (!isUploadSaveWanted()) return false;
    const stem = String(fileName || '').replace(/\.txt$/i, '');
    return libraryBookNames.has(sanitizeBookName(stem));
}

function openOverwriteModal(file) {
    const modal = document.getElementById('overwrite-modal');
    // 弹窗不在（旧页面缓存等）就照旧直接传：宁可退化成老行为，也不能把上传整个卡死
    if (!modal) { proceedUpload(file); return; }

    pendingOverwriteFile = file;
    const name = getBookDisplayName(String(file.name || '').replace(/\.txt$/i, ''));
    const lead = document.getElementById('overwrite-modal-lead');
    if (lead) {
        lead.textContent = `「我的图书馆」里已经有一本《${name}》。`
            + '这次上传的文件名和它一样，而你又勾了「存入我的图书馆」，'
            + '所以保存时会用这次的结果整份替换掉那一本。';
    }

    modal.setAttribute('aria-hidden', 'false');
    modal.style.display = 'flex';
    document.addEventListener('keydown', trapOverwriteModalFocus);
    setTimeout(() => {
        modal.classList.add('show');
        // 焦点先落在「取消」上：破坏性动作不该一个回车就中
        const cancel = document.getElementById('overwrite-cancel');
        if (cancel) cancel.focus();
    }, 10);
}

function closeOverwriteModal({ returnFocus = true } = {}) {
    const modal = document.getElementById('overwrite-modal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', trapOverwriteModalFocus);
    setTimeout(() => {
        modal.style.display = 'none';
        if (!returnFocus) return;
        // 焦点还给上传按钮。它是 <label>，本身不可聚焦，要转给里面的 file input——
        // 直接对 label 调 focus() 会静默失败，焦点掉回页面开头。
        const label = document.getElementById('upload-btn');
        const target = label && label.querySelector('input') ? label.querySelector('input') : label;
        if (target && typeof target.focus === 'function') target.focus();
    }, 300);
}

function trapOverwriteModalFocus(event) {
    trapFocusWithin(document.getElementById('overwrite-modal'), event);
}

function confirmOverwriteUpload() {
    const file = pendingOverwriteFile;
    pendingOverwriteFile = null;
    closeOverwriteModal({ returnFocus: false }); // 接下来整条上传流程自己管焦点
    if (file) proceedUpload(file);
}

function cancelOverwriteUpload() {
    pendingOverwriteFile = null;
    closeOverwriteModal();
    // 清掉 input.value：不清的话，用户点了取消、再重新选同一个文件时不会触发 change，
    // 看上去就是「选了文件没反应」。
    const input = document.getElementById('file-upload');
    if (input) input.value = '';
    setUploadStatus('已取消这次上传，书架上那一本没有改动。', '');
}

// 生成一个「书名 chip」：来自「我的图书馆」的书带 ✕ 删除钮
// （删除钮 stopPropagation，避免误触发选书）
function buildBookGroup(book, { active = false, deletable = false, onClick } = {}) {
    const id = book.id;
    const wrap = document.createElement('span');
    wrap.className = 'book-group';
    wrap.dataset.bookId = id;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'book-btn' + (active ? ' active' : '');
    button.dataset.id = id;
    // 书名下面加一小行「作者 · 年份」（第四十六批）。这四本是**故意两两同作者**的，
    // 而整个界面原来一个作者名都没有——第一次打开的人看到的是四本互不相干的书，
    // 很可能随手挑两本比一比，恰好错过这个工具最值得做的那一类对比（同一作家不同时期）。
    // 只写进悬停提示不够：触屏没有悬停，第一眼也看不到，而这要解决的正是「第一眼看不出」。
    // 上传的书读不到可靠的作者与年份，不替用户编一个，所以只有内置书有这一行。
    const displayName = getBookDisplayName(book.name || id);
    const source = getBuiltinBookSource(book.name || id);
    button.textContent = displayName;
    if (source) {
        button.title = `《${displayName}》——${source.authorZh}，${source.year} 年首次出版`;
        const meta = document.createElement('span');
        meta.className = 'book-meta';
        meta.textContent = `${source.authorZh} · ${source.year}`;
        button.appendChild(meta);
    } else {
        button.title = book.name || id;
    }
    if (typeof onClick === 'function') button.addEventListener('click', onClick);
    wrap.appendChild(button);

    if (deletable || book.source === 'library') {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'book-del';
        del.title = '从「我的图书馆」删除这本书';
        del.setAttribute('aria-label', `删除「${getBookDisplayName(book.name || id)}」`);
        del.textContent = '✕';
        del.addEventListener('click', (event) => {
            event.stopPropagation();
            deleteLibraryBook(id);
        });
        wrap.appendChild(del);
    }
    return wrap;
}

// 将上传的书动态加入选择器，并保持选中态
function addUploadedBookButton(bookName, { deletable = false } = {}) {
    const selector = document.getElementById('bookSelector');
    if (!selector) return;
    const existing = getBookButtonById(bookName);
    if (existing) {
        // 此前是「未保存」瞬时 chip，这次真正落盘后需补上删除钮
        const wrap = existing.closest('.book-group');
        if (wrap && deletable && !wrap.querySelector('.book-del')) {
            wrap.replaceWith(buildBookGroup(
                { id: bookName, name: bookName },
                { active: true, deletable: true, onClick: () => selectBook(bookName) }
            ));
        }
        return;
    }

    selector.appendChild(buildBookGroup(
        { id: bookName, name: bookName },
        { active: true, deletable, onClick: () => selectBook(bookName) }
    ));
}

// 书库删除令牌：保存时服务端发一个，存在本浏览器里，删除时带回去。
// 这样在线上演示环境里，别人无法凭一个书名就删掉你的书（本机访问不需要令牌）。
//
// 第二十批起按书架编号分格存（{编号: {书名: 令牌}}）：认领过别人的编号之后，
// 两格书架上可能有同名的书而令牌不同，平铺存会拿错令牌（服务端 403，且无法自愈）。
// 旧数据是平铺的 {书名: 令牌}，拿到编号时就地搬进这一格（见 setShelfCode）。
const DELETE_TOKEN_KEY = 'wenxin.deleteTokens';

// 当前浏览器的书架编号，由 /api/books 的 shelfCode 现给（cookie 是 HttpOnly，
// JS 读不到）。接口没回来之前是空串。
let currentShelfCode = '';

function readDeleteTokens() {
    try {
        const raw = window.localStorage.getItem(DELETE_TOKEN_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {}; // 隐私模式等场景读不到，按没有令牌处理
    }
}

function writeDeleteTokens(tokens) {
    try {
        window.localStorage.setItem(DELETE_TOKEN_KEY, JSON.stringify(tokens));
    } catch (e) { /* 写不进去就算了：本机访问本来就不需要令牌 */ }
}

// 这一格书架的令牌桶；还没有桶（或还不知道编号）时返回 null，调用方按旧版平铺表兜底
function shelfTokenBucket(tokens) {
    if (!currentShelfCode) return null;
    const bucket = tokens[currentShelfCode];
    return bucket && typeof bucket === 'object' ? bucket : null;
}

// 记下编号，并把旧版平铺表搬进这一格。幂等：搬完顶层就只剩编号键了。
// 不搬的话，升级后老浏览器里那些书的 ✕ 会突然全变 403——令牌一直都在，
// 只是没人再找得到它。
function setShelfCode(code) {
    currentShelfCode = typeof code === 'string' ? code : '';
    if (!currentShelfCode) return;
    const tokens = readDeleteTokens();
    const legacyKeys = Object.keys(tokens).filter(k => typeof tokens[k] === 'string');
    if (legacyKeys.length === 0) return;
    const bucket = shelfTokenBucket(tokens) || {};
    legacyKeys.forEach(k => {
        bucket[k] = tokens[k];
        delete tokens[k];
    });
    tokens[currentShelfCode] = bucket;
    writeDeleteTokens(tokens);
}

function rememberDeleteToken(bookName, token) {
    if (!bookName || !token) return;
    const tokens = readDeleteTokens();
    if (!currentShelfCode) {
        tokens[bookName] = token; // 还不知道编号（接口失败等），按住旧版平铺表写
        writeDeleteTokens(tokens);
        return;
    }
    const bucket = shelfTokenBucket(tokens) || {};
    bucket[bookName] = token;
    tokens[currentShelfCode] = bucket;
    writeDeleteTokens(tokens);
}

function forgetDeleteToken(bookName) {
    const tokens = readDeleteTokens();
    const bucket = shelfTokenBucket(tokens);
    let changed = false;
    if (bucket && bookName in bucket) { delete bucket[bookName]; changed = true; }
    if (typeof tokens[bookName] === 'string') { delete tokens[bookName]; changed = true; }
    if (changed) writeDeleteTokens(tokens);
}

function getDeleteToken(bookName) {
    const tokens = readDeleteTokens();
    const bucket = shelfTokenBucket(tokens);
    if (bucket && bookName in bucket) return bucket[bookName] || '';
    const legacy = tokens[bookName]; // 旧版平铺表（还没搬过、或编号未知时）
    return typeof legacy === 'string' ? legacy : '';
}

// 认领书架成功后，把服务端交回的令牌一次写进那一格（整格替换，避免和旧桶混在一起）
function seedDeleteTokens(code, books) {
    if (!code || !Array.isArray(books)) return;
    const tokens = readDeleteTokens();
    const bucket = {};
    books.forEach(item => {
        if (item && item.name && item.deleteToken) bucket[item.name] = item.deleteToken;
    });
    tokens[code] = bucket;
    writeDeleteTokens(tokens);
}

// ---------------------------------------------------------------------------
// 「书架编号」弹窗：显示自己的编号（可复制）+ 在另一台设备上填另一枚编号切过去
//
// 编号是 HttpOnly cookie，页面本来读不到，靠 /api/books 的 shelfCode 现给。
// 切换成功之后要整页刷新：realData 是「合并」语义（loadRealData 不删旧键），
// 重跑一遍加载清不掉上一格书架的书。刷新前先把链接里的 books 参数摘掉，
// 否则会撞上「链接里的这 N 本书在这台服务器上找不到」那句假警报。
// ---------------------------------------------------------------------------
function openShelfModal() {
    const modal = document.getElementById('shelf-modal');
    if (!modal) return;
    const valueEl = document.getElementById('shelf-code-value');
    if (valueEl) valueEl.textContent = currentShelfCode || '（尚未获取，请刷新页面）';
    const status = document.getElementById('shelf-modal-status');
    if (status) {
        status.textContent = '';
        status.classList.remove('error');
    }
    const input = document.getElementById('shelf-code-input');
    if (input) input.value = '';

    modal.setAttribute('aria-hidden', 'false');
    modal.style.display = 'flex';
    document.addEventListener('keydown', trapShelfModalFocus);
    setTimeout(() => {
        modal.classList.add('show');
        const closeButton = modal.querySelector('.galaxy-modal-close');
        if (closeButton) closeButton.focus();
    }, 10);
}

function closeShelfModal() {
    const modal = document.getElementById('shelf-modal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', trapShelfModalFocus);
    setTimeout(() => {
        modal.style.display = 'none';
        const trigger = document.getElementById('shelf-code-btn');
        if (trigger) trigger.focus(); // 焦点还给打开它的那个按钮，不然键盘用户会掉到页面开头
    }, 300);
}

// 「切换到这个书架」：把编号交给服务端换发 cookie，回来后整页刷新
async function claimShelfCode() {
    const input = document.getElementById('shelf-code-input');
    const status = document.getElementById('shelf-modal-status');
    const btn = document.getElementById('shelf-code-claim');
    const code = ((input && input.value) || '').trim();
    if (!code) {
        if (status) {
            status.textContent = '请先输入另一台设备上的书架编号。';
            status.classList.add('error');
        }
        return;
    }
    if (btn) btn.disabled = true;
    try {
        const resp = await fetch(`${API_BASE_URL}/api/shelf/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shelf-Claim': '1' },
            body: JSON.stringify({ code }),
        });
        const contentType = resp.headers.get('content-type') || '';
        const result = contentType.includes('application/json') ? await resp.json() : null;
        if (!resp.ok || !result || result.status !== 'success') {
            if (status) {
                status.textContent = getErrorMessage(resp, result);
                status.classList.add('error');
            }
            return;
        }
        // 先落牌：令牌跟这一格走，刷新后 ✕ 才认得出你
        seedDeleteTokens(result.shelfCode, result.books);
        stripBooksFromUrl();
        if (status) {
            status.textContent = '已切换，正在重新加载…';
            status.classList.remove('error');
        }
        window.location.reload();
    } catch (e) {
        console.error('切换书架失败:', e);
        if (status) {
            status.textContent = '无法连接分析服务，请稍后重试。';
            status.classList.add('error');
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

// 摘掉链接里的 books 参数（其余参数照旧），供切书架后刷新用
function stripBooksFromUrl() {
    try {
        const params = new URLSearchParams(window.location.search);
        if (!params.has('books')) return;
        params.delete('books');
        const query = params.toString();
        window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
    } catch (e) { /* 改不了也照常刷新：最坏是刷新后多一句「链接里的书找不到」 */ }
}

// 正在删除中的书名。删除是一次网络往返，期间再点 ✕ 会重复发请求、重复弹确认，
// 而且第二次请求多半拿到 404 弹出「删除失败」，看起来像删除没成功。
// 用一个 Set 做闸门：在途时直接忽略后续点击，并把该 chip 的 ✕ 临时禁用做视觉提示。
const _deletingBooks = new Set();

// 从「我的图书馆」删除：确认 → DELETE 接口 → 同步内存/选择/按钮/图表
async function deleteLibraryBook(bookName) {
    if (_deletingBooks.has(bookName)) return;
    if (!window.confirm(`确定从「我的图书馆」删除《${getBookDisplayName(bookName)}》？此操作不可撤销。`)) return;

    _deletingBooks.add(bookName);
    setDeletingBookState(bookName, true);
    setUploadBusy(true);
    try {
        const headers = {};
        const token = getDeleteToken(bookName);
        if (token) headers['X-Delete-Token'] = token;
        const resp = await fetch(`${API_BASE_URL}/api/library/${encodeURIComponent(bookName)}`, { method: 'DELETE', headers });
        const contentType = resp.headers.get('content-type') || '';
        const result = contentType.includes('application/json') ? await resp.json() : null;
        if (!resp.ok) {
            setUploadStatus(getErrorMessage(resp, result), 'error');
            return;
        }

        if (realData) delete realData[bookName];
        selectedBooks.delete(bookName);
        forgetDeleteToken(bookName);
        // 书架名单同步删掉：删完再传同名文件就是「新增」，不该再弹覆盖确认
        libraryBookNames.delete(bookName);
        document.querySelectorAll('.book-group').forEach(group => {
            if (group.dataset.bookId === bookName) group.remove();
        });
        syncUrlState();

        setUploadStatus((result && result.message) || `已从「我的图书馆」删除《${getBookDisplayName(bookName)}》。`, 'success');
        updateMetricHint();

        const remaining = Object.keys(realData || {}).length;
        if (remaining === 0) {
            const selector = document.getElementById('bookSelector');
            if (selector) selector.innerHTML = '<p class="state-card empty">没有已加载的书籍了。上传一个 .txt 文本就能继续。</p>';
            showNoDataMessage();
            return;
        }
        if (selectedBooks.size === 0) {
            const firstBtn = document.querySelector('.book-btn');
            if (firstBtn) selectBook(firstBtn.dataset.id);
        } else {
            refreshAllActiveCharts();
        }
        // 删掉的如果是面板里正列着的那本书，那块内容必须跟着换（或换成打回态）
        renderQuickPreviewIfIdle();
    } catch (e) {
        console.error('删除书库书籍失败:', e);
        setUploadStatus('删除失败：无法连接当前分析服务。', 'error');
    } finally {
        _deletingBooks.delete(bookName);
        setDeletingBookState(bookName, false);
        setUploadBusy(false);
    }
}

// 删除在途时把该书的 ✕ 置灰并禁用，避免重复提交
function setDeletingBookState(bookName, deleting) {
    document.querySelectorAll('.book-group').forEach(group => {
        if (group.dataset.bookId !== bookName) return;
        const del = group.querySelector('.book-del');
        if (!del) return;
        del.disabled = deleting;
        del.classList.toggle('deleting', deleting);
        del.setAttribute('aria-busy', deleting ? 'true' : 'false');
    });
}

// 辅助函数：根据当前 Tab 刷新图表
function refreshAllActiveCharts() {
    if (currentTab === 'view-main') initChart();
    if (currentTab === 'view-galaxy') initStyleGalaxy();
    if (currentTab === 'view-dashboard' && window.initAdvancedData) window.initAdvancedData();
}

// 响应式：窗口尺寸变化时防抖重绘当前图表，保证手机横竖屏切换后图表尺寸正确
let resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (realData) refreshAllActiveCharts();
    }, 250);
});

// 加载书籍列表
async function loadBooksList() {
    // 这一句必须排在 fetch 前面。服务端 /api/books 里带着 _ensure_demo_data()，
    // 全新部署的第一次请求要现场生成示例数据（api_server.py 自己的注释：重算要跑 1~3 分钟），
    // 而这期间屏幕上原来一个字都没有——首屏看上去就是坏的。加载提示不能等第一个 await 回来。
    showLoading('正在加载书籍列表…');
    try {
        const response = await fetch(API_ENDPOINTS.books);
        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await response.json() : null;

        if (!response.ok || !data || data.status !== 'success') {
            const message = getErrorMessage(response, data);
            console.error('加载书籍列表失败:', message);
            showError(`无法加载书籍列表：${message}`);
            return;
        }

        // 先记下书架上有哪些书：上传前那个「同名会不会覆盖」的判据用的就是它。
        // 必须在 updateBookSelector 之前——book chip 建出来之后名单还是空的话，
        // 从列表点进去的那本会被当成「不在书架上」。
        rememberLibraryBooks(data.books);
        updateBookSelector(data.books);
        // 记下这个浏览器的书架编号（服务端现给，cookie 是 HttpOnly 读不到）。
        // 「书架编号」弹窗靠它显示，删除令牌的存放也按它分格。
        setShelfCode(data.shelfCode);
        if (!data.books || data.books.length === 0) {
            showNoDataMessage();
            return;
        }
        loadRealData(); // 打开页面即自动加载数据并出图
    } catch (error) {
        console.error('网络错误:', error);
        // 原话是「请确保已运行 python api_server.py」——那是写给部署者看的（第三十五批）。
        // 读者不知道 api_server.py 是什么，也不需要知道；技术细节丢在上一行的 console.error 里。
        showError('暂时无法连接到分析服务。请检查网络后稍后重试。');
    }
}

function updateBookSelector(books) {
    const selector = document.getElementById('bookSelector');
    if (!selector) return;
    if (!books || books.length === 0) {
        // 同上：data/raw 是服务器上的目录，用户在自己电脑上找不到它（第三十五批）。
        selector.innerHTML = '<p class="state-card empty">书架上还没有书。上传一个 .txt 文本就能开始分析。</p>';
        return;
    }

    selector.innerHTML = '';
    books.forEach(book => {
        selector.appendChild(buildBookGroup(book, {
            onClick: () => selectBook(book.id)
        }));
    });

    // 解读参照只用内置示例书：用户自己上传的书不该拿来当"基准"
    builtinBookNames = books.filter(book => book.source !== 'library').map(book => book.id);

    if (pendingUrlBooks && pendingUrlBooks.length > 0) {
        // 链接里指定了选书：按它还原（不存在的书名会在数据加载后自动剔除）
        pendingUrlBooks = null;
        syncBookButtonStates();
    }
    // 没有链接参数时不在这里选书：首屏默认选的是「差别最明显的两本」，而那要等
    // 数据到手才算得出来（见 loadRealData）。这里先如实空着——原来那句
    // selectBook(books[0].id) 选的是未排序 glob 出来的「第一本」，本来就没有
    // 确定含义，而且紧接着又会被数据到手后的默认值换掉，白画一遍图。
}

// 一次性的页面提示。故意挂在 body 直下：.container 有 backdrop-filter，会成为
// fixed 后代的包含块，挂进容器里 bottom:28px 会被当成「距容器底部 28px」——
// 容器的两千多像素高意味着提示落在屏幕外（详情弹窗踩的正是这个坑）。
// 默认 3.4 秒后自己淡出；重复调用只换文字、重置计时，不会叠出第二条。
// options.announce === false：同一个字符串如果已经由顶部状态条（role="status"）念过一遍，
//   这里就把自己从 live region 里摘出去，读屏不会连读两遍——条子本身照样看得见。
//   元素是复用的，所以两种状态都要显式写回去，不能只在创建时设一次。
// options.duration：错误那句话比「至少要留一本书」长得多，默认 3.4 秒读不完。
let selectionNoticeTimer = null;
function showSelectionNotice(text, options) {
    let el = document.getElementById('selection-notice');
    if (!el) {
        el = document.createElement('div');
        el.id = 'selection-notice';
        el.className = 'selection-notice';
        document.body.appendChild(el);
    }
    if (options && options.announce === false) {
        el.removeAttribute('role');
        el.removeAttribute('aria-live');
    } else {
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
    }
    el.textContent = text;
    el.classList.add('show');
    if (selectionNoticeTimer) clearTimeout(selectionNoticeTimer);
    selectionNoticeTimer = setTimeout(() => el.classList.remove('show'), (options && options.duration) || 3400);
}

// 「自动替用户做了什么，说一句」的统一出口（第四十二批）。
// 原来的写法一律走 showSelectionNotice——一条贴底、浮在内容上的瞬态层：实测压在热力图和
// 右侧数据详情上（pointer-events:none，挡眼不挡鼠标），3.4 秒自己消失；而它说的往往正是
// 「为什么要替你选这两本」这种需要看清的话。换成首选页内的顶部状态条（不遮挡、不是浮层、
// 6 秒后自己收起、本身就是 aria-live 区域）；只有状态条确实在屏幕外时（它长在页面最上面，
// 切页签之后可能已经滚上去），才退回贴底浮层，并且 announce:false——同一句话已经由状态条
// 那个 live region 念过，别让读屏连读两遍。错误提示（showError）早就是这个写法，
// 这里只是把同一套用到「自动切换 / 自动选书」说的话上。
function announceOrNotice(text, options) {
    setGlobalStatus('success', text);
    if (statusBarOffscreen()) {
        showSelectionNotice(text, Object.assign({ announce: false, duration: 7000 }, options || {}));
    }
}

function selectBook(bookId) {
    const btn = getBookButtonById(bookId);

    if (selectedBooks.has(bookId)) {
        if (selectedBooks.size <= 1) {
            // 至少要留一本书，否则三个页签都没有东西可画。原来这里直接静默返回，
            // 用户点了没反应、只能以为坏了；现在把原因说出来。
            showSelectionNotice('至少要保留一本书。如需换书，请先选中另一本，再取消这一本。');
            return;
        }
        selectedBooks.delete(bookId);
        if (btn) btn.classList.remove('active');
    } else {
        // 如果未选中，则添加
        selectedBooks.add(bookId);
        if (btn) btn.classList.add('active');
    }

    updateCompareButtonLabel();
    // 指标提示里有「你选中的 N 本在 X – X 之间」，选书一变就得跟着重算
    updateMetricHint();
    // 卡片里那个点可能刚被取消掉了（或者它所属的书已经不在这张图上）
    resetDetailPanelIfStale('换过书');

    // 刷新当前可见的图表
    if (realData) {
        refreshAllActiveCharts();
    }
    // 面板空闲时那块「先看这 3 段」是按书 + 指标算的，选书一变就得重算
    renderQuickPreviewIfIdle();
    syncUrlState();
}

// 对比状态提示文字（选书、按链接还原选书后都要更新）
function updateCompareButtonLabel() {
    const compareBtn = document.getElementById('toggleComparison');
    if (!compareBtn) return;
    if (selectedBooks.size > 1) {
        compareBtn.textContent = `📚 已选 ${selectedBooks.size} 本书进行对比`;
    } else {
        compareBtn.textContent = '⇄ 点击上方书名可多选进行对比';
    }
}

// 按 selectedBooks 同步书名按钮的选中态（链接还原、删除后使用）
function syncBookButtonStates() {
    document.querySelectorAll('.book-group').forEach(group => {
        const btn = group.querySelector('.book-btn');
        if (btn) btn.classList.toggle('active', selectedBooks.has(group.dataset.bookId));
    });
    updateCompareButtonLabel();
}

async function loadRealData() {
    try {
        showLoading('正在加载数据…');

        const response = await fetch(API_ENDPOINTS.fingerprintData);
        // 服务端把「这份语料是什么」压成一个指纹放在 ETag 头上，供缓存判断用；
        // 导出的摘要与数据表顺手带上它（第四十批），让导出物能说清自己算的是哪一份数据。
        // ETag 形如 `"abc123"` 或弱验证器 `W/"abc123"`，去掉包装只留指纹本身。
        const etag = response.headers.get('ETag') || '';
        const fingerprint = etag.replace(/^W\//, '').replace(/"/g, '').trim();
        corpusFingerprint = fingerprint || null;
        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await response.json() : null;
        if (!response.ok || !data || data.status !== 'success') {
            showError(`加载数据失败：${getErrorMessage(response, data)}`);
            return;
        }

        // 必须「合并」而不是整份替换：首次加载慢的时候（示例数据生成约 1–2 分钟，
        // 或线上冷启动），用户可能先传完一本书——上传写在 realData[book] 上，
        // 这里一替换就把它冲掉了，界面上表现为「刚传的书不见了」，还会误报
        // 「链接里的这本书找不到」。合并即可，后到的示例书照样进得来。
        // （loadRealData 全站只在页面初始化时调用一次，不存在需要清掉旧键的场景。）
        const incoming = data.data && typeof data.data === 'object' ? data.data : {};
        realData = Object.assign(realData || {}, incoming);
        const availableBooks = Object.keys(realData);
        if (availableBooks.length === 0) {
            showNoDataMessage();
            return;
        }
        // 顶部状态条照旧报一句成功（6 秒后自己收起）。以前这里还往右侧面板里写一张
        // 「成功」状态卡，一直挂到用户点某个格子为止；现在那块地方留给
        // renderQuickPreviewIfIdle 的「先看这 3 段」（见本函数末尾）。
        // 位置不能挪到下面：链接里点名的书丢了时，那句 notice 必须压过这句。
        setGlobalStatus('success', `成功加载 ${availableBooks.length} 本书籍的数据`);
        updateMetricHint(); // 参考区间跟随当前已加载书集合
        renderAxisWordHints(); // 轴词说明也跟随已加载的书（用户可能还没切到星系页）

        // 确保 selectedBooks 中的书在数据中存在
        const requestedBooks = Array.from(selectedBooks);
        selectedBooks = new Set(requestedBooks.filter(book => availableBooks.includes(book)));
        // 链接里点了名、但这台服务器上已经没有的书：必须说出来。
        // 原来只是悄悄换成第一本书，用户会以为自己看的还是同事分享的那几本。
        const droppedBooks = requestedBooks.filter(book => !availableBooks.includes(book));
        if (droppedBooks.length > 0) {
            setGlobalStatus('notice',
                `链接里的这 ${droppedBooks.length} 本书在这台服务器上找不到：${droppedBooks.map(getBookDisplayName).join('、')}`
                + '（可能已被删除，或这个链接来自另一台服务器）。下面显示的是现有的书。');
        }
        if (selectedBooks.size === 0) {
            // 首屏默认：差别最明显的两本内置书（第一次来的用户打开就能看到「对比」
            // 长什么样，而不是对着一张单书热力图猜这个工具能干什么）。
            // 只在这一次定：之后选书、换指标都跟着用户走，不再重挑。
            const picks = pickMostDifferentPair();
            if (picks.length > 0) {
                // 一次性把整个集合换上，不走两次 selectBook——那会白画两遍图。
                selectedBooks = new Set(picks);
                syncBookButtonStates();
                updateMetricHint(); // 上面那次算的是空集合，这里要跟着新的选中数重算
                syncUrlState();
                refreshAllActiveCharts();
                // 选中两本必须是「说明过的」：不说一句，用户打开就看到两张并排的图，
                // 不知道这两本是谁挑的、凭什么。只在自动挑书这一次说（带书籍链接进来、
                // 或者自己选过书之后都不会走到这个分支）。
                // 「更换**下方**选书即可」原来指错了方向（第四十六批）：这几句提示可能出现在
                // 任何一个页签上，而书选栏始终在页顶。改选书这件事本来也不需要方位词。
                announceOrNotice(
                    `已替你选中差异最大的两本：《${picks.map(getBookDisplayName).join('》《')}》——`
                    + `它们的「${getMetricLabel(currentMetric)}」差距最大。如需比较其他组合，改选其它书籍即可。`
                );
            } else {
                selectBook(availableBooks[0]); // 兜底：连一对都挑不出来时，照旧选第一本
            }
        } else {
            syncBookButtonStates(); // 链接还原 / 书籍变动后，把选中态落到按钮上
            refreshAllActiveCharts();
        }
        // 右侧面板不再只剩一句「成功加载 N 本书籍的数据」——首屏就给出能点进去看的内容
        renderQuickPreviewIfIdle();
    } catch (error) {
        console.error('加载数据失败:', error);
        // 原话让用户「检查分析服务是否运行」——他没有这个开关可拨（第三十五批）。
        showError('数据暂时加载不出来，请稍后重试。');
    }
}

// 图表的「一句话名字」——给读屏用户，不是给眼睛看的。（第三十一批）
//
// 读屏用户切到主视图，最先撞上的就是这张图。没有名字的话，他听到的是一个没有标签的
// 图形容器，然后掉进几十上百个没有上下文的片段元素里，不知道自己在哪、也不知道能做什么。
//
// 三件事是刻意这么定的：
//
// 1. **不在这里加 role="img"。** ARIA 规定 role="img" 的后代是 presentational，会被
//    整体抹出无障碍树——而这张图里每一个片段（热力图的格子、折线图的点、星系的圆）
//    都是 tabindex="0"、各自带 aria-label 的可聚焦元素。加上 role="img" 等于用
//    「听到一句概述」换「再也听不到任何一个片段」，是亏的。所以只挂名字，角色不动。
// 2. **名字里要说清怎么用键盘走。** 这张图对读屏用户唯一真正的用法是 Tab 逐个遍历片段、
//    回车打开详情；不说，他听完名字就只能卡在那里。
// 3. **每次重绘都要重设。** 名字里有书名、指标、片段数，图变了名字不变就是假话。
//    所以它由调用方在画完之后设，而不是写在 HTML 里当静态属性——那边写死一个
//    「白牙的风格走向」会一直在那儿，跟当前这张图没关系。
//
// 片段数按选中的这几本书算：内置四本长度一致，用户上传的书可能长短不一，不一致时
// 改成区间并写明，不假装它们一样长。
function describeChartForScreenReader({ kind, booksArray }) {
    const names = booksArray.map(b => getBookDisplayName(b));
    const booksText = names.length === 1
        ? `《${names[0]}》`
        : `《${names[0]}》等 ${names.length} 本书`;

    if (kind === 'galaxy') {
        // 原来只说「按高频小词用法排布」，读屏用户听到的是一团没有坐标的点——
        // 而这张图的三个编码（横轴、纵轴、圆点大小）一个都没交代。补上的是
        // 「这张图有什么量可以读」，与画面上轴题和尺寸图例的口径一致（第三十六批）。
        // 两个轴的占比取自和画面同一个来源，不是另写一份。
        const ratios = (getGalaxyComparability(booksArray).explainedVarianceRatio || [])
            .slice(0, 2).filter(isFiniteNumber);
        const axisText = ratios.length === 2
            ? `横轴是第 1 主成分（解释了约 ${Math.round(ratios[0] * 100)}% 的差异），`
              + `纵轴是第 2 主成分（约 ${Math.round(ratios[1] * 100)}%），原点在内置语料的平均水平；`
            : '';
        return `风格星系图：${booksText}的每个片段各画成一个圆点，按高频小词用法排布，`
             + axisText
             + `圆点越大表示「${getMetricLabel(currentMetric)}」越高，`
             + `每本书的点外面还圈着一块同色的浅色区域，就是这本书大致占据的范围，`
             + `靠得近说明用词习惯接近。`
             + `按 Tab 键可逐个片段查看，回车打开该片段的详情。`;
    }

    const counts = booksArray.map(b => getBookBlockCount(b)).filter(n => n > 0);
    let blockText = '';
    if (counts.length > 0) {
        blockText = counts.every(n => n === counts[0])
            ? `，共 ${counts[0]} 个片段`
            : `，各书片段数不同（${Math.min(...counts)} 到 ${Math.max(...counts)} 个片段）`;
    }

    const chartText = kind === 'heatmap'
        ? '指纹热力图：颜色越深数值越大，一行是一本书，横向按阅读顺序排开'
        : '折线趋势图：每本书一条曲线，横向是按阅读顺序排开的片段';

    return `${chartText}，${booksText}的${getMetricLabel(currentMetric)}${blockText}。`
         + `按 Tab 键可逐个片段查看，回车打开该片段的详情。`;
}

// 修改原 initChart，只在 Main Tab 激活时工作
function initChart() {
    // 如果不在主视图，不进行渲染，节省性能
    if (currentTab !== 'view-main') return;

    const svg = d3.select("#main-chart");
    svg.selectAll("*").remove();
    // 名字先撤掉：下面三条 return 路径都会留下一个画不出东西的空容器，
    // 顶着上一次的名称（「指纹热力图：白牙的……共 43 个片段」）比没有名字更糟。
    // 真画出来之后在末尾重新设上。
    svg.attr("aria-label", null);

    if (!realData || selectedBooks.size === 0) {
        showNoDataMessage();
        return;
    }

    const booksArray = Array.from(selectedBooks);

    // 确保 SVG 容器有宽度 (D3 在 display:none 时宽度为 0)
    const container = svg.node().parentNode;
    if (container.clientWidth === 0) return;

    if (chartType === 'heatmap') {
        drawMultiHeatmap(svg, booksArray);
    } else {
        drawMultiLineChart(svg, booksArray);
    }

    svg.attr("aria-label", describeChartForScreenReader({ kind: chartType, booksArray }));
}

function drawMultiLineChart(svg, booksArray) {
    const chartData = booksArray.map(bookId => ({
        book: bookId,
        values: getMetricValues(bookId, currentMetric)
    })).filter(d => d.values.length > 0);

    if (chartData.length === 0) { showNoDataMessage(); return; }

    const containerWidth = svg.node().parentNode.getBoundingClientRect().width;
    const margin = { top: 40, right: 120, bottom: 50, left: 60 };
    const width = containerWidth - margin.left - margin.right;
    // 绘图区高度固定 310（也就是原来写死的 400 减去上下留白），书多书少曲线形状一致。
    // 但画布本身要按右侧图例的行数撑高：图例一本一行、行距 25px 从 margin.top 往下堆，
    // 原先高度写死 400，超过 (400-40)/25 ≈ 14 本，后面的书就掉到 viewBox 外面——
    // 图上有那条线，图例里却找不到它叫什么。热力图早就按内容撑高了
    // （见 drawMultiHeatmap 的 totalHeight），折线图这里是漏的。
    // 只长画布、不长绘图区：否则书一多，同一条曲线会被拉得比书少时陡。
    const plotHeight = 400 - margin.top - margin.bottom;
    const legendRowHeight = 25;
    const height = Math.max(400, margin.top + chartData.length * legendRowHeight + margin.bottom);

    // 热力图会按书的数量把 svg 撑高（见 drawMultiHeatmap 的 style("height")），
    // 折线图必须把高度写回来：initChart 的 selectAll("*").remove() 只删子节点，
    // 清不掉 inline 高度。少了这一句，书少时（含默认的单本）折线图会缩在
    // 上一次热力图留下的高盒子里，导出 PNG 也跟着大半张空白。
    svg.attr("viewBox", `0 0 ${containerWidth} ${height}`)
       .style("height", height + "px");
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const maxBlocks = d3.max(chartData, d => d.values.length - 1);
    const allValues = chartData.flatMap(d => d.values.map(v => v.value));
    const extent = d3.extent(allValues);
    // 上下界用「加法 padding」，不能用乘法。乘法对负区间方向是反的：
    // 区间全负时 extent[0]*0.95 反而把下界往上抬、extent[1]*1.05 把上界往下压，
    // 可视窗口比数据本身还窄。「风格走向」是 PCA 有符号值，默认那本（哈克贝利·费恩，
    // 102 个片段）实测全负 -0.0597 ~ -0.0169，于是 12 个片段被画到 x 轴下方、
    // 最高的那个点跑到图标题区。注意符号是逐本不同的：另外三本都有正值，
    // 四本合起来是 -0.0597 ~ +0.0675，所以边界逻辑不能假设「一定全负」。
    // 改成按本跨度往两边撑，正区间负区间都是「往外」。
    const span = extent[1] - extent[0];
    const pad = (isFiniteNumber(span) && span > 0) ? span * 0.05 : 1;
    let yMin = extent[0] - pad;
    let yMax = extent[1] + pad;
    if (!isFiniteNumber(yMin) || !isFiniteNumber(yMax) || yMin === yMax) {
        const center = isFiniteNumber(extent[0]) ? extent[0] : 0;
        yMin = center - 1;
        yMax = center + 1;
    }

    const xScale = d3.scaleLinear().domain([0, maxBlocks]).range([0, width]);
    const yScale = d3.scaleLinear().domain([yMin, yMax]).range([plotHeight, 0]);

    // 取色统一走 colorForBook（按全库顺序，不按点选顺序），
    // 否则同一本书在这张图和「全书对比」页会是两个颜色

    g.append("g").attr("transform", `translate(0,${plotHeight})`).call(d3.axisBottom(xScale));
    g.append("g").call(d3.axisLeft(yScale));
    
    g.append("g").attr("class", "grid").call(d3.axisLeft(yScale).tickSize(-width).tickFormat("")).attr("stroke-opacity", 0.1);

    // 坐标轴标签：X 为「第几个片段」，Y 为当前指标中文名。
    // X 轴不能叫「阅读进度」：xScale 的 domain 是 [0, maxBlocks]，每本书按**自己的**
    // 片段序号（d3.line 里 .x((d, i) => xScale(i))）画，而各书片段总数差很多
    // （野性的呼唤 22 个、哈克贝利·费恩 102 个，4.6 倍）。同一个 x 在两本书里对应的
    // 阅读位置完全不同，第 50 个片段在 22 个片段的书里根本不存在——「阅读进度」会让人
    // 把两条线在同一 x 上直接对比，读出不存在的结论。说成百分比也是错的，因为这里
    // 没有做任何归一化。（看板页的走势图才是归一化到 0–100% 的，那里才叫阅读进度。）
    ["片段序号（每个片段约 1 万个单词）", "各书片段总数不同，同一个序号不代表相同的阅读位置"]
        .forEach((line, i) => {
            g.append("text")
                .attr("class", "axis-label")
                .attr("x", width / 2)
                .attr("y", plotHeight + 38 + i * 14)
                .attr("text-anchor", "middle")
                .text(line);
        });

    g.append("text")
        .attr("class", "axis-label")
        .attr("transform", "rotate(-90)")
        .attr("x", -plotHeight / 2)
        .attr("y", -46)
        .attr("text-anchor", "middle")
        .text(getMetricLabel(currentMetric));

    const line = d3.line()
        .x((d, i) => xScale(i))
        .y(d => yScale(d.value))
        .curve(d3.curveMonotoneX);

    chartData.forEach(bookData => {
        const smoothed = smoothData(bookData.values, smoothness);
        
        g.append("path")
            .datum(smoothed)
            .attr("fill", "none")
            .attr("stroke", colorForBook(bookData.book))
            .attr("stroke-width", 2.5)
            .attr("stroke-dasharray", dashForBook(bookData.book))
            .attr("d", line)
            .style("opacity", 0.8)
            .on("mouseover", function() { d3.select(this).attr("stroke-width", 5); })
            .on("mouseout", function() { d3.select(this).attr("stroke-width", 2.5); });
            
        const safeBookID = getBookSafeId(bookData.book);

        g.selectAll(`.point-${safeBookID}`)
            .data(bookData.values) 
            .enter()
            .append("circle")
            .attr("class", `data-point point-${safeBookID}`)
            .attr("cx", (d, i) => xScale(i))
            .attr("cy", d => yScale(d.value))
            .attr("r", 3) 
            .attr("fill", colorForBook(bookData.book))
            .attr("stroke", "#fdfaf3")
            .attr("stroke-width", 1.5)
            .attr("role", "button")
            .attr("aria-label", d => `${getBookDisplayName(bookData.book)} 第 ${d.block + 1} 个片段，${getMetricLabel(currentMetric)} ${formatMetric(d.value)}`)
            .style("cursor", "pointer")
            .style("opacity", 0) 
            .on("mouseover", function(event, d) {
                d3.select(this)
                    .style("opacity", 1)
                    .transition().duration(motionDuration(100))
                    .attr("r", 6)
                    .attr("stroke", "#b5472f")
                    .attr("stroke-width", 2);
                
                showTooltip(event, d, bookData.book);
            })
            .on("mouseout", function(event, d) {
                d3.select(this)
                    .transition().duration(motionDuration(200))
                    .attr("r", 3)
                    .attr("stroke", "#fdfaf3")
                    .attr("stroke-width", 1.5)
                    .style("opacity", 0); 
                
                hideTooltip();
            })
            .on("click", function(event, d) {
                event.stopPropagation();
                d3.selectAll(".data-point").attr("r", 3).style("opacity", 0);
                d3.select(this).style("opacity", 1).attr("r", 8).attr("stroke", "#b5472f");
                // 同热力图：触屏点一下会留下一个没有 mouseout 的提示框，点开详情时收掉
                hideTooltip();
                showDetail(d, bookData.book);
            })
            .on("keydown", function(event, d) {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    showDetail(d, bookData.book);
                    return;
                }
                // ← → 沿片段顺序移动焦点，Home / End 跳首尾。
                // 走法和热力图那套一致：进来只占一个 Tab 停靠点，之后用方向键逐点走。
                const all = g.selectAll(`.point-${safeBookID}`).nodes();
                const current = all.indexOf(this);
                let next = null;
                if (event.key === 'ArrowRight') next = current + 1;
                else if (event.key === 'ArrowLeft') next = current - 1;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = all.length - 1;
                if (next === null) return;
                event.preventDefault();
                if (next < 0 || next >= all.length) return;
                all.forEach(node => node.setAttribute('tabindex', '-1'));
                all[next].setAttribute('tabindex', '0');
                all[next].focus();
            });

        // 一本书上百个点，如果每个都能 Tab 到，键盘用户要按上百次才走得出去；
        // 所以整条折线只留一个 Tab 停靠点（第一个点），其余靠上面的方向键。
        g.selectAll(`.point-${safeBookID}`).attr("tabindex", (d, i) => (i === 0 ? 0 : -1));
    });

    // 触屏上没有「悬停」这一步：折线模式下数据点平时是全透明的（悬停才现出来），
    // 而相邻两点的间距实测只有 1.5px、点直径 5.7px——手指按下去既看不见点在哪，
    // 按偏了也没有任何反应，等于盲点。这里给触屏补一条容错通路：在绘图区铺一层
    // 透明接收层，按下去取离手指最近的那个点。只在触屏（pointer: coarse）下挂，
    // 桌面沿用原来的悬停 + 点击，行为一点不变。
    if (usesCoarsePointer()) {
        attachTouchPointPicker(g, chartData, xScale, yScale, width, plotHeight);
    }

    const legend = svg.append("g").attr("transform", `translate(${width + 20}, ${margin.top})`);
    chartData.forEach((d, i) => {
        const row = legend.append("g").attr("transform", `translate(0, ${i * legendRowHeight})`);
        // 图例里画的是**线**而不是色块：这是折线图的图例，把每本书的线型一并画出来，
        // 只靠颜色分不出来的读者才能把图上的线和这里的书名对上。色块形状留给
        // 热力图与星系那两处（它们的图元本来就不是线）。
        row.append("line")
            .attr("x1", 0).attr("x2", 16)
            .attr("y1", 7.5).attr("y2", 7.5)
            .attr("stroke", colorForBook(d.book))
            .attr("stroke-width", 2.5)
            .attr("stroke-dasharray", dashForBook(d.book));
        row.append("text").attr("x", 22).attr("y", 12).text(getBookDisplayName(d.book)).style("font-size", "12px").style("fill", "#5c5346");
    });
    
    svg.append("text")
        .attr("x", containerWidth / 2)
        .attr("y", 25)
        .attr("text-anchor", "middle")
        .style("font-size", "16px")
        .style("font-weight", "bold")
        .style("fill", "#2f2a23")
        .text(`${getMetricLabel(currentMetric)} - 对比分析`);
}

// 触屏专用：按一下 = 取离手指最近的那个数据点，容错半径按手指的接触面给
// （约 9mm ≈ 34px）。桌面不挂这一层——鼠标本来就能精确悬停，多盖一层反而会把
// 原来的悬停提示挡掉。
function attachTouchPointPicker(g, chartData, xScale, yScale, width, plotHeight) {
    const TOLERANCE = 34;
    g.append("rect")
        .attr("class", "touch-picker")
        .attr("x", 0)
        .attr("y", 0)
        .attr("width", width)
        .attr("height", plotHeight)
        .attr("fill", "none")
        .style("pointer-events", "all")
        .style("cursor", "pointer")
        .on("click", function (event) {
            const [px, py] = d3.pointer(event, g.node());
            let best = null;
            let bestD = Infinity;
            chartData.forEach(bookData => {
                bookData.values.forEach((value, i) => {
                    const dx = xScale(i) - px;
                    const dy = yScale(value.value) - py;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < bestD) { bestD = d2; best = { point: value, book: bookData.book }; }
                });
            });
            if (!best || bestD > TOLERANCE * TOLERANCE) return;
            // 和点本身的点击走同一套动作：其余点复位，点亮这一个，再打开它的详情
            d3.selectAll(".data-point").attr("r", 3).style("opacity", 0);
            g.selectAll(`.point-${getBookSafeId(best.book)}`)
                .filter(dd => dd === best.point)
                .style("opacity", 1)
                .attr("r", 6)
                .attr("stroke", "#b5472f");
            hideTooltip();
            showDetail(best.point, best.book);
        });
}

// 章节分界在热力图网格里的位置：格子按行铺开，分界线画在「该章起始所在那一格」的左边框上
// ——也就是「上一格是上一章、这一格是新的一章」的那条缝。
// 章节特别多时不再画，否则整张图会被虚线填满、反而看不清颜色。
function getChapterGridDividers(bookName, data) {
    const positions = getChapterBlockPositions(bookName);
    if (!positions || positions.length > 60) return [];

    // 正常情况下数组下标就是第几块；万一有片段缺值被过滤掉，按块号回查，避免画错行
    const positionOfBlock = new Map();
    data.forEach((item, index) => positionOfBlock.set(item.block, index));

    // 一个格子可能被相邻几章同时选中（格子覆盖 1 万个词，段落比格子密时就会出现），
    // 同一格只画一次，避免重复叠线。
    const seen = new Set();
    return positions
        .map(item => {
            const position = positionOfBlock.has(item.block) ? positionOfBlock.get(item.block) : item.block;
            return { chapter: item.chapterIndex + 1, position };
        })
        .filter(item => item.chapter > 1 && item.position > 0 && item.position < data.length)
        .filter(item => {
            if (seen.has(item.position)) return false;
            seen.add(item.position);
            return true;
        });
}

// 热力图色阶：蓝（低）— 米（中）— 红（高）。
// 只拉明暗、不动色相。原来两端是 #2c4a6e / #a0221a，相对亮度 0.066 / 0.087，
// 两端对比只有 1.18:1——深蓝块和深红块在红绿色盲眼里是同一档，分不出高低；
// 中段的 #f2e7cd 又和卡片底差 1.17:1，取值接近中位数的格子看着像「没有数据」。
// 现在两端拉到 3.19:1（ΔL 0.258），中段改用 --elev 的米色。
const HEATMAP_LOW = '#7f9dc4';
const HEATMAP_MID = '#ece0c3';
const HEATMAP_HIGH = '#8f1d16';
// 格子描边：中段米色与卡片底仍接近，靠描边把网格画出来。
// 2026-10-09 实测（第三十一批）：原来的 #cbb894 对卡片底 1.85:1、对中段 #ece0c3 只有
// 1.48:1——描边的职责就是把相邻格分开，这个比值下它自己就快看不见了，格子连成一片。
// 换成 #8f7a55：对卡片底 3.93:1、对中段 3.15:1、对纸底 3.36:1，三处都过 WCAG 1.4.11
// 给「图形对象与相邻颜色」定的 3:1 线。它本身是个偏灰的褐，在米色系里不抢眼，
// 只是把网格线从「若有若无」拉到「确实看得见」。格子的填色、色阶、数值映射一律未动。
const HEATMAP_STROKE = '#8f7a55';
// 图例两端「低 / 高」那两个字用的墨色。色阶本身要拉明暗，但文字得够黑才读得清
// （AA 正文 4.5:1）：浅蓝 #7f9dc4 当文字只有 2.66:1，所以文字仍用深色，
// 浅色只出现在它旁边那条渐变色条上。
const HEATMAP_LOW_INK = '#2c4a6e';
const HEATMAP_HIGH_INK = '#8f1d16';

function drawMultiHeatmap(svg, booksArray) {
    const chartData = booksArray.map(bookId => ({
        book: bookId,
        values: getMetricValues(bookId, currentMetric)
    })).filter(d => d.values.length > 0);

    if (chartData.length === 0) {
        showNoDataMessage();
        return;
    }

    const containerWidth = svg.node().parentNode.getBoundingClientRect().width;
    const padding = 20;
    const topMargin = 80;
    const bottomMargin = 68; // 图例底下还要留一行「虚线是章节分界」的说明

    const chartWidth = (containerWidth - 60 - (chartData.length - 1) * padding) / chartData.length;

    // 手机上常拿两三本书一起对比，并排时每本只分到三分之一宽度，格子会缩到 5–7px：
    // 深浅分不出来，手指也点不中；几本书的名字还挤在同一行的同一段位置上叠成一团，
    // 而画布高度是写死的 400，网格只占上面五十来像素，底下一大片空。
    // 所以窄屏上只要并排算下来最大的格子都不足 MIN_BLOCK，就换成「一本一行、上下排开」：
    // 一本书独占整幅图的宽度，格子回到 20px 以上，书名各占一行不再打架，画布高度也随
    // 书的本数自然长起来。
    // 另外钉一条宽度上限：宽屏（桌面）不论几本书都走并排——那些宽度上并排本来就看得清，
    // 不该因为「书多、格子小」就把桌面版式换成纵向排列，桌面一个像素不变。
    const STACK_MAX_WIDTH = 500; // 与 CSS 里 560px 那段断点覆盖的是同一批窄屏设备
    const MIN_BLOCK = 18;
    const blockOf = (count, width) => Math.max(1, Math.floor(width / Math.ceil(Math.sqrt(count))));
    const sideBySideBlock = Math.min(...chartData.map(bookData => blockOf(bookData.values.length, chartWidth)));
    const stackedLayout = containerWidth <= STACK_MAX_WIDTH
        && chartData.length > 1
        && sideBySideBlock < MIN_BLOCK;
    const bookWidth = stackedLayout ? containerWidth - 60 : chartWidth;
    const BOOK_ROW_GAP = 52; // 堆叠时两本书之间：留出下一本的书名（画在各自网格上方 20px）

    // 每本书的格子边长是各算各的（取决于它自己的 cols），所以画布高度必须按
    // 「每一本自己的 rows × blockSize」取最大值。旧写法拿第一本的 blockSize 去乘
    // 全局最大行数：只要后面某本书的格子比第一本大，它的网格就会伸进下边距，
    // 图例条和「虚线是章节分界」那行说明正好压在最后一排格子上。
    let maxGridHeight = 0;
    let stackedCursor = 0;

    // 每本书的左上角：并排时都在同一行，堆叠时依次往下排
    const bookTops = chartData.map(bookData => {
        const count = bookData.values.length;
        const cols = Math.ceil(Math.sqrt(count));
        const gridHeight = Math.ceil(count / cols) * blockOf(count, bookWidth);
        maxGridHeight = Math.max(maxGridHeight, gridHeight);
        if (!stackedLayout) return topMargin;
        const top = topMargin + stackedCursor;
        stackedCursor += gridHeight + BOOK_ROW_GAP;
        return top;
    });

    // stackedCursor 记的是「离 topMargin 还有多远」，不是绝对 y——少加这个 topMargin，
    // 画布就会比最后一本书的网格还矮，图例条正好压在最后一本书的最后几行格子上。
    const gridsBottom = stackedLayout
        ? topMargin + stackedCursor - BOOK_ROW_GAP // 最后一本底下不留空档
        : topMargin + maxGridHeight;
    const totalHeight = Math.max(400, gridsBottom + bottomMargin);

    svg.attr("viewBox", `0 0 ${containerWidth} ${totalHeight}`)
       .style("height", totalHeight + "px");

    const allVals = chartData.flatMap(bookData => bookData.values.map(d => d.value));
    const extent = d3.extent(allVals);
    let globalMin = extent[0];
    let globalMax = extent[1];
    if (!isFiniteNumber(globalMin) || !isFiniteNumber(globalMax)) {
        globalMin = 0;
        globalMax = 1;
    }
    if (globalMin === globalMax) {
        globalMin -= 1;
        globalMax += 1;
    }

    const colorScale = d3.scaleSequential()
        .interpolator(d3.piecewise(d3.interpolateRgb, [HEATMAP_LOW, HEATMAP_MID, HEATMAP_HIGH]))
        .domain([globalMin, globalMax]);

    let drewChapterDividers = false;

    chartData.forEach((bookData, index) => {
        const bookId = bookData.book;
        const data = bookData.values;

        const g = svg.append("g")
            .attr("transform", `translate(${stackedLayout ? 30 : 30 + index * (chartWidth + padding)}, ${bookTops[index]})`);

        const n = data.length;
        const cols = Math.ceil(Math.sqrt(n));
        const blockSize = Math.max(1, Math.floor(bookWidth / cols));

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
            .attr("role", "button")
            .attr("aria-label", d => `${getBookDisplayName(bookId)} 第 ${d.block + 1} 个片段，${getMetricLabel(currentMetric)} ${formatMetric(d.value)}`)
            .on("mouseover", function(event, d) {
                d3.select(this).style("stroke", "#b5472f").style("stroke-width", "2px");
                showTooltip(event, d, bookId);
            })
            .on("mouseout", function() {
                d3.select(this).style("stroke", HEATMAP_STROKE).style("stroke-width", "1px");
                hideTooltip();
            })
            // 点开详情的同时把提示框收掉：触屏上点一下会连带触发一次合成的 mouseover
            // （于是弹出提示框）却没有对应的 mouseout，那个框会一直挂在屏幕上不消失。
            .on("click", function(event, d) { hideTooltip(); showDetail(d, bookId); });

        // 键盘导航：整块热力图只占一个 Tab 停靠点，进来后用方向键逐格移动。
        // 一本书上百个格子如果都能 Tab 到，键盘用户要按上百次才能走出去。
        const rects = g.selectAll("rect");
        rects.attr("tabindex", (d, i) => (i === 0 ? 0 : -1));
        rects.on("keydown", function(event, d) {
            const all = rects.nodes();
            const current = all.indexOf(this);
            let next = null;
            if (event.key === 'ArrowRight') next = current + 1;
            else if (event.key === 'ArrowLeft') next = current - 1;
            else if (event.key === 'ArrowDown') next = current + cols;
            else if (event.key === 'ArrowUp') next = current - cols;
            else if (event.key === 'Home') next = current - (current % cols);
            else if (event.key === 'End') next = Math.min(n - 1, current - (current % cols) + cols - 1);
            else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                showDetail(d, bookId);
                return;
            }

            if (next === null) return;
            event.preventDefault();
            if (next < 0 || next >= n) return;
            all.forEach(node => node.setAttribute('tabindex', '-1'));
            all[next].setAttribute('tabindex', '0');
            all[next].focus();
        });

        // 章节分界：虚线，标出「颜色变化大概发生在第几章」
        const dividers = getChapterGridDividers(bookId, data);
        if (dividers.length > 0) {
            const rows = Math.ceil(n / cols);
            const dividerLayer = g.append("g").attr("class", "chapter-dividers");
            dividers.forEach(item => {
                const points = [];
                for (let row = 0; row < rows; row++) {
                    const local = item.position - row * cols; // 这一章起始的格子在当前行的第几列
                    // local === 0 是「这一章正好从某行第一格开始」：分界线要画在这一行的
                    // 最左边。以前写成 local <= 0，等于把这一行整个跳过，结果是这些
                    // 分界线一条都画不出来（实测被吞掉 13 条）。
                    if (local < 0 || local >= cols) continue;
                    const x = local * blockSize;
                    points.push([x, row * blockSize], [x, (row + 1) * blockSize]);
                }
                if (points.length === 0) return;
                dividerLayer.append("path")
                    .attr("d", "M" + points.map(point => point.join(",")).join(" L"))
                    .attr("fill", "none")
                    .attr("stroke", "#3a332a")
                    .attr("stroke-width", 1.2)
                    .attr("stroke-dasharray", "3,3")
                    .attr("opacity", 0.75)
                    .attr("pointer-events", "none");
                drewChapterDividers = true;
            });
        }

        // 书名能写多长，取决于这本书的网格有多宽：并排时按老规矩 18 字，堆叠时一本书
        // 独占整幅图，能多写几个字（写不下时截断，不会压到隔壁那本书的网格上）。
        const bookLabelMax = stackedLayout
            ? Math.max(18, Math.floor((cols * blockSize) / 15))
            : 18;

        g.append("text")
            .attr("x", (cols * blockSize) / 2)
            .attr("y", -20)
            .attr("text-anchor", "middle")
            .style("font-size", "14px")
            .style("font-weight", "bold")
            .style("fill", "#5c5346")
            .text(truncateText(getBookDisplayName(bookId), bookLabelMax));
    });

    // 标题以前是一行写死的：手机上这幅图比标题窄，两头会被画布直接裁掉（320px 上左右
    // 各裁掉约 48px，末尾「(统一色标: …」整段看不见）。这里先量宽度，放不下就拆成
    // 「指标名一行、色标范围一行」——桌面量出来放得下，仍然是一行，像素不变。
    const titleMain = `${getMetricLabel(currentMetric)} - 指纹对比`;
    const titleSub = `统一色标: ${formatMetric(globalMin)} ~ ${formatMetric(globalMax)}`;
    const titleText = `${titleMain} (${titleSub})`;
    const title = svg.append("text")
        .attr("x", containerWidth / 2)
        .attr("y", 30)
        .attr("text-anchor", "middle")
        .style("font-size", "18px")
        .style("font-weight", "bold")
        .style("fill", "#2f2a23")
        .text(titleText);

    // 量的是「按 18px 画出来」的宽度，所以必须先定字号再量
    if (title.node().getComputedTextLength() > containerWidth - 16) {
        title.attr("y", 20).style("font-size", "15px").text(titleMain);
        svg.append("text")
            .attr("x", containerWidth / 2)
            .attr("y", 38)
            .attr("text-anchor", "middle")
            .style("font-size", "13px")
            .style("fill", "#5c5346")
            .text(titleSub);
    }

    // 图例：低（黛蓝）↔ 高（赤），并标注当前指标的具体含义
    const [lowLabel, highLabel] = getHeatmapLegend(currentMetric);
    const legendH = 12;

    // 先把两端的标签建出来量宽度：色带宽度原来是写死的 220，两个标签又各贴着色带
    // 往外排 10px，于是在 320px 宽的屏幕上，左端渲染出来只剩「短句」——「低 · 」整个
    // 被裁在画布外，读者只看到色带的右端有「高」，左端是什么就没了对照；换成
    // 「独特词丰富度」这种四个字以上的指标，390px 的 iPhone 也一样中招。
    // 导出的 PNG 走的是同一个 viewBox，残缺的图例会一起被导出。
    const lowText = svg.append("text")
        .style("font-size", "12px")
        .style("fill", HEATMAP_LOW_INK)
        .style("font-weight", "bold")
        .text(`低 · ${lowLabel}`);
    const highText = svg.append("text")
        .style("font-size", "12px")
        .style("fill", HEATMAP_HIGH_INK)
        .style("font-weight", "bold")
        .text(`高 · ${highLabel}`);

    const LEGEND_GAP = 10;
    const LEGEND_SIDE = 8;
    const MIN_BAR = 60;
    const avail = containerWidth - LEGEND_SIDE * 2;
    const lowW = lowText.node().getComputedTextLength();
    const highW = highText.node().getComputedTextLength();
    // 色带至少留 MIN_BAR 才看得出渐变；连这个都放不下就把两个标签挪到色带下面一行，
    // 左对齐 + 右对齐分开写。宁可多占一行，也不能把「低」那一端裁掉。
    const stacked = lowW + highW + LEGEND_GAP * 4 + MIN_BAR > avail;

    let legendW, legendX, legendY, labelY;
    if (stacked) {
        legendW = Math.max(MIN_BAR, Math.min(220, avail - LEGEND_GAP * 2));
        legendX = (containerWidth - legendW) / 2;
        legendY = totalHeight - 58;
        labelY = legendY + legendH + 15;
        lowText.attr("x", LEGEND_SIDE).attr("y", labelY).attr("text-anchor", "start");
        highText.attr("x", containerWidth - LEGEND_SIDE).attr("y", labelY).attr("text-anchor", "end");
    } else {
        legendW = Math.max(MIN_BAR, Math.min(220, avail - lowW - highW - LEGEND_GAP * 4));
        legendX = (containerWidth - legendW) / 2;
        legendY = totalHeight - 46;
        labelY = legendY + legendH / 2 + 4;
        lowText.attr("x", legendX - LEGEND_GAP).attr("y", labelY).attr("text-anchor", "end");
        highText.attr("x", legendX + legendW + LEGEND_GAP).attr("y", labelY).attr("text-anchor", "start");
    }

    const legendGrad = svg.append("defs").append("linearGradient")
        .attr("id", "heatmapLegendGrad")
        .attr("x1", "0%").attr("x2", "100%");
    legendGrad.append("stop").attr("offset", "0%").attr("stop-color", HEATMAP_LOW);
    legendGrad.append("stop").attr("offset", "50%").attr("stop-color", HEATMAP_MID);
    legendGrad.append("stop").attr("offset", "100%").attr("stop-color", HEATMAP_HIGH);

    svg.append("rect")
        .attr("x", legendX).attr("y", legendY)
        .attr("width", legendW).attr("height", legendH)
        .attr("rx", 3)
        .attr("fill", "url(#heatmapLegendGrad)")
        .attr("stroke", HEATMAP_STROKE)
        .attr("stroke-width", 1);

    // 分界线是自动识别出来的，位置只能算近似，这里如实说明
    if (drewChapterDividers) {
        const chapterNote = svg.append("text")
            .attr("x", containerWidth / 2).attr("y", totalHeight - 14)
            .attr("text-anchor", "middle")
            .style("font-size", "11px")
            .style("fill", "#6b6254")
            .text("虚线为章节分界（按章节标题自动识别，位置为近似值；章节过多时不显示）");

        // 窄屏放不下就换短说法。宁可少解释一句，也不能让说明被画布裁掉半截——
        // 导出的 PNG 走的是同一个 viewBox，裁掉的部分会一起被导出。
        if (chapterNote.node().getComputedTextLength() > containerWidth - 16) {
            chapterNote.text("虚线为章节分界（自动识别，位置近似）");
        }
    }
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

// 提示框全程只建一个，反复复用。以前每次悬停都新建一个 div、量一次
// getBoundingClientRect——读几何量会强制同步布局（reflow）——hideTooltip 再把它删掉，
// 下一次又重新建。鼠标扫过折线或热力图时每秒几十次，这是最容易被漏掉的一处「用起来卡」。
// 元素留在 DOM 里不删：.tooltip 在 CSS 里已经是 pointer-events:none，
// 一个透明但仍存在的提示框不会挡住下面的图。
let tooltipEl = null;

function showTooltip(event, data, bookName) {
    if (!tooltipEl) {
        tooltipEl = d3.select("body").append("div")
            .attr("class", "tooltip")
            .style("opacity", 0)
            .style("left", "0px")
            .style("top", "0px");
    }
    const tooltip = tooltipEl;
    // 上一次的淡出可能还没走完（hideTooltip 现在不删节点）。先掐断它、把透明度拨回 0
    // 再重新淡入，否则新内容会从「正在淡出的那个中间值」接着往上走，闪一下。
    tooltip.interrupt().style("opacity", 0);

    const keywords = Array.isArray(data.keywords) ? data.keywords.map(escapeHtml).join(', ') : '';
    // 定位到章节：热力图上那条虚线到底指哪一章，悬停就能看到
    const chapter = typeof getBlockChapter === 'function' ? getBlockChapter(bookName, data.block) : null;
    tooltip.html(`
        <div style="margin-bottom: 5px;">
            <strong>${escapeHtml(getBookDisplayName(bookName))}</strong>
        </div>
        <div style="margin-bottom: 3px;">
            <strong>片段：</strong>第 ${Number(data.block) + 1} 个
        </div>
        ${chapter ? `<div style="margin-bottom: 3px;"><strong>位置：</strong>${escapeHtml(chapterLabel(chapter))}</div>` : ''}
        <div style="margin-bottom: 3px;">
            <strong>${escapeHtml(getMetricLabel(currentMetric))}:</strong> ${escapeHtml(formatMetric(data.value))}
        </div>
        ${keywords ? `<div style="margin-top: 5px;"><strong>关键词:</strong> <span lang="en">${keywords}</span></div>` : ''}
    `);

    // 定位：先按鼠标右下角摆，量出真实尺寸后按视口夹紧。
    // 旧写法只写 left: pageX+10，而绝对定位元素的宽度由「容器剩余宽度」决定——
    // 窄屏上靠近右缘的格子会把提示框挤成一根 70px 宽、327px 高的竖条（一次只显示
    // 一个字）。改用 fixed + clientX/clientY，既不受滚动影响，也能把框推回屏幕内。
    const box = tooltip.node().getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = event.clientX + 12;
    let top = event.clientY - 10;
    if (left + box.width > vw - 8) left = Math.max(8, vw - box.width - 8);
    if (top + box.height > vh - 8) top = Math.max(8, vh - box.height - 8);
    if (top < 8) top = 8;

    tooltip.style("position", "fixed")
        .style("left", left + "px")
        .style("top", top + "px")
        .transition()
        .duration(motionDuration(200))
        .style("opacity", 1);
}

function hideTooltip() {
    if (!tooltipEl) return;
    // 只淡出、不删节点——删了下次还得重建。CSS 里 .tooltip 是 pointer-events:none，
    // 所以留一个透明的提示框在页面上不会挡到任何交互。
    tooltipEl.interrupt()
        .transition()
        .duration(motionDuration(200))
        .style("opacity", 0);
}

// 右侧面板的「空闲内容」：第一本选中书里，当前指标最突出的 3 段。
//
// 这块地方原先在数据加载完之后只剩一句「成功加载 N 本书籍的数据」，一直挂到用户
// 点某个格子为止——首屏最贵的一块地只放了一句状态话。现在换成能直接点进去的内容：
// 点一行 = 点图上那个格子（同一个 showDetail，不新建第二条详情路径）。
//
// 只在面板「空闲」时渲染（没有 .block-location = 用户没有正在看某一段）：
// 用户点过格子之后，任何自动内容都不许盖掉它——点击永远优先。所以它是「调用一下、
// 自己判断」，而不是塞进 refreshAllActiveCharts（那条路径还被窗口 resize 与
// 「重置视图」调用，既没必要，还可能打断键盘操作）。
function renderQuickPreviewIfIdle() {
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel || !realData) return;
    if (detailPanel.querySelector('.block-location')) return; // 用户正在看某一段，不打扰

    // 只列「第一本选中书」：面板只有一列，两本并排列会变成一份没有人要的清单。
    // 选它自己的书（而不是硬取 availableBooks[0]）——用户换书后，这里跟着换。
    const book = Array.from(selectedBooks).find(name => getMetricValues(name, currentMetric).length > 0);
    const top = book
        ? getMetricValues(book, currentMetric).slice().sort((a, b) => b.value - a.value).slice(0, 3)
        : [];
    if (top.length === 0) {
        // 算不出内容时，面板上剩下的东西必须说得清「为什么没有」——不能留上一本书那 3 行
        // （点开会弹出一本已经删掉/换掉的书），更不能留着那张「正在加载」的卡：
        // loadRealData 先写它、末尾再调这里，这里一早退就没人回来关，它会一直转到刷新为止
        // （比如 URL 带了 ?metric= 而选中的书没有这个指标）。
        // 只收拾自己写过的两块（3 行清单 / 加载卡），用户点开的详情卡上面已经放行过了。
        if (detailPanel.querySelector('.state-card.loading') || detailPanel.querySelector('.quick-preview')) {
            showNoDataMessage('选中的书在当前「观察角度」下没有可展示的片段，请更换「观察角度」或另选一本书。');
        }
        return;
    }

    const loaded = Object.keys(realData).length;
    const selectedCount = selectedBooks.size;
    const rows = top.map(d => `
            <button type="button" class="quick-preview-row" data-block="${escapeHtml(String(d.block))}">
                <span class="qp-value">${escapeHtml(formatMetric(d.value))}</span>
                <span class="qp-loc">${escapeHtml(formatBlockLocation(book, d.block))}</span>
            </button>`).join('');

    detailPanel.innerHTML = `
        <h3>▤ 数据详情</h3>
        <p>已加载 ${loaded} 本书${selectedCount > 1 ? `，图上选中 ${selectedCount} 本` : ''}。
           先看《${escapeHtml(getBookDisplayName(book))}》里「${escapeHtml(getMetricLabel(currentMetric))}」最突出的 3 段
           （每一行是一个片段的数值，不是全书平均）：</p>
        <div class="quick-preview" data-book-id="${escapeHtml(book)}">
            ${rows}
        </div>
        <p class="excerpt-note">点击上面任意一行，等同于点击图中对应的位置。</p>
    `;
    detailPanel.querySelectorAll('.quick-preview-row').forEach((btn, i) => {
        btn.addEventListener('click', () => showDetail(top[i], book));
    });
}

function showDetail(data, bookName) {
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;

    const displayName = getBookDisplayName(bookName);
    const keywordsHtml = Array.isArray(data.keywords) && data.keywords.length > 0
        ? data.keywords.map(keyword => `<span class="keyword-tag" lang="en">${escapeHtml(keyword)}</span>`).join('')
        : '';
    const locationText = formatBlockLocation(bookName, data.block) + formatWordCount(data.wordCount);
    const chapter = getBlockChapter(bookName, data.block);
    // 这一行只补「章标题」（第四十四批）：章号（第 4 章（按标题自动识别））上一行的 📍 已经
    // 给了，同一次 getBlockChapter 查出来的必然是同一章——同一张卡片上并排写两遍。没有章标题
    // 时退回章号，因为这一行还有另一半信息（窗口正中间落在哪一章）得留着。
    const chapterHeading = chapter ? (chapterTitle(chapter) || chapterLabel(chapter)) : '';
    const chapterHtml = chapterHeading
        ? `<p class="chapter-location" title="${escapeHtml(CHAPTER_LABEL_HINT)}">🔖 所在章节：${escapeHtml(chapterHeading)}<span class="chapter-location-hint">（标的是窗口正中间落在的那一章）</span></p>`
        : '';
    const overviewText = formatBookOverview(bookName);
    const overviewHtml = overviewText
        ? `<p class="book-overview">全书概况：${escapeHtml(overviewText)}</p>`
        : '';
    // 引号里显示的和按钮复制到的是两段不同长度的文本（露 150 字、复制 1200 字）。
    // 这不是错，但不能不说：加一行小字说明复制到的是多长，按钮上也带字数。
    // 长摘录自第二十一批起不随页面下发（占首屏流量七成），按钮点下去时才现取那一段。
    const previewHtml = data.preview ? `
            <div>
                <h4>📄 原文片段</h4>
                <p lang="en" style="margin-top: 10px; color: #6b6254; font-style: italic;">
                    "${escapeHtml(data.preview)}"
                </p>
                <p class="excerpt-note">以上为片段开头的引文；复制得到的是更长的摘录，仍非全文（一个片段约 1 万词）。</p>
                ${excerptCopyButtonHtml(bookName, data.block, data.preview)}
            </div>` : '';

    detailPanel.innerHTML = `
        <h3>▤ 数据详情</h3>
        <!-- 这里原来还有一行「当前选择：书名 - 指标」（第四十四批删掉）：同一块面板里的
             「📖 书名」和数值下面那个「平均句长」各已经说了一遍，这一行说的是同一件事、
             连字都一样，而它就贴在旁边。删掉之后面板仍然是「书名 → 位置 → 数值 → 指标」。 -->
        <div class="detail-card">
            <h3>📖 ${escapeHtml(displayName)}</h3>
            <p class="block-location">📍 ${escapeHtml(locationText)}</p>
            ${chapterHtml}
            <div class="value">${escapeHtml(formatMetric(data.value))}</div>
            <p><strong>${escapeHtml(getMetricLabel(currentMetric))}</strong></p>
            ${overviewHtml}

            ${keywordsHtml ? `
            <div style="margin: 15px 0;">
                <h4>※ 关键词</h4>
                <div class="keywords">${keywordsHtml}</div>
            </div>` : ''}

            ${previewHtml}
        </div>
    `;
}

function getMetricLabel(metric) {
    const labels = {
        sentenceLength: '平均句长',
        simpsonIndex: '用词重复度',
        hapaxLegomena: '独特词丰富度',
        functionWords: '风格走向'
    };
    return labels[metric] || metric;
}

// 当前指标的大白话说明（面向非技术用户）
function updateMetricHint() {
    const el = document.getElementById('metric-hint');
    if (!el) return;
    const hints = {
        // 原句是「句子长，读起来更书面、更正式；句子短，更口语、更利落」（第四十批删）。
        // 「长句＝书面／正式」是一种常见的印象，不是这个工具量出来的东西——量出来的是词数，
        // 「正式」与否要另立一套语体判据；写在指标说明里等于借工具的口说了一句没根据的话。
        sentenceLength: '一句话平均包含几个词。句子长，一句话承载的信息更多，阅读速度较慢；句子短，读起来更简洁明快。长短本身不代表写得好坏，也不等同于文体的正式程度。',
        // 补上它与「独特词丰富度」的镜像关系（第四十批）：两个指标算的是同一件事的两面，
        // 读者常把它们当成两个独立证据，于是把同一件事数了两遍（两个指标不合并，只加这一句）。
        simpsonIndex: '衡量这本书是否反复使用同一批词。数值越高越重复（用词较为集中）；越低，用词越多样。它与「独特词丰富度」是同一件事的两面：一件事量了两次，一个高另一个就低，不宜当作两条独立的证据。',
        hapaxLegomena: '由「总词数、不同词的个数、只出现过一次的词数」综合算出。它通常不是 0–1 的比例，也不是百分比——数值越大，一般说明用词越丰富、越不单调。这个数对篇幅的依赖很弱（公式里篇幅取的是对数），字数相差不大的书可以直接比；字数差到好几倍时，仅篇幅本身就会把这个数抬高一些。',
        // 原句是「点越靠近只说明这些词的用法越像」——主语是「点」，谓语说的是「词的用法」，
        // 读起来像句子缺了半截（第三十八批）。补上主语与宾语：谁靠近、什么像、像到什么程度为止。
        // 「风格走向」这个名字从字面读不出量的是什么（第四十二批，小明A 卡在这里）：
        // 另三个指标名（平均句长 / 用词重复度 / 独特词丰富度）都能从字面猜到，只有这一个不能。
        // 不改名——名字出现在读数、图例、导出、示例文案好几处，改一次要同步的地方太多；
        // 改成在这里先把「它量的是什么」说清楚，再讲原来那句「靠得近 ≠ 整本书相似」。
        functionWords: `「风格走向」量的是这本书惯用哪一类高频小词${getAxisWordsHint()}，并将这种习惯表示为图上的一个方向——不看内容，只看措辞习惯。两个点越接近，只说明这两个片段的用词习惯越相似，不等于整本书本身相似。`
    };
    const ctxText = getMetricContextLine(currentMetric);
    el.innerHTML = `<span class="metric-hint-label">${escapeHtml(getMetricLabel(currentMetric))}：</span>${escapeHtml(hints[currentMetric] || '')}`;
    if (ctxText) {
        const line = document.createElement('div');
        line.className = 'metric-context';
        line.textContent = ctxText;
        el.appendChild(line);
    }
}

// ==========================================
// 📍 出处定位 / 复制片段（R2）
// ==========================================

function getBookBlockCount(bookName) {
    const bookData = realData && realData[bookName];
    if (!bookData) return 0;
    const n = bookData.metadata && Number(bookData.metadata.totalBlocks);
    if (isFiniteNumber(n) && n > 0) return n;
    for (const metric of ['sentenceLength', 'simpsonIndex', 'hapaxLegomena', 'functionWords']) {
        if (Array.isArray(bookData[metric]) && bookData[metric].length > 0) return bookData[metric].length;
    }
    return 0;
}

// 数据版本兼容：v1 数据没有真实总词数、滑窗参数和章节信息。
// 这里只在内存里补一份推算值，绝不改写磁盘上的旧文件；
// 也绝不把 v1 的 totalWords 当成真实词数（那是重叠窗口累加，比真实词数大近十倍）。
function normalizeBookMeta(bookName) {
    const bookData = realData && realData[bookName];
    const raw = bookData && bookData.metadata;
    if (!raw || typeof raw !== 'object') return null;

    // 判据写成「低于 2」而不是「不等于 2」：第二十四批为弯引号修复后重算的数据打了 v3，
    // 写成 !== 2 的话 v3 会被当成旧数据，四本内置书全都挂上「没有共同坐标基准」的警告。
    // v3 与 v2 的数据形状完全一样，只是数值按修好的清洗管线重算过。
    const legacy = !(Number(raw.schemaVersion) >= 2);
    const totalBlocks = getBookBlockCount(bookName);
    const step = isFiniteNumber(raw.step) && raw.step > 0 ? raw.step : 1000;
    const blockSize = isFiniteNumber(raw.blockSize) && raw.blockSize > 0 ? raw.blockSize : 10000;
    const analyzedWords = isFiniteNumber(raw.analyzedWords)
        ? raw.analyzedWords
        : (legacy && isFiniteNumber(raw.totalWords)
            ? raw.totalWords
            : (totalBlocks > 0 ? (totalBlocks - 1) * step + blockSize : null));

    return {
        legacy,
        totalBlocks,
        totalWords: legacy || !isFiniteNumber(raw.totalWords) ? null : raw.totalWords,
        analyzedWords,
        blockSize,
        step,
        // 相邻片段重叠词数：旧数据没写这个字段，按「窗口长 − 步长」推出来。
        // CSV 注释行要如实说明重叠，缺了它会印成「相邻重叠 undefined 词」。
        overlap: isFiniteNumber(raw.overlap) && raw.overlap >= 0
            ? raw.overlap
            : Math.max(0, blockSize - step),
        chapters: Array.isArray(raw.chapters) && raw.chapters.length > 0 ? raw.chapters : null,
        projection: raw.projection || null
    };
}

// 章节标签的口径（第四十批）。标签取的是「片段窗口正中间」落在哪一章，而一格横跨 4–6 章。
// 这带来一个不显眼但会误导人的后果：全书第 1 章永远标不到——实测 Tom Sawyer 35 章里
// 只有 31 章可达、Huckleberry Finn 43 章里只有 40 章可达，两本书的第 1 章都在可达集合之外，
// 导出的数据表第一行因此直接写着「第 2 章」。标签规则本身不改（改了会让所有词位置平移），
// 但口径必须说出来，否则读者会以为第 1 章没有片段。
const CHAPTER_LABEL_HINT = '标签取的是「片段窗口正中间」落在的那一章（一格约横跨 5 章）。所以相邻几格常标到同一章，全书第 1 章也可能一直不被标到。';

// 某一章：片段 i 覆盖第 [i*step, i*step+blockSize) 个词，
// 取片段中点所在的章（跨章片段不会被硬塞给上一章）。
function getBlockChapter(bookName, blockIndex) {
    const meta = normalizeBookMeta(bookName);
    if (!meta || !meta.chapters) return null;
    const idx = Number(blockIndex);
    if (!isFiniteNumber(idx) || idx < 0) return null;
    const center = idx * meta.step + meta.blockSize / 2;
    return meta.chapters.find(ch => center >= ch.wordStart && center < ch.wordEnd) || null;
}

// 章节分界落在第几块（可以带小数）：片段 i 的中点对应第 i*step + blockSize/2 个词，
// 反过来就能把章节标题的词位置换算成片段位置。
// 返回 null 表示这本书没有可用的章节信息。
//
// 一章从「中点落在这一章里的第一个片段」开始：片段 i 的中点在第
// i*step + blockSize/2 个词处，所以这一格就是 ceil((wordStart - blockSize/2) / step)。
// 取整方向不能用 Math.round——小数部分小于 0.5 时该片段的中点还在上一章里，
// 四舍五入会把分界线画到上一章的最后一格上（实测 91 条里有 47 条偏了一格）。
function chapterBlockOf(meta, chapter) {
    const raw = (chapter.wordStart - meta.blockSize / 2) / meta.step;
    return Number.isFinite(raw) ? Math.ceil(raw) : 0;
}

function getChapterBlockPositions(bookName) {
    const meta = normalizeBookMeta(bookName);
    if (!meta || !meta.chapters || meta.chapters.length < 2) return null;

    return meta.chapters.map((chapter, index) => ({
        chapterIndex: index,
        title: chapter.title,
        part: chapter.part || null,
        block: chapterBlockOf(meta, chapter)
    }));
}

// 滑窗在书末就停了：最后一个片段的中点 = (totalBlocks-1)*step + blockSize/2 个词，
// 起点在这之后的章一个片段都没有。这些章在走势图上没有刻度、在热力图里没有分界线，
// 是数据里真的没有，不是画错——所以要照实说，而不是假装章节都在图里。
function chaptersWithoutBlocks(bookName) {
    const meta = normalizeBookMeta(bookName);
    if (!meta || !meta.chapters) return [];
    const lastCenter = (meta.totalBlocks - 1) * meta.step + meta.blockSize / 2;
    return meta.chapters
        .map((chapter, index) => ({ index, wordStart: chapter.wordStart }))
        .filter(chapter => chapter.wordStart > lastCenter)
        .map(chapter => chapter.index + 1);
}

// 章号一律带口径说明：这是按章节标题自动识别出来的，不是人工标注的章号。
// 分「部」的小说（《白牙》每部从 CHAPTER I 重新编号）尤其需要——第 16 章的
// 原始标题确实写着 CHAPTER II，不加说明就成了自相矛盾的两句话。
function chapterLabel(chapter) {
    return chapter ? `第 ${chapter.index + 1} 章（按标题自动识别）` : '';
}

// 章节标题：有「部」时带上部名，否则只显示原始标题。
function chapterTitle(chapter) {
    if (!chapter || !chapter.title) return '';
    return chapter.part ? `${chapter.part} · ${chapter.title}` : chapter.title;
}

function formatBlockLocation(bookName, blockIndex) {
    const idx = Number(blockIndex);
    const count = getBookBlockCount(bookName);
    if (!isFiniteNumber(idx) || idx < 0 || count <= 0) return '暂无全书定位';
    const chapter = getBlockChapter(bookName, idx);
    const chapterPart = chapter ? ` · ${chapterLabel(chapter)}` : '';
    return `第 ${idx + 1}/${count} 个片段${chapterPart} · 约全书 ${(((idx + 1) / count) * 100).toFixed(1)}%`;
}

// 全书概况：详情面板里给一次「这本书有多长、怎么切的、识别到几章」
function formatBookOverview(bookName) {
    const meta = normalizeBookMeta(bookName);
    if (!meta) return '';
    const parts = [];
    if (isFiniteNumber(meta.totalWords)) {
        parts.push(`全书约 ${meta.totalWords.toLocaleString('zh-CN')} 词`);
    } else if (isFiniteNumber(meta.analyzedWords)) {
        // 老数据没有真实总词数，只能给出滑窗覆盖的词次，如实说明
        parts.push(`全书长度未记录（按窗口推算约 ${Math.round(meta.analyzedWords).toLocaleString('zh-CN')} 词次）`);
    }
    parts.push(`切成 ${meta.totalBlocks} 个片段`);
    parts.push(`每段 ${meta.blockSize.toLocaleString('zh-CN')} 词、相邻段重叠 ${meta.blockSize - meta.step > 0 ? (meta.blockSize - meta.step).toLocaleString('zh-CN') : 0} 词`);
    if (meta.chapters) {
        parts.push(`自动识别到 ${meta.chapters.length} 章`);
        const tail = chaptersWithoutBlocks(bookName);
        if (tail.length > 0) {
            parts.push(`其中末尾 ${tail.length} 章（第 ${tail[0]} 章起）在滑动窗口的截断范围内，没有对应片段`);
        }
    } else {
        parts.push('未识别到章节标题');
    }
    return parts.join(' · ');
}

function formatWordCount(wordCount) {
    const wc = Number(wordCount);
    if (!isFiniteNumber(wc) || wc <= 0) return '';
    return ` · 本片段约 ${wc.toLocaleString('zh-CN')} 词`;
}

// 复制原文片段。原文（可能含引号/换行/CJK）不进 HTML 属性：
// 先存入内存注册表，按钮只带数字索引，由全局委托统一处理点击。
//
// 这个注册表原先只 push、从不清空，也没有上限：同一段摘录每重绘一次就再追加一条
// （看板的悬停预览、排序、框选、换指标都会重绘；点开片段详情也会），页面开着越久
// 数组越大，而摘录本身有 1200 字符。
// 现在按文本去重：同一段文字复用同一个下标，重复注册不再增长。
// 注意**不能**改成「满了就清空」——按钮上带的是下标，清空会让已经渲染出去的按钮
// 指到别人身上。去重表只增不减，所以任何时刻的旧按钮都仍然指向它当初那段原文。
// 不同摘录的数量天然有上限（一本书的片段数），所以不设人为的条数上限。
const _copySources = [];
const _copySourceIndex = new Map();

function registerCopySource(text) {
    const key = String(text ?? '');
    const known = _copySourceIndex.get(key);
    if (known !== undefined) return known;
    const idx = _copySources.push(key) - 1;
    _copySourceIndex.set(key, idx);
    return idx;
}

// 「这段摘录有多少字」只有一个算法，两处（卡片按钮、原文弹窗）都从这里取。
// 以前两处各算各的：卡片把 _preview() 补的那三个省略号减掉再数，弹窗直接数原始长度，
// 于是同一段文本，卡片写「1200 字」、弹窗写「1203 字符」——数字差 3、单位还不一样，
// 摆在同一屏上像两个数在打架。统一成：**只数真正复制到的正文字符**（省略号是界面加的，
// 不是原文），单位用「字符」——正文是英文，说「字」本来就不准。
function excerptCharCount(text) {
    const src = String(text ?? '');
    return src.endsWith('...') ? src.length - 3 : src.length;
}

// 按钮上原先只写「复制片段」。可复制到的从来不是整个片段（那有 1 万词），而是开头
// 一段摘录；旁边显示的字数又比复制到的短（卡片里只露 60 字、详情页露 150 字，复制的是
// 1200 字符）。把真实字数写在按钮上，粘贴之前就知道拿到的是什么。
function copyButtonHtml(text, extraClass = '', label = '') {
    if (!text) return '';
    const caption = label || `复制摘录（${excerptCharCount(text)} 字符）`;
    return `<button type="button" class="copy-block-btn${extraClass ? ` ${extraClass}` : ''}" data-copy-idx="${registerCopySource(text)}">⧉ ${caption}</button>`;
}

function copyFromButton(button) {
    const idx = Number(button && button.dataset.copyIdx);
    const text = _copySources[idx];
    if (text === undefined) return;
    copyTextToClipboard(text, button, '✓ 已复制');
}

// 复制按钮的反馈。两件事必须做对：
//   1) 原文案存在 dataset 里——原来每次点都把当前 innerHTML 当成原文案，
//      1.6 秒内连点两次就会把「✓ 已复制」存下来，按钮从此卡死在提示语上；
//   2) 失败要说出来——http 站点（非安全上下文）没有 navigator.clipboard，
//      走 execCommand 兜底也可能被浏览器拒绝，原来是彻底静默的，用户以为复制好了。
function flashCopyButton(button, ok, okText) {
    if (!button) return;
    if (button.dataset.copyLabel === undefined) {
        button.dataset.copyLabel = button.innerHTML;
        button.dataset.copyTitle = button.title || '';
    }
    if (button._copyTimer) clearTimeout(button._copyTimer);
    button.textContent = ok ? okText : '请手动复制（Ctrl+C）';
    button.classList.toggle('copy-failed', !ok);
    button.title = ok ? button.dataset.copyTitle : '复制没成功，请手动选中后按 Ctrl+C';
    button._copyTimer = setTimeout(() => {
        button.innerHTML = button.dataset.copyLabel;
        button.title = button.dataset.copyTitle;
        button.classList.remove('copy-failed');
        button._copyTimer = null;
    }, ok ? 1600 : 4000);
}

// 导出成功也要有回执（第四十二批）。五个导出功能原来只有失败提示（showError），
// 点下去页面一动不动——文件到底下没下、下到哪儿去了，只能自己去「下载」文件夹里翻。
// 而同一块控件条里的「复制链接」「复制结论」都是有回执的（走上面的 flashCopyButton），
// 一个区域两套规矩，用户会以为导出没生效、再点一次（于是多出好几个同名文件）。
// 回执分两层：按钮文字当场换成「✓ 已导出」（眼睛看得见，与复制类按钮观感一致），
// 顶部状态条同时说一句完整的话——按钮换字不会被读屏播报，而状态条是 aria-live 区域。
function flashExportReceipt(button, message) {
    flashCopyButton(button, true, '✓ 已导出');
    if (message) setGlobalStatus('success', message);
}

function copyTextToClipboard(text, button, okText = '✓ 已复制') {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text)
            .then(() => { flashCopyButton(button, true, okText); return true; })
            .catch(() => { const ok = fallbackCopyText(text); flashCopyButton(button, ok, okText); return ok; });
    }
    // http 等非安全上下文必须走 execCommand 兜底
    const ok = fallbackCopyText(text);
    flashCopyButton(button, ok, okText);
    return Promise.resolve(ok);
}

// 返回是否真的复制成功——调用方要据此给用户反馈，不能再默默失败
function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
}

// ---- 长摘录按需取（第二十一批）----
// 页面响应里不再带长摘录（每段 1200 字，全站约七成流量都是它；口径见 README 第二十一批）。
// 点「复制更长的摘录」时才现取那一段：先查本地内存（正在展示的数据里就带着——刚上传、
// 未落盘的那本书的长摘录只存在于内存），再查本页缓存，最后才发一个请求。
const _excerptCache = new Map(); // 键 `书名\u0000片段号`；同名重传成功时整表清空
let galaxyExcerptToken = 0; // 星系弹窗的在途请求令牌：连开两段/关掉弹窗时，旧响应作废

// 在已加载的数据里找某段的长摘录（本地命中就不发请求）。
// 落盘的数据经服务端剥离后不带 extended_preview，只有未落盘的上传副本还带着。
function getLocalExcerpt(bookName, blockIndex) {
    const book = realData && realData[bookName];
    if (!book) return null;
    const wantBlock = Number(blockIndex);
    if (!Number.isFinite(wantBlock)) return null;
    for (const key of METRIC_KEYS) {
        const entries = book[key];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            if (entry && Number(entry.block) === wantBlock
                && typeof entry.extended_preview === 'string' && entry.extended_preview) {
                return entry.extended_preview;
            }
        }
    }
    return null;
}

async function resolveExcerpt(bookName, blockIndex) {
    const local = getLocalExcerpt(bookName, blockIndex);
    if (local) return { excerpt: local, extended: true };
    const cacheKey = `${bookName}\u0000${Number(blockIndex)}`;
    const cached = _excerptCache.get(cacheKey);
    if (cached) return cached;
    const resp = await fetch(`${API_BASE_URL}/api/excerpt/${encodeURIComponent(bookName)}`
        + `?block=${encodeURIComponent(blockIndex)}`);
    const result = await resp.json().catch(() => null);
    if (!resp.ok || !result || result.status !== 'success'
        || typeof result.excerpt !== 'string' || !result.excerpt) {
        if (!(result && result.message)) console.warn('[摘录] HTTP', resp.status);
        throw new Error((result && result.message) || '取摘录失败，请稍后重试。');
    }
    const payload = { excerpt: result.excerpt, extended: !!result.extended };
    _excerptCache.set(cacheKey, payload);
    return payload;
}

// 「复制更长的摘录」按钮。与普通 copyButtonHtml 的区别：那段长文不在页面里，
// 所以按钮上存的是「书名 + 片段号」，点的时候才去取——存不了 data-copy-idx。
// fallbackText 是页面上已经显示着的短摘录：万一长文取不到，就复制它，并如实告诉用户。
function excerptCopyButtonHtml(bookName, blockIndex, fallbackText, extraClass = '') {
    const block = Number(blockIndex);
    if (!bookName || !fallbackText || !Number.isFinite(block) || block < 0) return '';
    const fallbackIdx = registerCopySource(fallbackText);
    return `<button type="button" class="copy-block-btn${extraClass ? ` ${extraClass}` : ''}"`
        + ` data-copy-excerpt-book="${escapeHtml(bookName)}"`
        + ` data-copy-excerpt-block="${block}"`
        + ` data-copy-fallback-idx="${fallbackIdx}">⧉ 复制更长的摘录</button>`;
}

// 永久改按钮文案必须走这里：flashCopyButton 首次点击时会把当时的 innerHTML 快照进
// dataset.copyLabel，1.6 秒后照着快照还原——异步取回长摘录后再直接改 innerHTML，
// 会被旧快照盖回去（按钮显示的字数和实际复制的文本对不上）。所以先清快照再改。
function setCopyButtonLabel(button, html) {
    if (!button) return;
    if (button._copyTimer) {
        clearTimeout(button._copyTimer);
        button._copyTimer = null;
    }
    button.innerHTML = html;
    button.dataset.copyLabel = html;
    // flashCopyButton 还原时读 dataset.copyTitle；不先落一个定义的话，
    // 之后第一次 flash 会把 title 设成字符串 "undefined"。
    if (button.dataset.copyTitle === undefined) button.dataset.copyTitle = button.title || '';
}

// 复用同一个按钮节点、换一段文本显示前，把上一次留下的快照/索引/状态全部清掉。
// （#modal-copy-btn 就是复用节点：不清的话，上一段的快照会跨段还原出旧字数。）
function resetCopyButton(button) {
    if (!button) return;
    if (button._copyTimer) {
        clearTimeout(button._copyTimer);
        button._copyTimer = null;
    }
    delete button.dataset.copyLabel;
    delete button.dataset.copyTitle;
    delete button.dataset.copyIdx;
    button.classList.remove('copy-failed');
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.title = '';
}

// 点「复制更长的摘录」：取 → 复制 → 报告结果。三条路径都诚实：
//   长文到手 → 复制长文，文案写真实字符数；
//   只有短文（老数据）→ 复制短文，文案去掉「更长」；
//   取不到 → 复制页面上那段短的，并明说「没能取到更长的」，不静默也不假装。
async function copyExcerptFromButton(button) {
    const bookName = button.dataset.copyExcerptBook;
    const blockIndex = Number(button.dataset.copyExcerptBlock);
    const fallbackText = _copySources[Number(button.dataset.copyFallbackIdx)] || '';
    if (!bookName || !Number.isFinite(blockIndex)) return;

    const local = getLocalExcerpt(bookName, blockIndex);
    const known = local ? { excerpt: local, extended: true }
        : _excerptCache.get(`${bookName}\u0000${blockIndex}`);
    if (known) {
        setCopyButtonLabel(button, known.extended
            ? `⧉ 复制更长的摘录（${excerptCharCount(known.excerpt)} 字符）`
            : `⧉ 复制摘录（${excerptCharCount(known.excerpt)} 字符）`);
        copyTextToClipboard(known.excerpt, button, known.extended ? '✓ 已复制长摘录' : '✓ 已复制');
        return;
    }

    // 要发请求才置忙：慢网络下按钮不能看起来没反应
    const originalHtml = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '正在取长摘录…';
    try {
        const payload = await resolveExcerpt(bookName, blockIndex);
        setCopyButtonLabel(button, payload.extended
            ? `⧉ 复制更长的摘录（${excerptCharCount(payload.excerpt)} 字符）`
            : `⧉ 复制摘录（${excerptCharCount(payload.excerpt)} 字符）`);
        copyTextToClipboard(payload.excerpt, button, payload.extended ? '✓ 已复制长摘录' : '✓ 已复制');
    } catch (e) {
        console.warn('取长摘录失败:', e);
        button.innerHTML = originalHtml;
        if (fallbackText) {
            copyTextToClipboard(fallbackText, button, '✓ 已复制短摘录（没能取到更长的）');
        } else {
            flashCopyButton(button, false);
        }
    } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
    }
}

document.addEventListener('click', (event) => {
    // 长摘录按钮先认：它没有 data-copy-idx（文本还没取到），不能落进下面的分支
    const excerptBtn = event.target.closest('[data-copy-excerpt-book]');
    if (excerptBtn) {
        copyExcerptFromButton(excerptBtn);
        return;
    }
    const target = event.target.closest('[data-copy-idx]');
    if (target) copyFromButton(target);
});

// ==========================================
// 📏 指标解读参考区间（R3）：纯数据驱动，不编造固定阈值
// ==========================================

// 一批书的指标均值范围（只看有数据的书）
function getMetricMeanRange(bookNames, metric) {
    const means = bookNames
        .map(name => {
            const values = getMetricValues(name, metric).map(d => d.value);
            return values.length > 0 ? d3.mean(values) : null;
        })
        .filter(isFiniteNumber);
    if (means.length === 0) return null;
    return { count: means.length, min: d3.min(means), max: d3.max(means) };
}

function getMetricContextLine(metric) {
    if (!realData) return '';
    const loaded = Object.keys(realData);
    if (loaded.length === 0) return '';

    // 基准用「服务器上常驻的示例书」——用户自己的书不该拿来当参照物；
    // 没有内置书（例如只有自己上传的书）时退回全部已加载的书
    const builtinLoaded = builtinBookNames.filter(name => loaded.includes(name));
    const baselineNames = builtinLoaded.length > 0 ? builtinLoaded : loaded;
    const baseline = getMetricMeanRange(baselineNames, metric);

    const selectedNames = Array.from(selectedBooks);
    const selected = getMetricMeanRange(selectedNames, metric);
    const sameAsBaseline = selectedNames.length === baselineNames.length
        && selectedNames.every(name => baselineNames.includes(name));

    const parts = [];
    if (baseline) {
        const label = builtinLoaded.length > 0 ? '内置示例书' : '当前已加载的书';
        // 点名是哪几本（第四十六批）。原来只写「内置示例书」，全文没有一处列出这 4 本的
        // 书名——摘要里要能写出「参照区间的样本是哪 4 部作品」，论文被问到常模样本是什么
        // 才答得上。顺序按作者、再按年份排（同作者两部相邻），顺带把这四本「两两同作者」
        // 的结构摆出来。
        const named = builtinLoaded.length > 0
            ? `（${sortBuiltinByAuthorThenYear(builtinLoaded).map(n => `《${getBookDisplayName(n)}》`).join('')}）`
            : '';
        // 「这只是个参照」三个字不够（第四十批）：读者照样会把它读成常模。
        // 内置书只有 4 本，把「样本有多小」直接说出来，比只说「不是好坏标准」有用。
        const caveat = `只有这 ${baseline.count} 本，不足以构成常模——`;
        // 括号里不再重复本数（第四十四批）：「参考区间：内置示例书（4 本）的…。只有这 4 本…」
        // 一句话里出现了两次。本数留在 caveat 里——那是第四十批有意加的强调（把样本有多小
        // 直接说出来），上面那个括号现在装的是书名，不是本数。
        parts.push(`参考区间：${label}${named}的平均水平大致在 ${formatMetric(baseline.min)} – ${formatMetric(baseline.max)}。${caveat}它只用于判断你的书落在参考区间的哪一端，不是好坏标准。`);
    }
    if (selected && !sameAsBaseline) {
        // 只选了一本时，「在 X – X 之间」是句废话（最小值等于最大值），改说平均水平
        // 「你选中的」一律改「所选」（第四十六批）：这句话会跟着导出摘要/复制结论离开
        // 屏幕，而在文件里「你」变成了收件人——读它的导师并没有选过这几本书。
        if (selected.count === 1) {
            parts.push(`所选这 1 本，平均水平是 ${formatMetric(selected.min)}。`);
        } else if (sizeExtentIsFlat([selected.min, baseline.min])
                   && sizeExtentIsFlat([selected.max, baseline.max])) {
            // 选中的正好是这批书里平均最高和最低的那几本时，两段数字会一模一样。默认那两本
            // 就是这样（一批书里句子最短、最长的那两本），于是屏幕上出现「参考区间 …在 14.48 –
            // 18.81…。所选 2 本在 14.48 – 18.81 之间。」——第二句一个字都没多给，
            // 读者只会以为这个功能坏了。改成说清为什么一样（判据同 C4，见 sizeExtentIsFlat）。
            // 这句话会跟着「导出摘要 / 复制结论」离开屏幕（第四十二批），所以不能再用
            // 「上面的数字」「参照区间」这类指代——文件里没有「上面」，也没有那块界面。
            // 把因果说全：为什么两段范围一模一样，以及这不是数据出问题。
            parts.push('所选这几本，正好是这批书里该指标最高和最低的那几本；所以它们自己的范围，和作为参照的那几本的范围是同一个——这是选书的必然结果，不是数据有问题。');
        } else {
            parts.push(`所选 ${selected.count} 本在 ${formatMetric(selected.min)} – ${formatMetric(selected.max)} 之间。`);
        }
    }
    if (parts.length === 0) return '';

    // 三个标量为什么能跨书比（第四十批）：参照区间报了「你在 14.48–18.81 之间」，
    // 却没说过这些数是不是同一把尺子量出来的。片段等长就成立（见 buildScalarComparabilityNote）。
    if (selectedNames.length >= 2) {
        const sizes = new Set(selectedNames
            .map(name => normalizeBookMeta(name)).filter(Boolean)
            .map(m => m.blockSize).filter(isFiniteNumber));
        if (sizes.size === 1) {
            parts.push(`这几本都是在同样长度的片段（每段 ${Array.from(sizes)[0]} 词）上算的，数字可以直接比。`);
        }
    }

    // 上传的文本与内置示例书的清洗口径（第四十批加，第四十六批改对）。
    // 原来这里写的是「上传的按原样分析，你自己的书没有这一层」——**是错的**：
    // api_server 的上传路径调用的是同一个 clean_text，剥不剥 Gutenberg 授权声明那一段
    // 只看文本里有没有 *** START/END OF … GUTENBERG … *** 这对标记，与「内置还是上传」无关。
    // 把语料整理自 Gutenberg 的研究者会据此以为自己那份没被处理，判断可比性的前提就是错的。
    // 现在如实说清判据是「看标记」，不再按来源分。
    const uploadedSelected = selectedNames.filter(name => !builtinBookNames.includes(name));
    if (uploadedSelected.length > 0) {
        const label = selectedNames.length === 1 ? '这一本' : `其中 ${uploadedSelected.length} 本`;
        parts.push(`${label}是你上传的文本，和内置书走同一套清洗（统一空白、还原常见缩写）。此外，只有文本里带 Project Gutenberg 起始/结束标记的文件才会再剥掉它的授权声明那一段——看的是文件里有没有这对标记，不是看它是内置的还是你上传的。`);
    }

    let line = parts.join(' ');
    // hapaxLegomena 那句「对篇幅的依赖很弱」原本挂在这里，第二十六批挪进了
    // updateMetricHint 的静态说明里：挂在这边时，一旦算出参考区间，屏幕上就会出现
    // 同一句话连着说两遍（hint 一行 + 这一行），比不说还像凑字数；
    // 而静态说明是无论有没有数据都在的，不会因为加载失败就把口径提醒吞掉。
    if (metric === 'functionWords') {
        line += ' 「风格走向」只是高频小词用法的一个参照方向，请结合原文理解。';
    }
    return line;
}

function getBookSafeId(name) {
    const text = String(name ?? 'book');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    const normalized = text.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'book';
    return `${normalized}_${Math.abs(hash)}`;
}

// 内置名著的中文名映射（面向中文读者），未知书名原样返回
function getBookDisplayName(name) {
    const map = {
        'The Adventures of Tom Sawyer': '汤姆·索亚历险记',
        'The Adventures of Huckleberry Finn': '哈克贝利·费恩历险记',
        'The Call of the Wild': '野性的呼唤',
        'The call of the wild': '野性的呼唤',
        'White Fang': '白牙'
    };
    return map[name] || name;
}

// ==========================================
// 🎨 书名 → 颜色：三张图共用同一份映射
// ==========================================
// 热力图/折线图、风格星系、全书对比原来各建一个 d3.scaleOrdinal，range 一模一样，
// 但 domain 不一样（前两个是「当前选中的书」按点选顺序，看板是「全库」），于是
// 同一本书在不同页签是不同颜色——《白牙》在星系里是青色、到了看板变成赭色。
// 现在统一以全库顺序（Object.keys(realData)）为唯一 domain：看板的取值一位都不变，
// 另外两处（折线图、星系）向它看齐。
//
// 旁注：#b5472f 同时是 --vermilion 强调色（hover 描边、选中态、峰值点），
// 排在 0 号槽的那本书会和强调色同色。这是既有现象，不是这里引入的。
const BOOK_COLOR_RANGE = [
    '#b5472f', '#4f7a8c', '#6b8f5a', '#a67c3d',
    '#5a6b8c', '#a2546b', '#8c6f4a', '#5f7d72'
];

// 与 getBookSafeId 同一套 Java 风格字符串哈希：纯函数、确定性、不碰 Math.random
function bookColorHash(value) {
    const text = String(value ?? '');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

// 命中全库顺序时与旧 scaleOrdinal 逐位等价（d3 就是 range[domainIndex % range.length]），
// 所以看板配色零变化。查不到只可能发生在数据加载之前，而那时三张图都还没开始画
// （initChart / initAdvancedData / initStyleGalaxy 都会在 !realData 时提前返回），
// 所以按名字哈希取色这条分支是纯防御，不追求与索引分支同色。
function bookSlot(name) {
    const keys = (realData && typeof realData === 'object') ? Object.keys(realData) : [];
    const index = keys.indexOf(String(name));
    return index >= 0 ? index : bookColorHash(name);
}

function colorForBook(name) {
    return BOOK_COLOR_RANGE[bookSlot(name) % BOOK_COLOR_RANGE.length];
}

// 只靠颜色区分书，对红绿色盲等于没区分——八种色相里他们还分得开的只有两三种，
// 而这套色板里 #b5472f / #a67c3d / #a2546b 三者的明度与色相都挨得很近。
// 所以给每条**线**再配一个线型（第二编码通道）：颜色分不出来时靠虚实分辨。
// 槽位与颜色共用 bookSlot()，同一本书的颜色和线型永远绑在一起，不会出现
// 「图例画着虚线、图上却是实线」这种自相矛盾。0 号槽是实线，所以只选中一本书时
// （默认首屏就是这一种）外观和改动前完全一样。
const BOOK_DASH_RANGE = [
    '',                 // 实线
    '10 5',
    '2 4',
    '14 4 3 4',
    '6 3 2 3',
    '1 4',
    '16 4 2 4 2 4',
    '5 3'
];

function dashForBook(name) {
    return BOOK_DASH_RANGE[bookSlot(name) % BOOK_DASH_RANGE.length];
}

// 星系的圆点也要有第二个编码通道，理由和上面那条线型一模一样，而且这边更急：
// 这套色板里的 #6b8f5a（绿）与 #a67c3d（金）转成灰度只差 2/255（按 sRGB 相对亮度
// 算是 131.5 对 128.4），在绿色盲模拟下更是几乎同色——而这两本（野性的呼唤、白牙）
// 恰恰就是地盘叠在一起、最需要分辨的那两本。所以给球心压一道纸色的小记号：
// 形状与颜色共用 bookSlot()，同一本书的色和形永远绑在一起。
// 形式取 slot % 4，所以 0 号槽不记号——只选一本书（默认首屏就是这一种）时，
// 外观与改动前完全一样，这一点和 BOOK_DASH_RANGE 的 0 号槽同理。
//
// 为什么是「球心的记号」而不是「把圆点换成方点三角点」：<circle> 这个元素同时被
// 悬停、点按、拖动、键盘导航和触屏取点五处引用（circles / allCircles / circles.nodes()），
// 换成 <path> 等于把这五条路一起改写。记号是另加的一层，那些路一行都不用动。
const BOOK_GLYPH_RANGE = ['none', 'bar', 'stem', 'cross'];

function glyphForBook(name) {
    return BOOK_GLYPH_RANGE[bookSlot(name) % BOOK_GLYPH_RANGE.length];
}

// 记号画在以 (0,0) 为球心的坐标系里，尺度按球半径走（球越大记号越粗）：
// 半长 0.62r、线宽 0.16r，是照「半径 4 时要看得见、半径 14 时不喧宾夺主」定的。
function galaxyGlyphPath(kind, r) {
    if (kind === 'none') return null;
    const a = r * 0.62;
    const seg = (x1, y1, x2, y2) => `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
    if (kind === 'bar') return seg(-a, 0, a, 0);
    if (kind === 'stem') return seg(0, -a, 0, a);
    // cross
    return seg(-a, 0, a, 0) + seg(0, -a, 0, a);
}

function galaxyGlyphWidth(r) {
    return Math.max(1, r * 0.16);
}

// ==========================================
// ✧ 风格星系的轴词：只说实话
// ==========================================
// 说明里举的「高频小词」例子必须来自真实模型，不能写死。本项目语料是英文小说，
// 轴词是 the / his / of / he 这类英文小词，写死成中文虚词就是给用户假信息。
// 后端 src/projection.py 的 axis_labels() 已按主成分载荷算好，形如
// 「横轴越靠右，the / his / of / he 这类小词在整段里占的比例越高」，
// 经 projection.axisLabels 传到前端（renderGalaxyNote 已在用同一份数据）。
// 一条轴可能是两段（正号词一段、负号词一段，用「；」隔开），所以每段都要取。
// 取不到时（旧版数据 / 不同模型混选 / 退化模型）不编词，退回泛称。
function getAxisWordsFor(comparability) {
    const labels = (comparability && comparability.axisLabels) || [];
    const words = [];
    labels.forEach(text => {
        // 只认「，A / B / C 这类小词」里的那段词表，不把整句当词。
        // 分号也要排除，否则分号前面那段的词表会被一路吞到下一段去。
        const parts = String(text).match(/，([^，；]+?)\s*这类小词/g) || [];
        parts.forEach(part => {
            const matched = /，([^，；]+?)\s*这类小词/.exec(part);
            if (!matched) return;
            matched[1].split('/').forEach(word => {
                const trimmed = word.trim();
                if (trimmed && words.indexOf(trimmed) < 0) words.push(trimmed);
            });
        });
    });
    return words.slice(0, 4);
}

function getSelectedAxisWords() {
    return getAxisWordsFor(getGalaxyComparability(Array.from(selectedBooks)));
}

// 嵌进句子里的两种写法；没有真实轴词时都返回空串，句子照样通顺
function getAxisWordsHint() {
    const words = getSelectedAxisWords();
    return words.length ? `（${words.join(' / ')} 这类）` : '';
}

// 把轴词回填进静态 HTML 里的占位 span（词表为空时保持为空）。
//
// 第四十三批删掉了第二个占位 span：星系图指南行原来还带一份「（the / his / of / he）」，
// 和本行（标题里那句）、下面的图例重复了同一组词。getAxisWordsParen 随之删除。
function renderAxisWordHints() {
    const hint = document.getElementById('galaxy-axis-words');
    if (hint) hint.textContent = getAxisWordsHint();
}

// 星系图例里「大小 = …」那行要点出当前观察角度是哪个指标。
//
// 不点出来的话，那个全局下拉的名字（「观察角度」）会让人以为它改的是点的位置——
// 位置其实恒为高频小词坐标（initStyleGalaxy 里 positionData 永远取 functionWords），
// 只有圆点大小跟着指标走。
//
// 特例：指标就是「风格走向」时不能写成「数值高低」，因为那会暗示两套独立编码。
// functionWords 的 value 恰恰就是 PCA 第一主成分（见 src/pipeline.py：item["x"] 作
// value、item["y"] 作 value_y），而横向位置用的就是同一个 pcaX——同源，得说出来。
function updateGalaxySizeHint() {
    const el = document.getElementById('galaxy-guide-size');
    if (!el) return;
    const label = (typeof getMetricLabel === 'function') ? getMetricLabel(currentMetric) : currentMetric;
    if (currentMetric === 'functionWords') {
        el.textContent = `大小 = 「${label}」的数值高低（与横向位置同源）`;
        return;
    }
    el.textContent = `大小 = 「${label}」的数值高低`;
}

// 圆点大小的刻度尺（第三十六批）。原来只有颜色图例，「大小」那一行只写字不给刻度，
// 读者没法判断「多高算高、这两个点差多少」——气泡图的通行要求是配一条尺寸图例。
// 三个圆用**同一个** radiusScale 画，所以图例上的大小和图上的是同一把尺子。
function renderGalaxySizeLegend(radiusScale, nodes) {
    const el = document.getElementById('galaxy-size-legend');
    if (!el) return;
    el.innerHTML = '';

    const values = nodes.map(d => d.realValue).filter(isFiniteNumber).sort((a, b) => a - b);
    // 值域退化（所有片段数值相同）时不画：normalizeExtent 会把域撑成 [min-1, max+1]，
    // 照画就是三个假刻度
    if (values.length < 2 || sizeExtentIsFlat([values[0], values[values.length - 1]])) {
        el.hidden = true;
        return;
    }

    const picks = [
        { value: values[0], hint: '本图最小' },
        { value: values[Math.floor(values.length / 2)], hint: '本图中位' },
        { value: values[values.length - 1], hint: '本图最大' }
    ];

    const caption = document.createElement('span');
    caption.className = 'galaxy-size-legend-caption';
    caption.textContent = '圆点大小对应的数值：';
    el.appendChild(caption);

    picks.forEach(pick => {
        const item = document.createElement('span');
        item.className = 'galaxy-size-legend-item';
        item.title = pick.hint;

        const dot = document.createElement('span');
        dot.className = 'galaxy-size-legend-dot';
        // 直径 = 半径 × 2，与图上的画法一致
        const d = radiusScale(pick.value) * 2;
        dot.style.width = `${d.toFixed(1)}px`;
        dot.style.height = `${d.toFixed(1)}px`;
        item.appendChild(dot);

        const text = document.createElement('span');
        text.textContent = formatMetric(pick.value);
        item.appendChild(text);

        el.appendChild(item);
    });

    el.hidden = false;
}

// 指纹热力图图例：低值（黛蓝）↔ 高值（赤）在每个指标下的具体含义
function getHeatmapLegend(metric) {
    const legend = {
        sentenceLength: ['短句', '长句'],
        simpsonIndex: ['用词多样', '用词重复'],
        hapaxLegomena: ['用词较单调', '用词较丰富']
    };
    if (metric === 'functionWords') {
        // 色标上的数是功能词 PCA 的横轴坐标，一个有正负号的**加权分数**（内置书实测 -0.06 ~ +0.07），
        // 不是某一个词的占比。原来写成「the 占比低 / 占比高」，等于把一个综合分数说成了一个词的多少
        // （第四十二批）。方向不变，只把话说准：拿真实模型里载荷最高的那个词当代表，
        // 说「这类小词用得多还是少」。取不到轴词时不点名——宁可不具体，也不要指一个模型里没有的词。
        const words = getSelectedAxisWords();
        return words.length
            ? [`少用 ${words[0]} 这类小词`, `多用 ${words[0]} 这类小词`]
            : ['小词用法偏这一侧', '小词用法偏另一侧'];
    }
    return legend[metric] || ['低值', '高值'];
}

// 全书对比页有两张图，导出按钮只有一条。「导出的是当前这张图」要成立，
// 就得记住用户最后碰过的是哪张：默认「整体水平对比」，碰过走势图就跟着变。
const DASH_CHARTS = {
    'adv-mean': '整体水平对比',
    'adv-line': '风格走势'
};
let lastDashChart = 'adv-mean';

function trackDashboardCharts() {
    Object.keys(DASH_CHARTS).forEach((id) => {
        const card = document.getElementById(id);
        if (!card) return;
        const mark = () => { lastDashChart = id; };
        card.addEventListener('mouseenter', mark);
        card.addEventListener('pointerdown', mark);
        card.addEventListener('focusin', mark);
    });
}

// 导出的必须是「眼前这一张图」。
// 旧写法写死 #main-chart，于是在「风格星系」「全书对比」下点导出，
// 拿到的仍是基础趋势的热力图，跟屏幕上的图不是一回事。
function getExportTarget() {
    if (currentTab === 'view-galaxy') {
        return { element: document.querySelector('#galaxy-container svg'), label: '风格星系' };
    }
    if (currentTab === 'view-dashboard') {
        // 以前写死 #adv-mean：它恒存在，于是「风格走势」那张永远导不出来
        const element = document.querySelector(`#${lastDashChart} svg`)
            || document.querySelector('#adv-mean svg');
        return { element, label: `全书对比·${DASH_CHARTS[lastDashChart] || DASH_CHARTS['adv-mean']}` };
    }
    // 另两个页签是「按容器查 svg」，查不到返回 null，于是拿不到图时有一句正经提示。
    // 首屏这一张的 <svg> 是写死在 HTML 里的，永远存在——只是数据还没加载完时它是个空壳
    // （没有 viewBox、也没有子节点）。这时点「导出图像」不会走进那个 null 分支，
    // 而是照着 100%/400 的属性值算出一块画布，静静导出一张纯底色图：用户以为自己拿到了图，
    // 拿去交作业才发现是白的。所以这里用「有没有内容」当判据，把它并进同一句提示。
    const el = document.getElementById('main-chart');
    return {
        element: (el && el.childElementCount > 0) ? el : null,
        label: chartType === 'line' ? '折线趋势图' : '指纹热力图'
    };
}

// 文件名里的书：多本时不再只写第一本的名字（导出的是对比图，不是单书图）
function exportFileLabel() {
    const books = Array.from(getActiveBookSet());
    if (books.length === 0) return 'Comparison';
    if (books.length > 1) return '多书对比';
    return books[0].replace(/\s+/g, '_');
}

// 导出的按钮在三个页签下都看得到，但目标 svg 是各视图渲染时才建的。
// 拿不到时给一句能自处的话，别只说「找不到图表元素」。
function getNoChartMessage() {
    const where = currentTab === 'view-galaxy' ? '风格星系' : (currentTab === 'view-dashboard' ? '全书对比' : '基础趋势分析');
    return `「${where}」这张图还没画出来，暂时没有可导出的内容。`
        + '请先点击有数据的书，或稍等图表渲染完成后再试。';
}

// ── 导出用的内联样式 ──────────────────────────────────────────────
// 导出物是序列化后的字符串，外部样式表不跟着走，凡是靠 d3-style.css 上色的
// 元素都得在这里重述一遍。以前这里只有 3 条规则，于是「风格走向」的 0 基线
// （<line> 没有 stroke 时默认不可见）整条消失、最高点（<circle> 没有 fill 时
// 默认纯黑）从朱红变黑点、框选矩形变成一个不透明黑块——屏幕上和导出的不是同一张图。
// 这份字符串原来在 exportChart 和 exportVectorChart 里各存一份，已经漂移过，
// 现在只留这一份。
const EXPORT_SVG_STYLE = `
    <style>
        text { font-family: 'Microsoft YaHei', sans-serif; fill: #2f2a23; }
        .heatmap-rect { stroke: ${HEATMAP_STROKE}; stroke-width: 1px; }
        .axis path, .axis line { fill: none; stroke: #98907f; shape-rendering: crispEdges; }
        .zero-line { stroke: #6b6254; stroke-width: 1; shape-rendering: crispEdges; }
        .annotation-point { fill: #b5472f; stroke: #fdf9ef; }
        .selection { fill: rgba(181, 71, 47, 0.12); stroke: #b5472f; }
        .line-path { fill: none; }
    </style>`;

// 屏幕上的图例长在图外的 HTML 里（风格星系的 #galaxy-legend、全书对比的彩色
// chip），SVG 内部一个字都没有。导出只序列化 svg，于是拿出去的 PNG/SVG 就是
// 一堆认不出谁是谁的颜色。这里在序列化之前把图例补进 svg 的副本里。
//
// 颜色不重算，直接读屏幕上已经渲染好的色值：重算要复刻渲染时的取色顺序，
// 很容易对不上；读 DOM 则天然一致。
function collectExportLegend() {
    const items = [];
    if (currentTab === 'view-galaxy') {
        document.querySelectorAll('#galaxy-legend .galaxy-legend-item').forEach(item => {
            if (item.classList.contains('galaxy-legend-skipped')) return; // 没画进图里的不列
            const swatch = item.querySelector('.galaxy-legend-swatch');
            const name = (item.textContent || '').trim();
            if (swatch && name) {
                items.push({ color: getComputedStyle(swatch).backgroundColor, name });
            }
        });
        return { items, shape: 'rect' };
    }
    if (currentTab === 'view-dashboard') {
        const seen = new Set();
        document.querySelectorAll('#adv-line .line-path').forEach(path => {
            const datum = path.__data__;
            if (!datum || seen.has(datum.id)) return;
            seen.add(datum.id);
            items.push({
                color: path.getAttribute('stroke') || datum.color,
                // 线型一并带走：导出的图例若只剩颜色，就等于把屏幕上唯一那条
                // 「不靠颜色也能分辨」的线索丢在页面里了。
                dash: path.getAttribute('stroke-dasharray') || '',
                name: datum.displayName || datum.name
            });
        });
        return { items, shape: 'line' };
    }
    return { items: [], shape: 'rect' };
}

// 屏幕上的「风格走势」图例（第四十六批）。这一页三张图里原来只有这张没有一个书名，
// 而导出的 PNG/SVG 反而有图例——本末倒置。取法与 collectExportLegend 完全一样：
// 颜色与线型直接读屏幕上已经渲染好的 path，不自己重算一遍（重算要复刻 dashForBook
// 的槽位分配，很容易对不上）。线型要画出来：它是色盲读者唯一不靠颜色分辨的线索。
function renderAdvLineLegend() {
    const box = document.getElementById('adv-line-legend');
    if (!box) return;
    const items = [];
    const seen = new Set();
    document.querySelectorAll('#adv-line .line-path').forEach(path => {
        const datum = path.__data__;
        if (!datum || seen.has(datum.id)) return;
        seen.add(datum.id);
        items.push({
            color: path.getAttribute('stroke') || datum.color || '#2f2a23',
            dash: path.getAttribute('stroke-dasharray') || '',
            name: datum.displayName || datum.name
        });
    });
    if (items.length === 0) {
        box.textContent = '';
        box.hidden = true;
        return;
    }
    const SVG_NS = 'http://www.w3.org/2000/svg';
    box.textContent = '';
    items.forEach(item => {
        const wrap = document.createElement('span');
        wrap.className = 'chart-legend-item';
        const swatch = document.createElementNS(SVG_NS, 'svg');
        swatch.setAttribute('width', '24');
        swatch.setAttribute('height', '10');
        swatch.setAttribute('aria-hidden', 'true');
        swatch.classList.add('chart-legend-swatch');
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', '0');
        line.setAttribute('y1', '5');
        line.setAttribute('x2', '24');
        line.setAttribute('y2', '5');
        line.setAttribute('stroke', item.color);
        line.setAttribute('stroke-width', '2');
        if (item.dash) line.setAttribute('stroke-dasharray', item.dash);
        swatch.appendChild(line);
        wrap.appendChild(swatch);
        wrap.appendChild(document.createTextNode(item.name));
        box.appendChild(wrap);
    });
    box.hidden = false;
}

// 风格星系的坐标轴含义也只写在图外的 #galaxy-axis-note 里，一并带走
function collectExportAxisNote() {
    if (currentTab === 'view-dashboard') {
        // 「整体水平对比」的柱子高度在框选后变成了区段口径，而说明那句话写在
        // SVG 外面的 h4 里（#adv-mean-scope）。导出只序列化 SVG，于是导出的图
        // 看着就是全书平均——一个比屏幕上更错的版本。这句话必须跟着图走。
        const scope = document.getElementById('adv-mean-scope');
        const scopeText = scope ? (scope.textContent || '').trim() : '';
        if (!scopeText) return '';
        // 只在真的导出这张条形图时加：走势图画的是整条曲线，框选只是高亮，
        // 给它挂一句「数值取的是区段平均」反而变成新的一句错话。
        const exportElement = getExportTarget().element;
        if (!exportElement || exportElement !== document.querySelector('#adv-mean svg')) return '';
        const rangeText = scopeText.replace(/^（|）$/g, '').replace(/^框选区段\s*/, '');
        return `图中各书的数值取的是框选区段 ${rangeText} 内的分段平均，不是全书平均`;
    }
    // 主图页（指纹热力图）：色标那句说明写在 SVG 外面的 #heatmap-scale-note 里，
    // 而导出只序列化 SVG，于是导出的热力图上「同一个颜色」到底是多大，一个字都没有——
    // 偏偏这张图最常被截下来并排摆（两次选择各截一张），而那正是色标不可比的时候。
    // 与上面 adv-mean-scope、下面 galaxy-guide-size 同一条规矩：屏幕上说了的话，
    // 跟着图走。折线图不需要这句（它纵轴自带数字），所以只在热力图下加。
    if (currentTab === 'view-main') {
        if (chartType !== 'heatmap') return '';
        const scaleNote = document.getElementById('heatmap-scale-note');
        if (!scaleNote || scaleNote.hidden) return '';
        return (scaleNote.textContent || '').trim().replace(/\s+/g, ' ');
    }
    if (currentTab !== 'view-galaxy') return '';
    // 「大小 = …」那行在 #galaxy-guide 里，不在 SVG 里，导出只序列化 SVG，
    // 于是导出的星系图上有「颜色 ↔ 书名」的图例，却没有任何一句解释圆点大小。
    // 导出的图是要放进论文/汇报的那份产物，这句得跟图走，排在最前（它是图例的核心句）。
    const parts = [];
    const sizeEl = document.getElementById('galaxy-guide-size');
    const sizeText = sizeEl ? (sizeEl.textContent || '').trim() : '';
    if (sizeText) parts.push(sizeText);
    const note = document.getElementById('galaxy-axis-note');
    if (note && !note.hidden) {
        // 横轴、纵轴在 DOM 里是两个子节点，直接取整块的 textContent 会把它们粘成
        // 一句「…比例越高纵轴越靠上…」，读起来像缺了标点
        const noteParts = note.children.length
            ? Array.from(note.children).map(c => (c.textContent || '').trim()).filter(Boolean)
            : [(note.textContent || '').trim()];
        noteParts.forEach(text => { if (text) parts.push(text); });
    }
    // 拼的时候别在原句的句号后面再生一个分号：noteParts 里每句都自带标点，
    // 直接 join('；') 会让导出的图上出现「…平均水平。；（空出来的部分是…」——
    // 两句之间本来就有句号，多出来的那个分号读起来像打错了字。
    // 上一句已经收尾（句号/问号/叹号，或右括号结尾）时就不再加分隔符。
    // 顺带一个必须留意的地方：wrapAxisNote 是靠「；」分段找折行点的，
    // 少几个「；」只会让某一段变长、由它自己按 46 字硬折，不会漏字。
    return parts.reduce((acc, text) => {
        if (!acc) return text;
        const closed = /[。！？）”』」]$/.test(acc);
        return acc + (closed ? '' : '；') + text;
    }, '').replace(/\s+/g, ' ');
}

function exportLegendLineHeight() { return 18; }

// 导出图底部那行「这是谁、哪张图、什么时候生成的」。
//
// 为什么必须跟着图走：导出的 PNG/SVG 是要贴进论文、课件、汇报里的那份产物。
// 贴出去之后它就和这个页面脱钩了——半年后翻到这张图，没人知道它出自哪里、
// 是什么时候按哪次选择生成的。图里现有的标题只写了指标（「平均句长 - 指纹对比」），
// 图例只写了书名，两样都答不了「哪来的」。
//
// 为什么单独算行数、不并进 collectExportAxisNote：那段说明已经顶到
// wrapAxisNote 的 MAX_LINES 上限（星系正好 6 行），再挂一句进去会有被尾部
// 截成「…」的风险——一行署名被截掉半句比没有更糟。这里单独折行、单独计高。
function exportProvenanceLines(maxWidth) {
    const where = currentTab === 'view-galaxy'
        ? '风格星系'
        : (currentTab === 'view-dashboard' ? '全书对比' : (chartType === 'line' ? '折线趋势图' : '指纹热力图'));
    // 坐标模型编号只挂在风格星系这一张上（第四十批）。星系的横纵坐标是坐标模型算出来的
    // （轴上那些「解释 X% 的差异」就是它给的），而模型编号此前只写在 BibTeX 与文本摘要里，
    // 图上没有——图贴进论文就与页面脱钩，读者没法从图里知道坐标是谁给的。
    // 「全书对比」「热力图」「折线趋势」画的都是标量指标，不用这个模型，盖上去是无用信息。
    let modelPart = '';
    if (currentTab === 'view-galaxy') {
        const shared = getSharedProjection(getExportBooks());
        if (shared && shared.model && shared.model.modelId) {
            modelPart = `　坐标模型：${shared.model.modelId}`;
        }
    }
    // 时间用本地时间（和文件名、和文本摘要一致），不用 toISOString 的 UTC
    const text = `文印·文学指纹　${where}　观察角度：${getMetricLabel(currentMetric)}${modelPart}　${new Date().toLocaleString('zh-CN')} 生成`;
    // 按画布实际宽度折行：署名是 10px 字，CJK 近似全宽，所以每字算 10px，
    // 左右各留 24px 边距。下限 24 字——画布再窄也别折成一堆碎片，那还不如让它出去。
    const budget = Math.max(24, Math.floor(((maxWidth || 800) - 48) / 10));
    return wrapProvenance(text, budget);
}

// 署名行的折行：断点优先落在「　」上，而不是按固定字数硬切。
// 一开始直接复用 wrapAxisNote，手机上正好切在日期中间，切出
// 「…观察角度：平均句长　2026/」+「10/9 02:34:11 生成」这种半截日期——
// 半截日期比换行难看，也更容易被误读成别的意思。署名里每一段（谁、哪张图、
// 什么角度、什么时候）本来就是独立字段，断在字段之间既不丢信息也读得通。
// 装不下就一段一行，最多 4 行（署名固定 4 段），不会顶到 wrapAxisNote 那个行数上限。
function wrapProvenance(text, maxChars) {
    const MAX = maxChars || 46;
    const lines = [];
    String(text).split('　').forEach(part => {
        if (!part) return;
        // 单段自己就超宽（窄画布 + 长角度名）只能硬切，碎下来的尾巴照常往下塞
        let rest = part;
        while (rest.length > MAX) {
            lines.push(rest.slice(0, MAX));
            rest = rest.slice(MAX);
        }
        if (!rest) return;
        const last = lines.length - 1;
        // 「+ 1」是算上要塞回去的那个分隔空格；塞不进去就另起一行——
        // 这时不补空格，换行本身已经把两段分开了
        if (last >= 0 && lines[last].length + 1 + rest.length <= MAX) {
            lines[last] += '　' + rest;
        } else {
            lines.push(rest);
        }
    });
    return lines.length ? lines : [''];
}

// 轴说明的折行。算高度和画文字**必须**都走这一个函数：以前两边各写各的
// （高度按 Math.ceil(len/46) 估、画的时候按 i += 46 且硬顶 4 行），一旦说明超过
// 4 行或长度不是 46 的整数倍，两者就对不上，图例带会盖住图或多出一截空白。
// 折行优先断在「；」处（那是前后两段轴的天然断点），单段超长才按 46 字硬折。
//
// maxChars 可传：署名那行是 10px 字、且画布宽度会变（手机上导出的画布只有桌面一半宽），
// 固定 46 字在窄画布上会横穿出去。默认 46 保持轴说明原来的行为不变。
function wrapAxisNote(axisNote, maxChars) {
    const MAX = maxChars || 46;
    // 上限 6 → 7（第三十六批）→ 12（第三十八批）。
    //
    // 第三十八批把上限一次提到 12，是因为「7」早就已经在悄悄吃内容了：实测星系的
    // 那段说明拼起来是 359 字，按 46 字折行要 10 行，而 7 行是从尾部切掉再补「…」——
    // 也就是说，导出的那张图上，「点为了不互相压住会被推开一点，位置是近似的」
    // 「同色的浅色区域是地盘」「球心的记号是对图例用的」这三句**一句都没印出来**。
    // 屏幕上看得见、导出的图上看不见，而导出的图才是要贴进论文的那一份。
    // 7 这个数是按当时 6 行的内容定的，内容长了两轮，数没跟着长。
    //
    // 12 是「10 行 + 两行余量」。余量的意思不是可以随便加，而是：下一次再加内容时，
    // 会先在 12 行处出现「…」——那是个看得见的信号，比静默少印三句好得多。
    // 高度和画字都走这个函数，改了不会失配（exportLegendBandHeight 也是调它算的）。
    const MAX_LINES = 12;
    const lines = [];
    String(axisNote).split('；').forEach((seg, idx) => {
        // 分号被 split 吃掉了，除第一段外都要补回来
        let rest = idx === 0 ? seg : '；' + seg;
        while (rest.length > MAX) {
            lines.push(rest.slice(0, MAX));
            rest = rest.slice(MAX);
        }
        if (!rest.length) return;
        // 塞得进上一行就塞，免得为几个字多占一整行
        const last = lines.length - 1;
        if (last >= 0 && lines[last].length + rest.length <= MAX) lines[last] += rest;
        else lines.push(rest);
    });
    if (!lines.length) return [''];
    if (lines.length > MAX_LINES) {
        // 真被截断时留个记号，别让导出的图悄悄少一段
        const kept = lines.slice(0, MAX_LINES);
        kept[MAX_LINES - 1] = kept[MAX_LINES - 1].slice(0, MAX - 1) + '…';
        return kept;
    }
    return lines;
}

// 图例带的高度：每条图例一行，轴说明按 wrapAxisNote 的实际行数，署名行另算
function exportLegendBandHeight(items, axisNote, provenanceLines) {
    const sign = (provenanceLines || []).length;
    if (!items.length && !axisNote && !sign) return 0;
    const lineH = exportLegendLineHeight();
    let lines = items.length;
    if (axisNote) lines += wrapAxisNote(axisNote).length;
    if (sign) lines += sign;
    // 署名与上面那段之间空一行：一行 18px 的间距太大，取半个行高，够分开就行
    return lines * lineH + 16 + (sign ? lineH / 2 : 0);
}

// 三种图的 svg 尺寸写法并不统一：基础趋势/全书对比是 viewBox + inline 高度，
// 风格星系是 width/height 属性。这里统一成「viewBox + width/height 属性」，
// 并清掉 inline 高度——否则序列化出来的 style="height:400px" 会压住新加的图例带。
function prepareExportSvg(svg, extraHeight) {
    const clone = svg.cloneNode(true);
    const box = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const rect = svg.getBoundingClientRect();
    let vbX = 0, vbY = 0, vbW, vbH;
    if (box.length === 4 && box.every(n => isFinite(n))) {
        [vbX, vbY, vbW, vbH] = box;
    } else {
        vbW = Number(svg.getAttribute('width')) || rect.width || 800;
        vbH = Number(svg.getAttribute('height')) || rect.height || 400;
    }
    const totalH = vbH + extraHeight;
    clone.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${totalH}`);
    clone.setAttribute('width', String(vbW));
    clone.setAttribute('height', String(totalH));
    clone.style.height = '';
    return { clone, vbX, vbY, vbW, vbH, totalH };
}

function attachExportLegend(prep, items, axisNote, shape, provenanceLines) {
    if (!items.length && !axisNote && !(provenanceLines || []).length) return;
    const NS = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(NS, 'g');
    const x0 = prep.vbX + 24;
    const lineH = exportLegendLineHeight();
    let y = prep.vbY + prep.vbH + 26;

    const addText = (x, ty, size, fill, content) => {
        const text = document.createElementNS(NS, 'text');
        text.setAttribute('x', String(x));
        text.setAttribute('y', String(ty));
        text.setAttribute('font-size', String(size));
        text.setAttribute('fill', fill);
        text.textContent = content;
        g.appendChild(text);
    };

    items.forEach(item => {
        if (shape === 'line') {
            const seg = document.createElementNS(NS, 'line');
            seg.setAttribute('x1', String(x0));
            seg.setAttribute('x2', String(x0 + 16));
            seg.setAttribute('y1', String(y - 4));
            seg.setAttribute('y2', String(y - 4));
            seg.setAttribute('stroke', item.color);
            seg.setAttribute('stroke-width', '2');
            if (item.dash) seg.setAttribute('stroke-dasharray', item.dash);
            g.appendChild(seg);
        } else {
            const swatch = document.createElementNS(NS, 'rect');
            swatch.setAttribute('x', String(x0));
            swatch.setAttribute('y', String(y - 11));
            swatch.setAttribute('width', '12');
            swatch.setAttribute('height', '12');
            swatch.setAttribute('rx', '3');
            swatch.setAttribute('fill', item.color);
            g.appendChild(swatch);
        }
        addText(x0 + 22, y, 12, '#2f2a23', item.name);
        y += lineH;
    });

    if (axisNote) {
        // 轴说明是整句，折行免得一行横穿整张图；行数由 wrapAxisNote 决定，
        // 与上面 exportLegendBandHeight 用的是同一个函数，不会对不上
        wrapAxisNote(axisNote).forEach(line => {
            addText(x0, y, 11, '#5c5346', line);
            y += lineH;
        });
    }

    if ((provenanceLines || []).length) {
        // 与上面那段之间留半个行高。这里的间距必须和 exportLegendBandHeight 里
        // 加的那半个行高是同一个数：一边加一边不加，署名就会压着轴说明最后一行。
        y += lineH / 2;
        provenanceLines.forEach(line => {
            // 比轴说明再小一档、淡一档：它是署名，不该跟图例抢注意力
            addText(x0, y, 10, '#8a8172', line);
            y += lineH;
        });
    }

    g.setAttribute('class', 'export-legend');
    prep.clone.appendChild(g);
}

// 把图例和轴说明拼上去，返回可直接序列化的 svg 副本
function buildExportSvg(svg) {
    const legend = collectExportLegend();
    const axisNote = collectExportAxisNote();
    // 署名行折几行取决于画布多宽，而宽度由 prepareExportSvg 从 viewBox 里读出来。
    // 所以先跑一遍 prepareExportSvg(svg, 0) 只为拿宽度——它只克隆、不写盘，多跑一次
    // 的代价远小于「宽度判断各写一份」带来的漂移（viewBox 的解析规则已经有几处依赖了）。
    const probe = prepareExportSvg(svg, 0);
    // 署名行只算一次，算高和画字用同一份：分头各折一次行，一旦折出来的行数不同，
    // 图例带就会少一截或多一截（这条教训轴说明那里已经吃过一次）。
    const provenanceLines = exportProvenanceLines(probe.vbW);
    const extra = exportLegendBandHeight(legend.items, axisNote, provenanceLines);
    const prep = prepareExportSvg(svg, extra);
    attachExportLegend(prep, legend.items, axisNote, legend.shape, provenanceLines);
    return prep;
}

function serializeExportSvg(prep) {
    let source = new XMLSerializer().serializeToString(prep.clone);
    if (!source.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)) {
        source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    return source.replace('</svg>', EXPORT_SVG_STYLE + '</svg>');
}

function exportChart() {
    const target = getExportTarget();
    const svg = target.element;
    if (!svg) {
        showError(getNoChartMessage());
        return;
    }

    const prep = buildExportSvg(svg);
    const imageSrc = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serializeExportSvg(prep));

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const img = new Image();

    // 画布尺寸取 viewBox 而不是屏幕上的 getBoundingClientRect()：
    // viewBox 才是这张图自己的坐标系，加了图例带之后两者的高度不再相等。
    const scaleFactor = 2;
    canvas.width = prep.vbW * scaleFactor;
    canvas.height = prep.totalH * scaleFactor;

    img.onload = function() {
        context.fillStyle = '#f2e7cd';
        context.fillRect(0, 0, canvas.width, canvas.height);
        
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        const link = document.createElement('a');

        link.download = `文印_${exportFileLabel()}_${target.label}_${exportTimestamp()}.png`;
        link.href = canvas.toDataURL('image/png');
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // 回执必须放在 onload 里（第四十二批）：放到函数末尾会在这张图还没转成 PNG、
        // 下载还没开始时就说「已导出」，失败时反而什么都没提示。
        flashExportReceipt(document.getElementById('exportBtn'), '图片已导出（PNG），在浏览器的「下载」列表里。');
    };

    img.onerror = function(e) {
        console.error("图像导出失败:", e);
        // 「请查看控制台详情」对读者是天书——他不知道控制台是什么，也看不到（第三十五批）。
        // 详情仍在上一行的 console.error 里；给读者的这句改成他真能做的下一步。
        showError("图像生成失败，请稍后重试；如果一直失败，换个观察角度再导出。");
    };

    img.src = imageSrc;
}

// 「用词重复度」与「独特词丰富度」是一枚硬币的两面（第四十批写在指标说明里）。
// 它必须跟着结论走（第四十二批）：读者多半一次只导一个角度，拿两份文件当成两条独立证据，
// 而这两份说的本来就是同一件事。指标说明在屏幕上那一格里，导出文件的人看不到它；
// 「复制结论」的尾注与导出摘要原来也都没有这一句。只在这两个角度下说——其余角度下它是噪音。
function crossMetricNote(metric = currentMetric) {
    if (metric !== 'simpsonIndex' && metric !== 'hapaxLegomena') return '';
    return '「用词重复度」与「独特词丰富度」是同一件事的两面：量的是用词多样不多样，'
        + '一个高另一个就低，两份结果不宜当成两条独立的证据。';
}

function exportSummary() {
    // 用 getExportBooks() 而不是直接读 selectedBooks：「全书对比」页上的书籍筛选
    // 也要算数，否则点掉的书仍会在摘要里占一整节
    const books = getExportBooks();
    if (books.length === 0) {
        const pool = getActiveBookSet();
        if (!realData || !pool || pool.size === 0) {
            showError('当前没有可导出的分析数据。请先选择书籍或上传文本。');
        } else {
            showError('当前选择的书籍暂时没有可用于这个「观察角度」的数据，请更换「观察角度」，或更换书籍后重试。');
        }
        return;
    }

    const metricLabel = getMetricLabel(currentMetric);
    const metricHint = {
        sentenceLength: '一句话平均几个词。',
        simpsonIndex: '数值越高，用词越重复。',
        hapaxLegomena: '由「总词数、不同词的个数、只出现过一次的词数」综合算出，不是 0–1 的比例；数值越大用词越丰富。对篇幅的依赖很弱（公式里篇幅取的是对数），字数相差不大的书可直接比。',
        functionWords: `由高频小词${getAxisWordsHint()}的使用习惯得出，仅作参照。`
    }[currentMetric] || '';
    const contextLine = getMetricContextLine(currentMetric);
    const crossNote = crossMetricNote(currentMetric);
    // 纯文本（.txt）而不是 Markdown：这份摘要的读者是文科研究者，打开它的是记事本、
    // Word 或 Word 里的「插入文件」；满屏 # 和 > 在那些地方是噪音，不是格式。
    // 分隔用一条等长横线，小标题用【】，两者在任何纯文本编辑器里都读得通。
    const lines = [
        '文印·文学指纹分析摘要',
        '════════════════════════════════════════',
        '',
        `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
        `- 当前视图：${currentTab === 'view-main' ? (chartType === 'line' ? '基础趋势分析 · 折线趋势图' : '基础趋势分析 · 指纹热力图') : currentTab === 'view-galaxy' ? '风格星系' : '全书对比'}`,
        `- 观察角度：${metricLabel}`,
        `- 怎么理解：${metricHint}`,
        `- 统计范围：${describeExportScope()}`,
        // 这句话自己的小标题就是「参考区间：…」，而这一行的字段名又叫「解读参考」，
        // 于是导出里出现「解读参考：参考区间：…」两个「参考」叠在一起（第四十四批）。
        // 屏幕上只有这句话、没有字段名，所以不能去改那句共享的串——只在导出这一行把句内
        // 小标题去掉，让字段名当标题。
        ...(contextLine ? [`- 解读参考：${contextLine.replace(/^参考区间：/, '')}`] : []),
        ...(crossNote ? [`- 指标关系：${crossNote}`] : []),
        `- 选择书籍：${books.map(getBookDisplayName).join('、')}`,
        `- 在线视图（打开即还原本次选择）：${buildStateUrl({ shareable: true })}`,
        // 这条链接有两件事必须跟着一起说，否则收件人打开会看到另一份分析而摘要里
        // 一个字都不解释：本机地址别人打不开；自己上传的书不在别人的服务器上。
        ...buildShareCaveats(),
        ''
    ];

    // 结论区。屏幕上「一句话解读」「值得一看的片段」是用户最想带走的东西，
    // 之前摘要里一个字都没有，只能手抄。放在每本书的明细**前面**——它是结论，不是附录。
    // 这两块由「全书对比」页的渲染函数顺手存下来（d3-charts.js 顶上的
    // lastInsightLines / lastAnomalyReports），没进过那个页签时是空的。原来空着就
    // 整节跳过，导出的摘要于是**静默地**少掉两节最值钱的内容，读的人只会以为
    // 这次分析没结论。屏幕上的「复制结论」按钮遇到同样的情况会说一句话
    // （见 copyConclusion），导出物里也得说，而且要说清怎么办。
    //
    // 为什么不在导出时顺手算一遍：算这两节要先把「全书对比」的数据拉下来并渲染，
    // 那是一次用户没要求的加载和一次对他当前页签的界面写入。既有设计已经选定了
    // 这条路——copyConclusion 也是让用户自己切过去，不是替他切。跟着它走。
    // 两节同因（都是「没进过「全书对比」页」），所以两条路各写一遍同样的三行说明是多余的：
    // 第四十三批改成两节都缺时合成一处说（标题照旧两行，说明只说一次）。
    // 只有一节缺时那份说明与原来逐字节相同。
    const notGeneratedNotice = (both) => both
        ? '这两节本次都没有生成。请先切到「全书对比」页（会自动挑选对比书并算出结论），返回后再导出，摘要即会包含这两节。'
        : '这一节本次没有生成。请先切到「全书对比」页（会自动挑选对比书并算出结论），返回后再导出，摘要即会包含这一节。';
    const insightText = buildInsightText();
    const anomalyText = buildAnomalyText();
    if (!insightText && !anomalyText) {
        lines.push('【一句话解读】');
        lines.push('【值得一看的片段】');
        lines.push(notGeneratedNotice(true));
        lines.push('');
    } else {
        if (insightText) {
            lines.push('【一句话解读】');
            lines.push(insightText);
        } else {
            lines.push('【一句话解读】');
            lines.push(notGeneratedNotice(false));
        }
        lines.push('');
        if (anomalyText) {
            lines.push('【值得一看的片段】');
            lines.push(anomalyText);
        } else {
            lines.push('【值得一看的片段】');
            lines.push(notGeneratedNotice(false));
        }
        lines.push('');
    }

    books.forEach(book => {
        // 框选生效时只统计框选内的片段，和屏幕上显示的是同一批
        const allValues = getMetricValues(book, currentMetric);
        const brush = getBrushBlockRange(book);
        const values = brush ? allValues.filter((d, i) => i >= brush.from && i <= brush.to) : allValues;
        lines.push(`【${getBookDisplayName(book)}】`);
        lines.push(`- 参与统计的片段数：${values.length}（全书共 ${getBookBlockCount(book)} 个片段）`);
        if (brush) {
            lines.push(`- 本次统计的片段：第 ${brush.from + 1}–${brush.to + 1} 个片段`);
        }
        if (values.length === 0) {
            // 这本书比框选的区段还短，一个片段都没落进来。不能继续往下算均值。
            lines.push('- 框选范围内没有这本书的片段，本节的均值、最高片段均无法给出。');
            lines.push('');
            return;
        }
        const mean = d3.mean(values, d => d.value);
        const peak = values.reduce((best, current) => current.value > best.value ? current : best, values[0]);
        lines.push(`- 平均水平：${formatMetric(mean)}`);
        lines.push(`- 最高片段：第 ${Number(peak.block) + 1} 个片段，数值 ${formatMetric(peak.value)}`);
        lines.push(`- 片段位置：${formatBlockLocation(book, peak.block)}${formatWordCount(peak.wordCount)}`);
        if (Array.isArray(peak.keywords) && peak.keywords.length > 0) {
            lines.push(`- 最高片段关键词：${peak.keywords.join('、')}`);
        }
        if (peak.preview) {
            lines.push(`- 原文片段：${String(peak.preview).replace(/\r?\n/g, ' ').trim().substring(0, 240)}`);
        }
        lines.push('');
    });

    // 方法说明：写清这次是怎么算的，别人照着能复现
    const methods = buildMethodsParagraph(books);
    if (methods) {
        lines.push('【方法说明】');
        lines.push(methods);
        lines.push('');
    }

    lines.push('说明：本摘要用于记录当前页面的选择。图中的数值与位置只是风格方面的数据，请结合作品原文与具体片段理解，不宜单独当作文学质量高低的评判。');

    downloadBlob(lines.join('\n'), `文印_分析摘要_${exportTimestamp()}.txt`, 'text/plain;charset=utf-8');
    flashExportReceipt(document.getElementById('exportSummaryBtn'), '摘要已导出（.txt），在浏览器的「下载」列表里。');
}

// 「一句话解读」的纯文字版本。内容是页面内那段脚本渲染时存进 lastInsightLines 的，
// 所以这里拿到的永远是屏幕上那几句（含框选口径说明那句），不会另算一套、也就不会打架。
function buildInsightText() {
    const lines = Array.isArray(lastInsightLines) ? lastInsightLines.filter(Boolean) : [];
    return lines.join('\n');
}

// 异常面板脚注里**逐本不同**的那两句，屏幕与导出共用（第十一批、第十五批都吃过
// 「两处各说一套」的亏）。留下的都对着一张统计对象说话：列表有上限、本书有几个片段。
//
// 第四十三批又搬走了一句：「这里的「偏离」只是统计意义上离整体较远……不代表写得好或不好。」
// 它逐字相同、每本书各印一遍（两本书就是两遍），说的是所有书共有的一层意思，
// 已并入 ANOMALY_GLOBAL_NOTE（见下），和「不做显著性判断」一起整份只说一次。
function anomalyNotes(report) {
    const notes = [];
    // 接口把 items 截断到 8 条，counts.total 才是「一共找出多少个」。
    // 不说这一句，读者会把列出的这 8 条当成全集，写成「全书共 8 个偏离片段」。
    if (report && isFiniteNumber(report.flagged) && report.flagged > report.items.length) {
        notes.push(`本书共找出 ${report.flagged} 个偏离片段，这里按偏离程度只列出最靠前的 ${report.items.length} 个。`);
    }
    // 片段是 blockSize/overlap 的滑窗切出来的，相邻两条共享九成原文。
    // 在近重复的序列上算 ±2σ，那个「2 个标准差」就不再是它字面上给人的「罕见」了。
    // 这一段只留「本书有几个片段、重叠多少词」这两个逐本不同的数（第四十二批）。
    // 原来后半截「所以它只适合用来挑原文，不构成显著性结论」也在这一句里，
    // 两本书就是两遍几乎逐字重复的免责话——现在提升成整份输出末尾的一句（见 ANOMALY_GLOBAL_NOTE）。
    if (report && report.blockCount > 0) {
        const overlapPart = isFiniteNumber(report.overlap) && report.overlap > 0
            ? `，相邻片段之间重叠约 ${report.overlap} 词`
            : '，相邻片段之间有大段重叠';
        notes.push(`本书共 ${report.blockCount} 个片段${overlapPart}。`);
    }
    return notes;
}

// 「值得一看的片段」整份输出末尾的那一句（第四十二批），第四十三批又并进来一句。
// 它说的是所有书共有的一层意思——「偏离」只是描述性的、片段是重叠滑窗切出来的、
// 本工具不做显著性判断——所以整份只说一次，不再逐本重复（两本书时原来各说两遍）。
// 屏幕上的异常面板与导出物（buildAnomalyText）用的是同一个常量，两处不可能各说一套。
const ANOMALY_GLOBAL_NOTE = '上面这些片段的「偏离」只是统计意义上离整体较远'
    + '（离均值超过 2 个标准差，或超出四分位距范围），不代表写得好或不好。'
    + '它们是相邻重叠的滑窗切出来的，不能当成互相独立的样本；'
    + '本工具不做显著性判断，只用于辅助定位原文片段，不构成「显著偏离」的结论。';

// 「值得一看的片段」的纯文字版本，同样取自屏幕上那一份（lastAnomalyReports）。
// 还没加载出来（没进「全书对比」页）时返回空串，调用方据此跳过这一节——
// 宁可不说，也不要在导出物里编一段屏幕上没有的话。
// 但「取不到」和「没去看过」是两回事：前者屏幕上已在面板里说明了原因，
// 导出物里也必须写出来，否则读的人只会以为这本书没有偏离片段。
// 屏幕上是逐本一块，这里就是逐本一段，中间空一行隔开；只选一本书时输出与以前逐字节相同。
function buildAnomalyText() {
    const reports = Array.isArray(lastAnomalyReports) ? lastAnomalyReports.filter(Boolean) : [];
    if (reports.length === 0) return '';
    const body = reports.map(anomalyTextForReport).filter(Boolean).join('\n\n');
    if (!body) return '';
    // 整份只说一次的那句口径（第四十二批），和屏幕上那块面板用的是同一个常量。
    // 只在真有片段列表时才加：全都「没有特别偏离的片段」时，这句解释不指向任何东西。
    const hasItems = reports.some(r => !r.failed && Array.isArray(r.items) && r.items.length > 0);
    return hasItems ? `${body}\n\n  说明：${ANOMALY_GLOBAL_NOTE}` : body;
}

function anomalyTextForReport(report) {
    if (!report) return '';
    const head = `《${report.displayName}》（观察角度：${report.metricLabel}）`;
    if (report.failed) {
        return `${head}\n  这一节这次没有生成：${report.reason}`;
    }
    if (!Array.isArray(report.items)) return '';
    // 「均值来自 /api/analysis、不随框选变」这件事必须在导出物里也说一遍，
    // 否则读者会把这里的平均和「整体水平对比」上那个被框选改过的数当成同一个。
    const scopeNote = report.brushScoped ? '，不受框选影响' : '';
    const meanPart = Number.isFinite(report.mean) ? `，比全书平均（${formatMetric(report.mean)}${scopeNote}）` : '';
    if (report.items.length === 0) {
        return `${head}\n它在这个角度上整体比较均匀，没有特别偏离的片段。`;
    }
    const blocks = report.items.map(item => {
        const value = Number(item.value);
        const dirText = Number(item.zScore) > 0 ? '偏高' : '偏低';
        const location = (typeof formatBlockLocation === 'function')
            ? formatBlockLocation(report.book, item.block)
            : `第 ${Number(item.block) + 1} 个片段`;
        const out = [
            `  ${dirText} · ${location}`,
            `    ${report.metricLabel} ${Number.isFinite(value) ? formatMetric(value) : ''}`
                + (meanPart ? `${meanPart}${dirText} ${formatMetric(Math.abs(report.mean - value))}` : '')
        ];
        if (item.preview) out.push(`    原文：“${String(item.preview).replace(/\r?\n/g, ' ').trim()}”`);
        if (Array.isArray(item.keywords) && item.keywords.length) out.push(`    关键词：${item.keywords.join('、')}`);
        return out.join('\n');
    });
    blocks.push(`  说明：${anomalyNotes(report).join('')}`);
    return [head, ...blocks].join('\n');
}

// 「复制结论」：把「一句话解读」和「值得一看的片段」一起复制成纯文字，直接粘进笔记。
// 两块口径不同（解读跟着框选走、异常片段固定按全书），所以各占一段，不混成一句。
function copyConclusion(button) {
    const parts = [buildInsightText(), buildAnomalyText()].filter(Boolean);
    if (parts.length === 0) {
        setGlobalStatus('notice', '现在还没有可复制的结论。请切到「全书对比」页，选择书籍后这里就会生成解读。');
        return;
    }
    const header = `文印·文学指纹分析 · 结论（观察角度：${getMetricLabel(currentMetric)}；统计范围：${describeExportScope()}）`;
    // 出处尾注（第四十批）。原来复制出来的这段只有标题加正文——没有时间、没有链接、
    // 没有模型编号、没有「看的是哪几本」。这段文字是拿去粘进笔记、发进群、写进论文的，
    // 半个月后连「当时比的是哪两本」都要猜。尾注与导出摘要逐字一致（同一次导出、
    // 同一个口径），所以这里直接复用摘要那套函数，不另写一份。
    const books = getExportBooks();
    const footer = [
        `生成时间：${new Date().toLocaleString('zh-CN')}`,
        `选书与数据版本：${describeCorpusVersion(books)}`,
        buildComparabilitySentence(books),
        // 跨指标提醒（第四十二批）：结论会被复制走、单独立档，这一句必须跟着走，
        // 否则同一件事的两个角度会被当成两条独立证据（与导出摘要里那句同源）。
        crossMetricNote(),
        `统计范围：${describeExportScope()}`,
        `在线视图：${buildStateUrl({ shareable: true })}${localUrlNote()}${unsharedUploadedNote()}`
    ].filter(Boolean).join('\n');
    copyTextToClipboard([header, '', parts.join('\n\n'), '', '——', footer].join('\n'), button, '✓ 结论已复制');
}

// ==========================================
// ⤓ 导出：数据表 / 引用 / 矢量图
// ==========================================

function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const link = document.createElement('a');
    link.download = filename;
    link.href = URL.createObjectURL(blob);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

// 导出文件名里的时间戳。**用本地时间，不用 toISOString()。**
//
// toISOString() 给的是 UTC。北京时间比 UTC 早 8 小时，于是上午 8 点前导出的文件，
// 文件名里的日期是**前一天**：2026-10-09 凌晨 2 点导出的 PNG 会叫
// 「…_2026-10-08T18-20-00.png」。而同一份导出里的文本摘要、CSV 注释行写的都是
// `new Date().toLocaleString('zh-CN')`（本地时间）——摘要说 10 月 9 日、文件名说 10 月 8 日，
// 同一次导出的产物互相打架。文件名里带日期本来就是为了「一眼认出这是哪次导出的」，
// 差一天正好把这点用处抵消掉。
//
// 格式保持原样（ISO 样式、冒号点号换成横线、截到秒）：用 - 分隔在 Windows/macOS/Linux
// 上都合法，顺序也仍然可排序。只换时区，换的是那两个数字的来源。
//
// 全项目只有这一个地方生成导出时间戳——画图那条路径原来自己又写了一遍同款表达式，
// 两处一起漂移的可能性比只留一处大得多。
function exportTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        + `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// 当前屏幕上真正参与分析的那几本书。
// 选书全项目只有一份 selectedBooks：顶部书名按钮与「全书对比」页的 chips 读写的是
// 同一个集合，所以这里不需要再按标签页分情况。导出与分享链接一律以它为准，于是同一份
// 导出里的「选择书籍」与「解读参考」必然同源，不会再出现一个说 1 本、一个说 2 本。
function getActiveBookSet() {
    return selectedBooks;
}

// 导出的书名清单：当前选中、且在这个观察角度下确实有数据
function getExportBooks() {
    const source = getActiveBookSet();
    if (!realData || !source || source.size === 0) return [];
    return Array.from(source).filter(book => getMetricValues(book, currentMetric).length > 0);
}

// 「全书对比」页上走势图被框选的范围（0–1 的阅读进度比例）；没框选时返回 null。
// 那一页的均值、片段数都按这个范围算，导出必须跟着走——否则同一份分析在屏幕上
// 和导出物里是两个数，用户把导出的数字贴进论文就会和图上看到的对不上。
function getActiveBrushRange() {
    try {
        if (typeof advState === 'undefined' || !advState) return null;
        const range = advState.brushRange;
        if (!Array.isArray(range) || range.length !== 2 || !range.every(isFiniteNumber)) return null;
        const lo = Math.max(0, Math.min(range[0], range[1]));
        const hi = Math.min(1, Math.max(range[0], range[1]));
        return hi > lo ? [lo, hi] : null;
    } catch (e) {
        return null; // advState 定义在页面内的另一段脚本里，取不到就当作没框选
    }
}

// 框选范围换算成某本书的片段下标区间。用的是屏幕上那套算法：
// 第 i 个片段的 xPercent = i / (片段数 - 1)，落在 [min, max] 内才算选中。
// 片段下标与块下标是同一个编号（四个指标每个块各一条记录）。
function getBrushBlockRange(bookName) {
    const range = getActiveBrushRange();
    if (!range) return null;
    const len = getMetricValues(bookName, currentMetric).length;
    if (!len) return { from: 0, to: -1, count: 0 };
    const denom = len - 1 || 1;
    const from = Math.ceil(range[0] * denom);
    const to = Math.floor(range[1] * denom);
    return { from, to, count: Math.max(0, to - from + 1) };
}

// 导出物里那句范围说明：框选时点名范围，没框选时明写「全书」
function describeExportScope() {
    const range = getActiveBrushRange();
    if (!range) return '全书全部片段';
    return `走势图框选的 ${(range[0] * 100).toFixed(1)}%–${(range[1] * 100).toFixed(1)}% 区段（与「全书对比」页上的数字同一口径）`;
}

// 导出物里的「这次算的是哪一份数据」（第四十批）。内置示例书取自随工具发布的固定版本，
// 用户上传的文本各有各的来源与版本；要把两者分开说，否则读者会以为「内置书」也是他给的。
//
// 语料指纹（第四十批加，第四十六批改对）：服务端现在算的是整份语料的**内容**
// （见 api_server 的 _corpus_content_digest），所以「内容一变它就变」这句才成立。
// 原来服务端算的是文件的修改时间与大小，这句话与实现不符——文件重新生成过而内容没改，
// 指纹也会变；两台机器上同一份内容反倒给出两个指纹。整份语料共用一个指纹，不是每本书各一个。
//
// 「本次导出含内置示例书 N 本」改成「本次分析用到的…」（第四十六批）：同一个摘要里
// 「内置示例书」还出现在「参考区间：内置示例书（4 本）」那一句，一处指「这次分析的两本」、
// 一处指「服务器上常驻的四本」，同一个词指两件事。两边各加一个限定词分开。
function describeCorpusVersion(books) {
    const names = Array.isArray(books) ? books : [];
    const builtinCount = names.filter(name => builtinBookNames.includes(name)).length;
    const uploadedCount = names.length - builtinCount;
    const composition = `本次分析用到内置示例书 ${builtinCount} 本`
        + (uploadedCount > 0 ? ` + 你自己上传的 ${uploadedCount} 本` : '');
    const fingerprint = corpusFingerprint ? `语料指纹 ${corpusFingerprint}` : '语料指纹未记录';
    return `${composition}；${fingerprint}。这个指纹是服务端按整份语料的「内容」算的，不是文件的修改时间：内容一样它就不变，内容一变它就变。整份语料共用一个指纹，不是每本书各有一个。`;
}

// 正文起点（第四十批）。内置书取自 Project Gutenberg，本书自己的书名页和目录留在正文之前，
// 第 0 格因此把书名页与目录也算进去了（实测 Tom Sawyer 正文从第 984 个词起、Huckleberry Finn
// 从第 1190 个词起；清洗管线只剥 Gutenberg 的授权声明，不剥书名页）。这条规则不改——改了会
// 让所有「起始词位置」平移——但要把偏移量交给读者：拿片段位置回原文核对时先减掉它。
function describeFrontMatter(books) {
    const items = (Array.isArray(books) ? books : []).map(name => {
        const meta = normalizeBookMeta(name);
        const first = meta && Array.isArray(meta.chapters) && meta.chapters.length > 0 ? meta.chapters[0] : null;
        const start = first && isFiniteNumber(first.wordStart) ? first.wordStart : 0;
        return { name, start };
    });
    const withFrontMatter = items.filter(item => item.start > 0);
    if (withFrontMatter.length === 0) {
        return '各书正文之前没有识别到书名页或目录；「起始词位置」仍可能与原文词序有细微出入，核对时请以片段原文为准。';
    }
    const listed = withFrontMatter
        .map(item => `《${getBookDisplayName(item.name)}》正文从第 ${item.start + 1} 个词开始`)
        .join('、');
    return `${listed}（之前的书名页、目录等前置内容也计入了分析）。拿「起始词位置」回原文核对时，请先减掉这段偏移。`;
}

// 按片段序号取出某指标的原始条目（按 block 对齐，避免四个指标之间错位）
function getBlockSeriesMap(bookName, metric) {
    const map = new Map();
    const series = realData && realData[bookName] ? realData[bookName][metric] : null;
    if (Array.isArray(series)) {
        series.forEach(item => {
            if (item && isFiniteNumber(item.block)) map.set(Number(item.block), item);
        });
    }
    return map;
}

// 选中书籍的共同坐标基底。
//
// 关键点：判定必须落在「本次选中的每一本」上。旧写法先 filter 掉没有投影的书
// （v1 数据没有 projection 字段）再判断剩下的全共享，于是混选一本旧书时
// 摘要照样宣称「各书坐标落在同一基底上，可直接比较」——当着旧书的面说假话。
function getSharedProjection(books) {
    const entries = books.map(name => {
        const meta = normalizeBookMeta(name);
        return { name, projection: meta ? meta.projection : null };
    });
    const legacy = entries.filter(e => !e.projection || e.projection.mode !== 'shared' || !e.projection.modelId);
    const modelIds = new Set(entries.map(e => e.projection && e.projection.modelId).filter(Boolean));
    const allShared = entries.length > 0 && legacy.length === 0 && modelIds.size === 1;

    return {
        model: allShared ? entries[0].projection : null,
        allShared,
        legacyBooks: legacy.map(e => e.name),
        mixedModels: legacy.length === 0 && modelIds.size > 1
    };
}

// 跨书比较是否成立，用一句话说清楚；不成立时点名是哪几本拖了后腿
function buildComparabilitySentence(books) {
    const { model, allShared, legacyBooks, mixedModels } = getSharedProjection(books);
    if (allShared) {
        const ratio = (model.explainedVarianceRatio || []).map(v => `${(v * 100).toFixed(1)}%`).join(' / ');
        return `功能词投影由统一的坐标模型计算（模型编号 ${model.modelId}${ratio ? `，前两个主成分解释方差 ${ratio}` : ''}），因此各书的坐标落在同一基底上，可直接比较。`;
    }
    if (legacyBooks.length > 0) {
        const names = legacyBooks.map(name => `《${getBookDisplayName(name)}》`).join('、');
        return `功能词投影由统一的坐标模型计算，但${names}是旧版数据、没有共同坐标基准，${legacyBooks.length > 1 ? '这几本' : '这一本'}的坐标不参与跨书比较；其余书之间可直接比较。`;
    }
    if (mixedModels) {
        return '选中的书来自不同的坐标模型，坐标没有落在同一基底上，不宜跨书解读。';
    }
    return '功能词坐标由各书单独拟合，只可在同一本书内部比较，不宜跨书解读。';
}

// 方法说明（自动生成）：把这次分析用的参数如实写下来，别人照着能复现
function buildMethodsParagraph(books) {
    const metas = books.map(name => normalizeBookMeta(name)).filter(Boolean);
    if (metas.length === 0) return '';

    const blockSizes = Array.from(new Set(metas.map(meta => meta.blockSize)));
    const steps = Array.from(new Set(metas.map(meta => meta.step)));
    const totalBlocks = metas.reduce((sum, meta) => sum + (meta.totalBlocks || 0), 0);
    const chapterCounts = metas.map(meta => (meta.chapters ? meta.chapters.length : 0)).filter(n => n > 0);

    const parts = [];
    parts.push(`本次分析使用「文印」文学指纹工具，共分析 ${books.length} 本书、${totalBlocks} 个片段。`);
    // 判据是「文本里有没有那对标记」，不是「来自哪里」（第四十批加，第四十六批改准）。
    // 原来写「若来自 Project Gutenberg，另清理其页眉页脚（其它来源的文本原样保留）」，
    // 而对一本上传的 Gutenberg 版文件，它照样会被剥掉——那句话对它是假话。clean_text 的
    // 判断条件本来就只看标记，照实写。
    parts.push(`文本统一空白、还原常见缩写；此外，只有文本里带 Project Gutenberg 起始/结束标记的文件才会再剥掉它的授权声明那一段（这一步看的是文件里有没有这对标记，不按来源分）。按每片段 ${blockSizes.join('/')} 词、相邻片段重叠 ${blockSizes.map((size, i) => size - steps[i]).join('/')} 词的滑动窗口切分。`);
    // 缩写还原到底还原了哪些（第四十批）。这句话原来只说「还原常见缩写」，而它直接改平均句长：
    // it's 算一个词，展开成 it is 就是两个词，一句话的词数随之变大。规则是固定有限的一批
    // （源码里是 30 条，见 src/data_loader.py 的 CONTRACTIONS），把范围写出来，别人才能照着复现这一步。
    // 这一条原来把源码文件名写进了读者看到的那句话里（「完整清单见 data_loader.py 的 CONTRACTIONS」），
    // 而读它的是文学老师（第四十二批）——改成说清条数，不再给读者递文件名。
    parts.push('其中「还原常见缩写」指把固定的一批英语缩写展开成完整形式（如 isn\'t → is not、'
        + 'can\'t → cannot、it\'s → it is、let\'s → let us），共 30 条；'
        + '这一步会让每句话的词数变多、平均句长随之变大，是它与其他工具结果对不上的常见原因之一。');
    // 断句规则（第四十二批）。上面把空白处理、缩写还原、滑窗切分都交代了，唯独没写句子是怎么切的，
    // 而「平均句长 = 词数 ÷ 句数」里的分母完全由这一步决定——不写，读者拿同一个文本也复现不出同一个数。
    // 括号里的句数取自 src/data_loader.py 的实测注释（_normalize_quotes），照实写给读者。
    parts.push('句子按英语标点切分（用 NLTK 的 Punkt 断句模型，Mr. 这类缩写不会被误当成句末）。'
        + '从 Word、PDF、网页里复制出来的英文，引号大多是弯引号（’ “ ”），会先统一成直引号再切句——'
        + '不归一的话，引号挡在句末标点前面，一整段对话会被算成一句话：'
        + '《汤姆·索亚历险记》修好之前只切出 3666 句，修好后是 4912 句，少了约三分之一，'
        + '平均句长随之虚高，而它正是本工具默认的观察角度。');
    // 词是怎么数出来的（第四十六批）。上面把句子怎么切（分母）交代了，唯独没写词怎么切
    // （分子）——而平均句长就是词数除以句数。第四十二批补断句那句的理由，对分子一字不差
    // 地同样成立：不写，读者拿同一个文本也复现不出同一个数。规则取自 src/metrics.py 的
    // _clean_tokens，照实写给读者，不引用文件名。
    parts.push('词是这样数的：文本先转小写、用 NLTK 的英语分词器切词，只保留全字母的词——'
        + '数字与标点都不计入，所有格也只算词干（Tom\'s 只算 Tom 一个词）。');
    // 小词表是哪一套（第四十六批）。四个指标里只有功能词投影依赖一张外部词表，
    // 换一张词表整张图都会变，而说明里原来一个字没提。
    // 不写死词表里有多少个：那个数跟着 NLTK 版本走，写死等于给一个会过期的事实。
    parts.push('功能词二维投影用的词表是 NLTK 的英语停用词表（the / of / he 这类小词），'
        + '每个片段按这些小词在该片段里的相对出现次数投影。');
    parts.push('计算指标包括平均句长、用词重复度（Simpson\'s D）、独特词丰富度（Honoré R）与功能词二维投影。');
    parts.push(buildComparabilitySentence(books));
    // 三个标量能不能跨书比（第四十批）：原来的可比较性说明只讲了功能词投影。
    parts.push(buildScalarComparabilityNote(books));
    // 正文起点（第四十批）：内置书的名著把书名页与目录留在了正文前面，第 0 格把它们也算了进去。
    parts.push(describeFrontMatter(books));
    if (chapterCounts.length > 0) {
        parts.push(`章节边界由章节标题自动识别（本次识别到 ${chapterCounts.join('、')} 章），用于定位片段所在的章节；章号是识别结果，不是人工标注的章号。`);
    }
    parts.push(`数据版本：${describeCorpusVersion(books)}`);
    parts.push(`生成时间：${new Date().toLocaleString('zh-CN')}。在线视图：${buildStateUrl({ shareable: true })}${localUrlNote()}${unsharedUploadedNote()}。`);
    return parts.join('');
}

// 导出数据表（CSV）：每个片段一行，四个指标并列，可直接用 Excel / R / SPSS 打开
function exportTableData() {
    const books = getExportBooks();
    if (books.length === 0) {
        showError('当前没有可导出的分析数据。请先选择书籍或上传文本。');
        return;
    }

    const header = ['书名', '片段序号', '所在章节', '起始词位置', '平均句长', '用词重复度', '独特词丰富度', '风格走向_横轴', '风格走向_纵轴', '关键词'];
    const rows = [header];

    books.forEach(book => {
        const meta = normalizeBookMeta(book);
        const totalBlocks = getBookBlockCount(book);
        const series = {
            sentenceLength: getBlockSeriesMap(book, 'sentenceLength'),
            simpsonIndex: getBlockSeriesMap(book, 'simpsonIndex'),
            hapaxLegomena: getBlockSeriesMap(book, 'hapaxLegomena'),
            functionWords: getBlockSeriesMap(book, 'functionWords')
        };

        // 框选生效时只导框选内的片段（屏幕上的均值就是按这些片段算的）
        const brush = getBrushBlockRange(book);
        for (let i = 0; i < totalBlocks; i += 1) {
            if (brush && (i < brush.from || i > brush.to)) continue;
            const chapter = getBlockChapter(book, i);
            const words = series.functionWords.get(i) || series.sentenceLength.get(i) || {};
            const value = (key) => {
                const item = series[key].get(i);
                return item ? formatExportNumber(item.value) : '';
            };
            const style = series.functionWords.get(i);
            rows.push([
                getBookDisplayName(book), // 表头是「书名」，与摘要/参考文献里的中文名保持一致
                String(i + 1),
                chapter ? `${chapterLabel(chapter)} ${chapterTitle(chapter)}` : '',
                meta ? String(i * meta.step + 1) : '', // 起始词位置从第 1 个词数起
                value('sentenceLength'),
                value('simpsonIndex'),
                value('hapaxLegomena'),
                formatExportNumber(style && style.value),
                formatExportNumber(style && style.value_y),
                Array.isArray(words.keywords) ? words.keywords.join(' ') : ''
            ]);
        }
    });

    const body = rows.map(row => row.map(cell => {
        const text = String(cell ?? '');
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(',')).join('\r\n');

    // 表头前的注释行：滑动窗口是重叠切分，相邻片段共享 9000 个词，
    // 不写清楚的话，63 行很容易被当成 63 个互相独立的样本拿去做统计检验。
    // 以 # 开头是 CSV 的通行注释约定（pandas 用 comment='#'、R 用 comment.char='#' 即可跳过）。
    const windowSpecs = Array.from(new Set(books.map(name => {
        const meta = normalizeBookMeta(name);
        return meta && isFiniteNumber(meta.blockSize) && isFiniteNumber(meta.overlap) && isFiniteNumber(meta.step)
            ? `每段 ${meta.blockSize} 词 · 相邻重叠 ${meta.overlap} 词 · 步长 ${meta.step} 词`
            : '窗口参数未知';
    })));
    const comments = [
        '# 文印·文学指纹分析 数据表',
        `# 生成时间：${new Date().toLocaleString('zh-CN')}`,
        `# 数据版本：${describeCorpusVersion(books)}`,
        `# 指标口径：平均句长（词/句）；用词重复度（Simpson，越高越重复）；独特词丰富度（Honoré R，越高用词越丰富）；风格走向_横/纵轴（高频小词用法的二维坐标）`,
        `# 数值精度：全部 4 位有效数字（原始值是分词与滑窗算出来的，再多的位不是真实信息）`,
        `# 统计范围：${describeExportScope()}`,
        `# 片段口径：${windowSpecs.join('；')}。同一段原文会被反复计入，请勿把这些行当作互相独立的样本，按行做显著性检验会高估样本量。`,
        // 章节标签的口径（第四十批）：表里那一列写的是「窗口正中间」落的那一章，
        // 而一格横跨 4–6 章；不说清楚，读者会以为第 1 章没有片段（它确实永远标不到）。
        `# 章节口径：${CHAPTER_LABEL_HINT}`,
        // 正文起点（第四十批）：内置书取自 Project Gutenberg，书名页与目录留在正文之前，
        // 第 0 格因此吃进了它们。把「正文从第几个词开始」写出来，读者才知道偏移量。
        `# 正文起点：${describeFrontMatter(books)}`,
        `# 数据行数：${rows.length - 1}`
    ];

    // 带 BOM：Excel 打开中文 CSV 默认按本地编码解析，没有 BOM 会乱码
    const csv = `${comments.join('\r\n')}\r\n${body}`;
    downloadBlob('﻿' + csv, `文印_数据表_${exportTimestamp()}.csv`, 'text/csv;charset=utf-8');
    flashExportReceipt(document.getElementById('exportDataBtn'), '数据表已导出（.csv），可用 Excel 打开。');
}

// 内置示例书的原著信息。取自 data/raw/ 下各 txt 开头那段 Project Gutenberg 头部
// （Title / Author / Release date / eBook #）；year 是该作品**首次出版**的年份，
// 不是电子版的发布日期——后者写在 note 里，两者别混。
// 只有这四本拿得到原著信息；用户上传的文本没有可靠的作者与版本，不能替他们编一个。
const BUILTIN_BOOK_SOURCES = {
    'the adventures of tom sawyer': {
        key: 'twain1876tomsawyer', author: 'Twain, Mark', authorZh: '马克·吐温', title: 'The Adventures of Tom Sawyer',
        year: 1876, ebook: 74, released: '2004-07-01'
    },
    'the adventures of huckleberry finn': {
        key: 'twain1884huckleberryfinn', author: 'Twain, Mark', authorZh: '马克·吐温', title: 'Adventures of Huckleberry Finn',
        year: 1884, ebook: 76, released: '2004-06-29'
    },
    'the call of the wild': {
        key: 'london1903callofthewild', author: 'London, Jack', authorZh: '杰克·伦敦', title: 'The Call of the Wild',
        year: 1903, ebook: 215, released: '2008-07-02'
    },
    'white fang': {
        key: 'london1906whitefang', author: 'London, Jack', authorZh: '杰克·伦敦', title: 'White Fang',
        year: 1906, ebook: 910, released: '1997-05-01'
    }
};

// 书名 → 原著信息；查不到（用户上传的）返回 null。
// 比对前先去掉首尾空格、转小写：书单的兜底文案里把「The call of the wild」写成了
// 「The Call of the Wild」，大小写不该让一条原著条目凭空消失。
function getBuiltinBookSource(name) {
    if (typeof name !== 'string') return null;
    return BUILTIN_BOOK_SOURCES[name.trim().toLowerCase()] || null;
}

// 把内置书按「作者、再按年份」排一遍（第四十六批）：「参考区间」那句现在要点名这 4 本，
// 按这个顺序排，同作者的两部正好相邻（吐温 1876/1884、伦敦 1903/1906），读者一眼就能
// 看出这四本是「两两同作者」而不是四本互不相干的书。查不到原著信息的排在最后、保持原序。
function sortBuiltinByAuthorThenYear(names) {
    return (Array.isArray(names) ? names.slice() : []).sort((a, b) => {
        const sa = getBuiltinBookSource(a);
        const sb = getBuiltinBookSource(b);
        if (!sa && !sb) return 0;
        if (!sa) return 1;
        if (!sb) return -1;
        if (sa.author !== sb.author) return sa.author < sb.author ? -1 : 1;
        return (sa.year || 0) - (sb.year || 0);
    });
}

// 导出引用条目（BibTeX）：给报告、论文的参考文献用
function exportCitation() {
    const books = getExportBooks();
    if (books.length === 0) {
        showError('当前没有可导出的分析数据。请先选择书籍或上传文本。');
        return;
    }

    // 片段数与摘要/CSV 同口径：有框选时只算框选内的片段
    const totalBlocks = books.reduce((sum, book) => {
        const brush = getBrushBlockRange(book);
        if (brush) return sum + brush.count;
        const meta = normalizeBookMeta(book);
        return sum + ((meta && meta.totalBlocks) || 0);
    }, 0);
    // 只有在选中书共用同一个模型时才敢把模型编号写进条目
    const sharedModel = getSharedProjection(books).model;
    const now = new Date();
    // key 必须唯一：只写年月日的话，同一天导两次（换个观察角度、换几本书）就会撞 key，
    // 文献管理软件会把两条当成同一条。补上时分，再补一个书名首字，尽量不撞。
    const key = `wenxin${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
        + `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
        + (books.length ? `-${books.length}book` : '');
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    // 本机打开时 url 是 localhost，别人点开是打不开的，得在 note 里说清楚
    // 这条 note 会跟着引用条目进文献管理软件、进论文，读它的人不知道 localhost 是什么（第三十五批）。
    // 意思不能丢：本机地址的链接发给同门是打不开的。（第四十批抽成公共函数，
    // 「复制结论」的尾注也用同一句，免得两处各写一份、日后改一处漏一处。）
    const localUrlNoteText = localUrlNote();

    // 原著条目。学生把这段贴进参考文献时，真正要引的是作品本身，不是这个工具；
    // 旧版只发一条 author = 本工具的 @misc，等于把「文印」写成了《白牙》的作者，
    // 而句子长度曲线并不能替原著背书。
    const sources = books.map(name => ({ name, src: getBuiltinBookSource(name) }));
    const knownSources = sources.filter(s => s.src);
    const unknownNames = sources.filter(s => !s.src).map(s => s.name);

    const chunks = [
        '文印 · 引用条目',
        '本文件有两类条目，请勿混用：',
        '  1. @book —— 本次分析用到的内置示例书，引用文学作品本身时用这一条。',
        '     year 是作品首次出版的年份；电子版的来源与发布日期写在 note 里。',
        '  2. @misc —— 本次在线分析记录本身（哪一次、什么参数、跑了哪几本书），不是出版物。',
        ''
    ];

    knownSources.forEach(({ src }) => {
        // 不再写 `publisher = {Project Gutenberg}`（第四十批）：这条的 year 是作品**首次出版**
        // 的年份（1876），而 Project Gutenberg 到 1971 年才成立——两者并排等于说这部小说
        // 1876 年由 Gutenberg 出版。电子版的来源本来就在 note 与 url 里，删掉这个字段即可，
        // 不另填「原始出版社」（那个信息在本书的 Gutenberg 头部里可靠地读不到）。
        chunks.push([
            `@book{${src.key},`,
            `  author    = {${src.author}},`,
            `  title     = {${src.title}},`,
            `  year      = {${src.year}},`,
            `  note      = {电子文本：Project Gutenberg eBook \\#${src.ebook}，发布于 ${src.released}},`,
            `  url       = {https://www.gutenberg.org/ebooks/${src.ebook}}`,
            '}',
            ''
        ].join('\n'));
    });

    if (unknownNames.length > 0) {
        chunks.push(`注：${unknownNames.map(n => `《${getBookDisplayName(n)}》`).join('、')}是你上传的文本，`
            + '本文件没有它的原著条目——上传的文件里读不到作者与版本，替你编一个比空着更糟。请按手上的版本自行补全。');
        chunks.push('');
    }

    // @misc 这条描述的是「本次在线分析」，不是正式出版物。
    // 每个字段末尾都要有逗号（BibTeX 靠逗号分字段，漏一个会整条报错、
    // 丢掉除标题外的全部字段）；最后一行 url 后面不能有逗号。
    chunks.push([
        `@misc{${key},`,
        `  title        = {文印·文学指纹分析记录：${books.map(name => `{${getBookDisplayName(name)}}`).join('、')}},`,
        `  author       = {{文印（文学指纹分析工具）}},`,
        `  year         = {${now.getFullYear()}},`,
        `  month        = {${monthNames[now.getMonth()]}},`,
        `  howpublished = {在线交互式分析（Keim \\& Oelke 2007 指标口径）},`,
        `  note         = {观察角度：${getMetricLabel(currentMetric)}；分析片段数：${totalBlocks}；统计范围：${describeExportScope()}${sharedModel ? `；坐标模型：${sharedModel.modelId}` : ''}${localUrlNoteText}${unsharedUploadedNote()}${knownSources.length ? `；原著条目见本文件开头的 @book` : ''}；本条描述的是本文档生成时的一次在线分析记录，并非正式出版物，正式引用请以原著版本为准},`,
        `  url          = {${buildStateUrl({ shareable: true })}}`,
        '}',
        ''
    ].join('\n'));

    downloadBlob(chunks.join('\n'), `文印_引用_${exportTimestamp()}.bib`, 'application/x-bibtex;charset=utf-8');
    flashExportReceipt(document.getElementById('exportCiteBtn'), '引用条目已导出（.bib），可导入 Zotero / EndNote。');
}

// 导出矢量图（SVG）：论文排版放大不糊
function exportVectorChart() {
    const target = getExportTarget();
    const svg = target.element;
    if (!svg) {
        showError(getNoChartMessage());
        return;
    }

    const source = serializeExportSvg(buildExportSvg(svg));
    downloadBlob(source, `文印_${exportFileLabel()}_${target.label}_${exportTimestamp()}.svg`, 'image/svg+xml;charset=utf-8');
    flashExportReceipt(document.getElementById('exportSvgBtn'), '矢量图已导出（.svg），放进论文放大不失真。');
}

// 顶部全局状态条：三个标签页都能看到。
// 这一批 show* 原来只写 #detailPanel，而 #detailPanel 长在 #view-main 里，
// 于是切到「风格星系」「全书对比」之后，加载失败、分析失败、无数据全是静默的。
let _globalStatusTimer = null;

function setGlobalStatus(kind, message) {
    const el = document.getElementById('global-status');
    if (!el) return;
    if (_globalStatusTimer) { clearTimeout(_globalStatusTimer); _globalStatusTimer = null; }
    if (!message) {
        el.hidden = true;
        el.textContent = '';
        el.className = 'global-status';
        return;
    }
    el.hidden = false;
    el.className = `global-status ${kind || ''}`.trim();
    el.textContent = message;
    // 「成功」「提示」过几秒自己收起，免得一条过期消息一直挂在页面上；
    // 「错误」「加载中」留在原地，等下一次状态更新来替换。
    if (kind === 'success' || kind === 'notice') {
        _globalStatusTimer = setTimeout(() => setGlobalStatus(null, ''), 6000);
    }
}

// 星系图的「正在加载…」占位：成功时隐藏，失败时改成能看懂的原因。
// 不然它那句初始文案会永远留在画布正中间。
function setGalaxyLoading(text) {
    const el = document.getElementById('galaxy-loading');
    if (!el) return;
    if (text === null || text === undefined) {
        el.style.display = 'none';
        return;
    }
    el.style.display = 'block';
    el.textContent = text;
}

// 星系图画不出来（画布里连 svg 都没有）时，把原因写在画布中间，而不是只丢进主视图的详情面板
function showGalaxyError(message) {
    const container = document.getElementById('galaxy-container');
    if (!container || container.querySelector('svg')) return;
    setGalaxyLoading(message);
}

// 加载提示统一带上「可能要等多久」。这一条不能只写在详情卡里：带 ?view=dashboard 的链接
// 进来时 #detailPanel 是隐藏的（它长在 #view-main 里），顶部状态条才是唯一看得见的反馈。
// 而这两个接口的第一次都可能很慢——api_server.py 里 /api/books 和 /api/fingerprint-data
// 都会走 _ensure_demo_data()，首次要现场生成示例数据（那儿的注释写着重算要跑 1~3 分钟），
// 光一句「正在加载数据...」在那三分钟里和没有提示是一样的。
const LOADING_WAIT_HINT = '如果这台服务刚启动，需要先生成示例数据，可能要等 1–3 分钟，页面并未卡住。';

// 「加载中」「出错」这两张状态卡**不参与读屏播报**（aria-hidden），因为同一句话已经由
// 顶部状态条那个 live region 念过一遍了——两块同时可见时，读屏会把整句话连读两遍。
// 判据是「状态条上那条消息会不会比卡片先消失」：setGlobalStatus 只让 success/notice
// 在 6 秒后自己收起，loading 和 error 会一直留到下一次状态更新。所以这两张卡片被摘掉
// 也丢不了信息。反过来，「没有数据」那张卡片不摘：它的状态条 6 秒就没了。
// （第二十批起「成功」那张卡不存在了：数据加载完，右侧面板换成了「先看这 3 段」——
//   那是一块能点进去的内容，不是状态话，所以也不标 aria-hidden。）
// 用 aria-hidden 而不是临时摘掉 #detailPanel 的 role/aria-live：后者要再设回去，而
// 「live region 从非 live 变成 live 时，已有内容算不算一次新播报」各家读屏不一致，
// 一旦判错，正常的片段详情卡（点数据点弹出来的那张）就整个不播了——那是回退，不是修复。
function showLoading(message) {
    setGlobalStatus('loading', `${message} ${LOADING_WAIT_HINT}`);
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;
    detailPanel.innerHTML = `
        <div class="state-card loading" aria-hidden="true">
            <h3>◌ ${escapeHtml(message)}</h3>
            <p>${escapeHtml(LOADING_WAIT_HINT)}</p>
            <div class="state-spinner" aria-hidden="true"></div>
        </div>
    `;
}

function showError(message) {
    setGlobalStatus('error', message);
    showGalaxyError(message);
    // 状态条滚出屏幕外时补一条贴底的提示，否则「点了没反应」。
    // 判断必须放在 setGlobalStatus 之后：是它负责把状态条显示出来的，在那之前量不到它的位置。
    // announce:false——同一句话已经由状态条那个 live region 念过，别让读屏连读两遍。
    if (statusBarOffscreen()) {
        showSelectionNotice(message, { announce: false, duration: 7000 });
    }
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;
    detailPanel.innerHTML = `
        <div class="detail-card state-card error" aria-hidden="true">
            <h3>错误</h3>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
}

function showNoDataMessage(message = '请在上方选择一本已有数据的书，或上传文本进行分析。') {
    setGlobalStatus('notice', message);
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;
    detailPanel.innerHTML = `
        <div class="detail-card state-card empty">
            <h3>暂无数据</h3>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
}

// 详情卡记的是「某个片段在某个指标下的数值」。换过观察角度、换过书之后图会重画，
// 那张卡却原样留着——纵轴已经变成「用词重复度」，卡片里还写着「平均句长 24.97」，
// 看上去就像是当前这张图上的数字。这里把它打回未选择状态，并说明为什么没了。
//
// 只在「指标变了」「选中的书变了」这两处调。换图形（热力图 ↔ 折线）不影响卡里的内容；
// 窗口 resize 更不该把用户刚点开的卡抹掉——那两处都会经过 refreshAllActiveCharts。
//
// 判据用卡里独有的 .block-location，而不是另立一个「现在有没有卡」的变量：写这块面板的
// 地方有六处，多一个要同步的状态就多一个能漂移的地方。加载中/失败的卡没有这个类，不受影响。
function resetDetailPanelIfStale(reason) {
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel || !detailPanel.querySelector('.block-location')) return;
    detailPanel.innerHTML = `
        <h3>▤ 数据详情</h3>
        <p>${escapeHtml(reason)}后，之前选中的那个点已经取消，重新点击即可查看。</p>
    `;
}

// 顶部状态条长在页面最上面。切页签会滚到视图顶部，用户已经在看「全书对比」「风格星系」时，
// 这条消息落在视口上方几百像素处——点「导出图像」失败看上去就像没反应。
// 「看不看得见」是几何问题，就用几何量判断，不另立标志位：滚动位置是唯一的事实来源。
function statusBarOffscreen() {
    const el = document.getElementById('global-status');
    if (!el || el.hidden) return true;
    const rect = el.getBoundingClientRect();
    return rect.bottom <= 1 || rect.top >= window.innerHeight - 1;
}

// ==========================================
// ✧ 风格星系 (Style Galaxy)
// ==========================================

let galaxySimulation = null;
let lastGalaxyTrigger = null;

// 上一次算出来的点位（片段 id → 坐标）。进入星系时，力导向原本每次都从「投影位置」
// 重新起步、跑约 300 次迭代（约 5 秒）才稳定：切页签、换指标、换书、拖窗都要重看
// 一遍这场抖动，而且用户手动拖开的那几个点会被拉回原位。有力导布局就必然要收敛，
// 但没必要每次都从零开始——从上次的结果接着算，几十次迭代就稳了。
// 「↻ 重新布局」按钮会先清空它，那个按钮的承诺（真的重新排一次）因此不受影响。
const galaxyPositions = new Map();

function initStyleGalaxy() {
    // 检查是否可见
    if (currentTab !== 'view-galaxy') return;

    // 说明文案里的轴词例子跟着当前书目走（一本都没选时自动清空，退回泛称）
    renderAxisWordHints();
    // 「大小 = …」跟着当前指标走；放在这里而不是 renderAxisWordHints 里，
    // 那个函数的名字管的是轴词。指标切换会走 refreshAllActiveCharts → 本函数。
    updateGalaxySizeHint();

    const books = Array.from(selectedBooks);
    if (books.length === 0) {
        setGalaxyLoading('请先在上方选择书籍');
        // 这条路径不重建 svg，上一轮那张图还留在容器里（历史行为，本批不改），
        // 但它的名字不能再留着——读屏用户会听到「《白牙》的每个片段……」，
        // 而画面上其实一本书都没选。名字是给当下的图用的，图不换了名字就得撤。
        d3.select("#galaxy-container svg").attr("aria-label", null);
        return;
    }

    // 可比的（同一个坐标基底）才画进同一张图；实在一本可比都没有时，
    // 退回各书各自的坐标来画，只是下面会明确写清「不可直接比较」
    const comparability = getGalaxyComparability(books);
    const independentMode = comparability.plotBooks.length === 0;
    const plotBooks = independentMode ? books : comparability.plotBooks;
    const skippedBooks = new Set(independentMode ? [] : comparability.independentBooks);

    const container = document.getElementById('galaxy-container');
    // 如果容器不可见（clientWidth=0）就先别画，否则会算出一堆 NaN。
    // 但也不能直接 return：刚从别的页签切过来时布局可能还没完成，
    // 一走了之的话「正在加载…」会永远留在画布中间。这里重试有限次，超时就如实说明。
    if (!container || container.clientWidth === 0) {
        const tries = (container && container.dataset.galaxyRetry) ? Number(container.dataset.galaxyRetry) : 0;
        if (!container) return;
        if (tries < 20) {
            container.dataset.galaxyRetry = String(tries + 1);
            requestAnimationFrame(() => initStyleGalaxy());
        } else {
            setGalaxyLoading('图未能绘制：容器尺寸为 0。请切换到其他页签后再返回。');
        }
        return;
    }
    delete container.dataset.galaxyRetry;

    const width = container.clientWidth;
    const height = container.clientHeight;

    d3.select("#galaxy-container").selectAll("svg").remove();
    setGalaxyLoading(null);
    // 空闲态文案跟着输入方式走：页面上写死的「将鼠标移到…」在手机上是个做不到的动作
    setGalaxyIdleHint();

    const svg = d3.select("#galaxy-container").append("svg")
        .attr("width", width)
        .attr("height", height)
        // 名字每次重建 svg 时设一次（这处每次渲染都是新节点，不存在残留），
        // 循环里的圆点靠父节点的名字交代「这张图是什么」。
        .attr("aria-label", describeChartForScreenReader({ kind: 'galaxy', booksArray: plotBooks }))
        .style("background", "radial-gradient(ellipse at center, #f8efda 0%, #f2e7cd 100%)");

    const defs = svg.append("defs");

    const filter = defs.append("filter").attr("id", "glow");
    filter.append("feGaussianBlur")
        // 2.5 也是给深色底写的：在纸色底上 2.5 只是一团糊，收成 1.5（第三十六批）
        .attr("stdDeviation", "1.5")
        .attr("result", "coloredBlur");
    const feMerge = filter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    // 颜色图例：让用户知道每种颜色对应哪本书
    const legendEl = document.getElementById('galaxy-legend');
    if (legendEl) {
        legendEl.innerHTML = '';
        books.forEach(book => {
            const item = document.createElement('span');
            item.className = 'galaxy-legend-item';
            const swatch = document.createElement('span');
            swatch.className = 'galaxy-legend-swatch';
            swatch.style.background = colorForBook(book);
            // 图例里也要带上球心那道记号：颜色分不出来的人，正是靠图例把「记号 → 书名」
            // 对上的。图例上不画，记号就成了图上没人能查的暗号（第三十八批）。
            const markKind = glyphForBook(book);
            if (markKind !== 'none') {
                const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                mark.setAttribute('class', 'galaxy-legend-mark');
                mark.setAttribute('viewBox', '-6 -6 12 12');
                mark.setAttribute('aria-hidden', 'true');
                mark.setAttribute('focusable', 'false');
                const markPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                markPath.setAttribute('d', galaxyGlyphPath(markKind, 6));
                markPath.setAttribute('fill', 'none');
                markPath.setAttribute('stroke', '#f2e7cd');
                markPath.setAttribute('stroke-width', '2');
                markPath.setAttribute('stroke-linecap', 'round');
                mark.appendChild(markPath);
                swatch.appendChild(mark);
            }
            item.appendChild(swatch);
            item.appendChild(document.createTextNode(getBookDisplayName(book)));
            if (skippedBooks.has(book)) {
                item.classList.add('galaxy-legend-skipped');
                item.appendChild(document.createTextNode('（未画入）'));
            }
            legendEl.appendChild(item);
        });
    }

    // 只给真正画进这张图的书建渐变：圆点来自 plotBooks（图例仍遍历 books，
    // 那是为了把「未画入」的书也列出来），给跳过不画的书建渐变只会留下一批
    // 没有任何 url(#…) 引用的死 defs
    // 球面的三档渐变（第三十六批压平）：原来高光提亮 1.5×、外圈压暗 1.2×，
    // 是给深色底写的——深色外圈在深底上等于没有边，球看起来是发光的。底色换成
    // 纸色之后，同一段代码读出来变成「一个个不透明的塑料球」。这里把落差收到
    // 1.15× / 1.08×，留一点体积感就够了，读起来是墨点。
    plotBooks.forEach((book) => {
        const baseColor = d3.color(colorForBook(book));
        const highlight = baseColor.brighter(1.15);
        const shadow = baseColor.darker(1.08);

        const gradId = "grad-" + getBookSafeId(book);

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
    let droppedBlocks = 0;

    plotBooks.forEach((bookName) => {
        const positionData = getMetricValues(bookName, 'functionWords');
        const displayData = getMetricValues(bookName, currentMetric);

        if (positionData.length && displayData.length) {
            positionData.forEach((d, i) => {
                const metricItem = displayData[i];
                if (!metricItem || !isFiniteNumber(d.value) || !isFiniteNumber(metricItem.value)) return;
                // 没有第二个坐标就画不出位置，宁可少画一个点也不编一个
                if (!isFiniteNumber(d.value_y)) {
                    droppedBlocks += 1;
                    return;
                }

                allNodes.push({
                    id: `${bookName}_${d.block}`,
                    book: bookName,
                    blockIndex: d.block,
                    pcaX: d.value,
                    pcaY: d.value_y,
                    realValue: metricItem.value,
                    // 长摘录不随节点预存（页面响应里已不带，见第二十一批）；
                    // 弹窗打开时按「书名 + 片段号」现取
                    preview: metricItem.preview,
                    wordCount: isFiniteNumber(d.wordCount) ? d.wordCount : metricItem.wordCount,
                    keywords: metricItem.keywords
                });
            });
        }
    });

    renderGalaxyNote(comparability, null, droppedBlocks);

    if (allNodes.length === 0) {
        // 这里原来引用了一个从未声明的 loadingEl，会抛 ReferenceError：
        // 画布已经清空，用户看到的是空白一片且没有任何说明；异常还会冒泡到
        // handleFileUpload 的 catch，把一次成功的上传误报成「上传失败」。
        // setGalaxyLoading 本来就是这个状态该用的函数。
        setGalaxyLoading('这几本书暂时缺少生成风格星系所需的高频小词数据。请更换书籍后重试。');
        return;
    }

    // 尺子的值域。先用浮点数判退化（min === max），再用「屏幕上显示得出来的精度」判一次
    // （sizeExtentIsFlat，见该函数）：后者才是读者能分辨的粒度。两个端点显示成同一个数时，
    // 走和「所有值都相同」同一条路——给它 1 单位的余量，让所有片段落在同一个半径上，
    // 而不是把 [4,14] 铺在一个屏幕上根本看不见的跨度上。
    const rawMetricExtent = d3.extent(allNodes, d => d.realValue);
    const metricExtent = sizeExtentIsFlat(rawMetricExtent)
        ? normalizeExtent([rawMetricExtent[0], rawMetricExtent[0]])
        : normalizeExtent(rawMetricExtent);
    // 上限从 18 收到 14（第三十六批）：166 个半径 11 上下的实心球同屏，互相压住，
    // 既看不出个数也看不出大小。收小之后碰撞力需要的位移也变小，位置反而更忠实。
    // 触控 44px 的底线由 attachGalaxyTapPicker 那层透明接收层（容差 22px）保住。
    const radiusScale = d3.scaleSqrt()
        .domain(metricExtent)
        .range([4, 14]);

    const galaxyExtent = resolveGalaxyExtent(allNodes, independentMode ? null : comparability.axisExtent);
    const xExtent = galaxyExtent.x;
    const yExtent = galaxyExtent.y;

    // 从单一 padding=60 换成四边 margin（第三十六批）：坐标轴要有地方站。
    // 容器高度仍是 HTML 里写死的 600px（d3_visualization.html），所以 plotH 是常数，
    // 只有 plotW 随宽度变。
    const margin = { top: 32, right: 24, bottom: 52, left: 56 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    // 窄到画不出轴时不画轴，只画点。当前断点触发不了（320px 视口下 plotW 仍有 240px），
    // 挡的是以后有人改高度导致 range 反向、tickSize 符号翻转。
    const drawAxes = plotW > 40 && plotH > 40;

    // range 必须保持「上小下大」：src/projection.py 的 axis_labels() 把纵轴朝向写死进了
    // 给读者看的那句话（「纵轴…值大在下」），这里一翻，那边的话当场变假，而且不会报错。
    const xScale = d3.scaleLinear().domain(xExtent).range([margin.left, margin.left + plotW]);
    const yScale = d3.scaleLinear().domain(yExtent).range([margin.top, margin.top + plotH]);
    renderGalaxyNote(comparability, galaxyExtent, droppedBlocks);
    // 大小图例跟着 radiusScale 走；指标一换本函数会整个重跑，不需要额外钩子
    renderGalaxySizeLegend(radiusScale, allNodes);

    allNodes.forEach(d => {
        d.r = radiusScale(d.realValue);
        d.x = xScale(d.pcaX);
        d.y = yScale(d.pcaY);
        // 有上次落点就从上一次接着算（见 galaxyPositions 的说明）。只在落点仍落在
        // 这一屏里时才用：换了几本书就看不清，坐标尺可能整个变了，旧点位跑到屏外
        // 反而要花更久才被拉回来。
        const cached = galaxyPositions.get(d.id);
        if (cached && cached.x >= 0 && cached.x <= width && cached.y >= 0 && cached.y <= height) {
            d.x = cached.x;
            d.y = cached.y;
        }
    });

    // ---- 坐标层（第三十六批）----
    // 网格、零线、两轴、轴题都放在圆点所在的 g **之外**：g 是 attr("transform", …) 的
    // 接收者，把它们塞进 g 里，缩放时刻度和线宽会跟着一起被放大。分开之后，缩放改的
    // 只是这些线的“位置”，线的长度和粗细原地不动——这正是 focus+context 要的效果：
    // 滚轮放大 = 网格自动加密 = 真的能读细节，不需要再加一个「放大到所选书籍」的开关。
    const back = svg.append("g").attr("class", "galaxy-back");
    const gridX = back.append("g").attr("class", "grid grid-x").attr("stroke-opacity", 0.09);
    const gridY = back.append("g").attr("class", "grid grid-y").attr("stroke-opacity", 0.09);
    // 0 是内置语料的平均水平（PCA 得分以均值为中心）。哪条出了可见范围就藏哪条。
    const zeroX = back.append("line").attr("class", "zero-line").attr("display", "none");
    const zeroY = back.append("line").attr("class", "zero-line").attr("display", "none");

    const g = svg.append("g");

    // ---- 每本书的「地盘」（第三十七批）----
    // 第三十六批把圆点收小、给每个点加了一圈纸色细缝之后，相邻的点各自留住轮廓，
    // 「几本书挤在同一片区域」这件事就从「糊成一片」变成了「看不太出来」——实测
    // 贴在一起的小团从 35 块涨到 48 块，用户当场问「以前小球是会有交融的，怎么没了」。
    // 但把球改回去是错的：靠小球互相压住来表达「区域重叠」，本来就不该是这张图的
    // 编码方式（点被压住的时候，个数和大小都读不出来了）。通行的做法是**另外画一层
    // 区域**——把同一本书的点圈成一块半透明的色块，几块色块叠在一起，就说明这几本书
    // 的风格区间有重叠（factoextra 的 addEllipses、dittoSeq 的 do.contour 都是这个
    // 路子）。这样「一片」是有意画出来的，而且不必牺牲任何一个点自己的清晰度。
    //
    // 形状用凸包（d3.polygonHull）而不是密度等高线：实测四本书一起看时，每个凸包内部
    // **不含任何别的书的点**（foreignInside 全空），所以凸包不会把别人的点圈进自家地盘；
    // 等高线要另调带宽，布局一抖还可能分裂成好几块。凸包的顶点再交给 Catmull-Rom
    // 闭合曲线抹圆，读起来是一块有边界的墨渍，不是一个数学多边形。
    const territoryLayer = g.append("g").attr("class", "galaxy-territory");
    // 色块要留在绘图格里。凸包本身就在点的范围内，但抹圆的曲线会往角上鼓出去一点，
    // 放大之后鼓得更多——不裁的话它会漫过坐标轴压到刻度上（坐标轴在 g 之外，
    // 不跟着缩放，玩家放大到 5 倍时色块早已越过画框）。圆点没有被裁，因为它们
    // 本来就落在绘图格里，只是半径那么大；被裁掉的是凸包的“边角外溢”。
    const territoryClip = defs.append("clipPath").attr("id", "galaxy-territory-clip");
    territoryClip.append("rect")
        .attr("x", margin.left)
        .attr("y", margin.top)
        .attr("width", plotW)
        .attr("height", plotH);
    territoryLayer.attr("clip-path", "url(#galaxy-territory-clip)");

    // alpha(0.5) 是 Catmull-Rom 的常规取值：太大在折角处鼓得厉害，太小又退回折线
    const territoryCurve = d3.line()
        .curve(d3.curveCatmullRomClosed.alpha(0.5))
        .x(p => p[0])
        .y(p => p[1]);

    const territoryPaths = new Map();
    plotBooks.forEach(book => {
        const colour = colorForBook(book);
        // 只描边、不填充深色：4 本书的色块互相叠在一起时，两层 10% 的色叠出来会变成
        // 第三种颜色（读屏会把「红+蓝=紫」当成还有第五本书）。所以填充压到 0.10 这一档，
        // 身份主要靠那圈同色的细边来交代，叠色区就只是一块更深的纸色。
        territoryPaths.set(book, territoryLayer.append("path")
            .attr("class", "galaxy-territory-path")
            .attr("fill", colour)
            .attr("fill-opacity", 0.10)
            .attr("stroke", colour)
            .attr("stroke-opacity", 0.38)
            .attr("stroke-width", 1.5)
            .attr("stroke-linejoin", "round")
            .attr("display", "none"));
    });

    // 力导向每帧都在动，地盘必须跟着重画，否则色块会停在上一帧的位置上。代价实测
    // 可以忽略：每帧 4 次凸包，合计不超过 251 个点。
    function drawTerritories() {
        plotBooks.forEach(book => {
            const path = territoryPaths.get(book);
            const points = [];
            for (let i = 0; i < allNodes.length; i++) {
                const node = allNodes[i];
                if (node.book === book) points.push([node.x, node.y]);
            }
            // 3 个点以下凸包就退化了（d3.polygonHull 对共线点会返回 2 个点甚至 null），
            // 画出来是一条线，不如不画
            const hull = points.length >= 3 ? d3.polygonHull(points) : null;
            if (!hull || hull.length < 3) {
                path.attr("display", "none");
                return;
            }
            path.attr("display", null).attr("d", territoryCurve(hull));
        });
    }
    drawTerritories();

    // 坐标轴刻度画在圆点之上，但落在绘图区之外，不会被圆点盖住
    const axisX = svg.append("g").attr("class", "galaxy-axis-x");
    const axisY = svg.append("g").attr("class", "galaxy-axis-y");

    // 轴题只写「第几主成分 + 它解释了多少差异」。原始得分（-0.06 这种数字）不印：
    // 对读这张图的人没有任何可操作性，印一批看不懂的数字比不印更差；一个百分数
    // 就足以说清「这一维值不值得读」。
    const ratio = comparability.explainedVarianceRatio || [];
    const pcCaption = (i) => {
        const pct = isFiniteNumber(ratio[i]) ? ` · 解释 ${(ratio[i] * 100).toFixed(1)}% 的差异` : '';
        return `第 ${i + 1} 主成分${pct}`;
    };

    // axisRaf 必须声明在函数内部：放模块级的话，重新渲染时它还会闭包住上一轮
    // 已经被移除的节点，而且会永久挡住新图的第一次重画。
    let axisRaf = null;
    let lastTransform = null;

    function redrawAxes(t) {
        // rescaleX 保 range、换 domain ⇒ zx(v) 恒等于该数据点在屏幕上的位置，
        // 所以网格线和圆点在缩放过程中永远对得上
        const zx = t.rescaleX(xScale);
        const zy = t.rescaleY(yScale);

        gridX.attr("transform", `translate(${margin.left},${margin.top + plotH})`)
            .call(d3.axisBottom(zx).tickSizeOuter(0).tickSize(-plotH).tickFormat(""));
        gridY.attr("transform", `translate(${margin.left},${margin.top})`)
            .call(d3.axisLeft(zy).tickSizeOuter(0).tickSize(-plotW).tickFormat(""));
        axisX.attr("transform", `translate(${margin.left},${margin.top + plotH})`)
            .call(d3.axisBottom(zx).tickSizeOuter(0).tickFormat(""));
        axisY.attr("transform", `translate(${margin.left},${margin.top})`)
            .call(d3.axisLeft(zy).tickSizeOuter(0).tickFormat(""));

        const [x0, x1] = zx.domain();
        const [y0, y1] = zy.domain();
        zeroX.attr("display", (x0 <= 0 && 0 <= x1) ? null : "none")
            .attr("x1", zx(0)).attr("x2", zx(0))
            .attr("y1", margin.top).attr("y2", margin.top + plotH);
        zeroY.attr("display", (y0 <= 0 && 0 <= y1) ? null : "none")
            .attr("x1", margin.left).attr("x2", margin.left + plotW)
            .attr("y1", zy(0)).attr("y2", zy(0));
    }

    // 缩放一秒能来几十个事件。圆点那一次属性写必须立刻做（否则拖动发涩），
    // 坐标层这四组重建按帧合并，一帧最多一次。
    function scheduleAxes(t) {
        lastTransform = t;
        if (axisRaf !== null) return;
        axisRaf = requestAnimationFrame(() => {
            axisRaf = null;
            redrawAxes(lastTransform);
        });
    }

    svg.call(d3.zoom()
        .scaleExtent([0.5, 5])
        .on("zoom", (event) => {
            g.attr("transform", event.transform);
            if (drawAxes) scheduleAxes(event.transform);
        }));

    if (drawAxes) {
        redrawAxes(d3.zoomTransform(svg.node()));
        svg.append("text").attr("class", "axis-label")
            .attr("x", margin.left + plotW / 2)
            .attr("y", margin.top + plotH + 38)
            .attr("text-anchor", "middle")
            .text(pcCaption(0));
        // 旋转 -90 之后 (x, y) 落到屏幕的 (y, -x) 上：**「离左边多远」要写在 y 上**。
        // 折线图那处写的是 y=-46（:1793），看着可以照抄，其实不行——它是 append 到一个
        // 带 translate 的 g 上的（:1789），负值是相对那个 g 的，落到容器里是正的。
        // 这里的轴题直接挂在 svg 根上，而星系的容器是 overflow:hidden、SVG 与容器同宽，
        // 负值等于把轴题钉进裁剪区：照抄过来实测包围盒落在 x=-29（容器左界之外），
        // 屏幕上一个字都看不到，而且不会报错。所以放在左留白的中间（0–margin.left）。
        // 这条也是本批的一个教训：**相邻图表里长得一样的写法，坐标系未必一样。**
        svg.append("text").attr("class", "axis-label")
            .attr("transform", "rotate(-90)")
            .attr("x", -(margin.top + plotH / 2))
            .attr("y", margin.left / 2 + 4)
            .attr("text-anchor", "middle")
            .text(pcCaption(1));
    }

    if (galaxySimulation) galaxySimulation.stop();

    galaxySimulation = d3.forceSimulation(allNodes)
        .force("x", d3.forceX(d => xScale(d.pcaX)).strength(0.8))
        .force("y", d3.forceY(d => yScale(d.pcaY)).strength(0.8))
        .force("collide", d3.forceCollide(d => d.r + 1).strength(1))
        .force("charge", d3.forceManyBody().strength(-15))
        // 起步 alpha 和衰减率都调过：默认 alpha=1、alphaDecay≈0.023，要跑约 300 次
        // 迭代（约 5 秒）才到静止。起点通常已经是上一轮的稳态，用不着从零重新退火。
        .alpha(0.35)
        .alphaDecay(0.06)
        .alphaTarget(0)
        .on("tick", ticked);

    // 纸色描边：与 #galaxy-container 的底色同一个值。描边从「比球身更深的圈」
    // 改成这一条纸色细缝之后，互相压住的点各自留住一圈轮廓，叠在一起的团块
    // 不再糊成一片——散点密集时的通行做法（第三十六批）。
    const PAPER_RIM = '#f2e7cd';

    const circles = g.selectAll("circle")
        .data(allNodes)
        .enter().append("circle")
        .attr("r", d => d.r)
        .attr("fill", d => `url(#grad-${getBookSafeId(d.book)})`)
        .attr("stroke", PAPER_RIM)
        .attr("stroke-width", 1)
        .attr("stroke-opacity", 1)
        .attr("role", "button")
        .attr("aria-label", d => `${getBookDisplayName(d.book)} 第 ${d.blockIndex + 1} 个片段，${getMetricLabel(currentMetric)} ${formatMetric(d.realValue)}`)
        .style("cursor", "pointer")
        .call(d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended));

    // ---- 球心上那道纸色记号（第三十八批，第二个编码通道）----
    // 画在圆点**之上**：球是不透明的渐变，压在下面等于没画。这一层不接任何指针事件，
    // 悬停、点按、拖动照旧全部归圆点（与 .galaxy-territory 同一个理由，写在 CSS 里）。
    const glyphLayer = g.append("g").attr("class", "galaxy-glyph-layer");
    const glyphs = glyphLayer.selectAll("path")
        .data(allNodes)
        .enter().append("path")
        .attr("class", "galaxy-glyph")
        .attr("fill", "none")
        .attr("stroke", PAPER_RIM)
        .attr("stroke-linecap", "round")
        .attr("stroke-width", d => galaxyGlyphWidth(d.r))
        .attr("d", d => galaxyGlyphPath(glyphForBook(d.book), d.r));

    // 悬停时圆点放大到 1.5 倍，记号得跟着放大，否则球胀起来的一瞬间球心那道记号
    // 会突然显得偏小，像画错了。倍数存在节点上、由 ticked() 统一写 transform：
    // 力导向每帧都在重写 transform，用 d3.transition 做这个缩放会被下一帧直接抹掉。
    function updateGlyphs() {
        glyphs.attr("transform", d => `translate(${d.x},${d.y}) scale(${d.glyphScale || 1})`);
    }
    updateGlyphs();

    circles.on("mouseover", function(event, d) {
        d3.select(this)
            .transition().duration(motionDuration(100))
            .attr("r", d.r * 1.5)
            .style("filter", "url(#glow)")
            .attr("stroke", "#2f2a23")
            .attr("stroke-width", 2);
        d.glyphScale = 1.5;
        updateGlyphs();
        
        const allCircles = g.selectAll("circle");
        const allNodeData = allCircles.data();
        // 邻域按「屏幕上 120px」算，所以要除以当前缩放倍数（第三十六批）。
        // node.x/node.y 是 g 本地坐标，g 是均匀的平移+缩放，本地距离 D 在屏幕上就是 k·D。
        // 不除的话，放大 5 倍之后眼睛看到点散开了、面板报的却还是同一批点。
        // k 直接向 zoom 要（同 attachGalaxyTapPicker 的取法），不另存一个变量：
        // 程序化重置或重新渲染之后，存下来的那个会不准。
        const zoomK = d3.zoomTransform(svg.node()).k || 1;
        const neighbors = findNeighbors(d, allNodeData, 120 / zoomK);
        // 用 Set 而不是数组 includes：neighbors 最多和全图节点数同量级，
        // 逐个 includes 在「邻居多」时退化成 O(n²)，扫一圈圆点就是上万次线性查找。
        const neighborSet = new Set(neighbors);

        allCircles.filter(node => neighborSet.has(node))
            .transition().duration(motionDuration(100))
            .attr("stroke", "#b5472f")
            .attr("stroke-width", 2)
            .attr("stroke-opacity", 1);

        const analysis = analyzeCluster(neighbors);
        const label = window.getMetricLabel ? getMetricLabel(currentMetric) : currentMetric;
        // 带上全图点数：面板要报「这 50 个点占全图 30%」，否则读者会以为
        // 「附近」是一小撮，实际它是全图的三成（第三十六批）。
        updateHUD(analysis, label, allNodeData.length);

        // value 传原始数值，不在这里先格式化：showTooltip 统一走 formatMetric，
        // 否则这里传字符串进去会命中 formatMetric 的 !isFiniteNumber 分支显示「暂无」。
        showTooltip(event, {
            block: d.blockIndex,
            value: d.realValue,
            keywords: d.keywords,
            preview: d.preview
        }, d.book);
    })
    .on("mouseout", function(event, d) {
        d3.select(this)
            .transition().duration(motionDuration(200))
            .attr("r", d.r)
            .style("filter", null)
            .attr("stroke", PAPER_RIM)
            .attr("stroke-width", 1);
        d.glyphScale = 1;
        updateGlyphs();

        g.selectAll("circle")
             .transition().duration(motionDuration(200))
             .attr("stroke", PAPER_RIM)
             .attr("stroke-width", 1)
             .attr("stroke-opacity", 1);
        
        setGalaxyIdleHint();

        hideTooltip();
    })
    .on("click", (event, d) => {
        event.stopPropagation();
        lastGalaxyTrigger = event.currentTarget;
        // 触屏上点一下会连带触发一次合成的 mouseover（于是弹出小提示框），
        // 却没有对应的 mouseout——那个提示框会一直挂在屏幕上。点开全屏详情之后
        // 它更没有存在的必要，直接收掉。
        hideTooltip();
        openGalaxyModal(d);
    })
    .on("keydown", (event, d) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            lastGalaxyTrigger = event.currentTarget;
            openGalaxyModal(d);
            return;
        }
        // ← →（以及 ↑ ↓）沿片段顺序前后移动焦点，Home / End 跳首尾。
        // 星系是散点，方向键没有「往右就是右边那个点」的自然对应（力导向布局还会自己漂移），
        // 所以不按屏幕位置走，按数据本身的顺序走——也就是这本书从前到后的片段顺序。
        const all = circles.nodes();
        const current = all.indexOf(event.currentTarget);
        let next = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = current + 1;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = current - 1;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = all.length - 1;
        if (next === null) return;
        event.preventDefault();
        if (next < 0 || next >= all.length) return;
        all.forEach(node => node.setAttribute('tabindex', '-1'));
        all[next].setAttribute('tabindex', '0');
        all[next].focus();
    });

    // 四本书合计两百多个片段点，每个都能 Tab 到的话，键盘用户得按两百多次才走得出星系；
    // 整片星系只留一个 Tab 停靠点（第一个点），其余靠上面的方向键。
    circles.attr("tabindex", (d, i) => (i === 0 ? 0 : -1));

    // 触屏上没有「悬停」这一步，而圆点的直径只有 8–28px：手指按下去十有八九落空，
    // 按偏了也完全没有反应。这里在圆点底下垫一层透明接收层，按下去取离手指最近的点。
    if (usesCoarsePointer()) {
        attachGalaxyTapPicker({ g: g, svg: svg, nodes: allNodes, circles: circles, width: width, height: height });
    }

    // 系统要求「减少动态效果」时，不播这场收敛动画：先把力导向在内存里算完，
    // 停掉，再一次性画出来。注意 tick() 不触发 "tick" 事件，所以算完要手动调一次
    // ticked()，否则屏幕上是一片空白。
    if (prefersReducedMotion()) {
        galaxySimulation.tick(120);
        galaxySimulation.stop();
        ticked();
    }

    function ticked() {
        circles
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);
        updateGlyphs();
        drawTerritories();
        // 顺手记下落点，供下次进入时接着算（用户拖动后的位置也在这里被记下来）。
        // 复用同一个对象，不然 200 多个点乘以上百次迭代会白白造两万多个临时对象。
        allNodes.forEach(d => {
            const slot = galaxyPositions.get(d.id);
            if (slot) { slot.x = d.x; slot.y = d.y; }
            else galaxyPositions.set(d.id, { x: d.x, y: d.y });
        });
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

// 触屏上按星系圆点要「够得着」：圆点直径 8–28px、均值约 19px（第三十六批收小之前是
// 8–36/约 22px），低于项目自定的 44px
// 触控目标底线，手指按偏了毫无反应，用户只会以为这一页不能点。
// 做法是在圆点底下垫一层透明接收层，按下去取「离手指最近的那个点」，容差 22px
// （直径 44px）。直接按在圆点上时走的仍是圆点自己的点击——这一层垫在最下面，抢不走。
// 只在手指输入下挂这一层：桌面沿用原来的悬停 + 点击，行为一点不变。
function attachGalaxyTapPicker(opts) {
    const TOLERANCE = 22; // 半径，单位像素；直径就是 44px 的触控下限
    const TAP_SLOP = 8;   // 手指挪过这么多像素就算在拖动/平移，不当点按
    let downX = null;     // null = 没收到 pointerdown，此时不做「是不是在拖」的判断
    let downY = null;

    const layer = opts.g.insert("rect", ":first-child")
        .attr("class", "galaxy-tap-layer")
        .attr("x", 0)
        .attr("y", 0)
        .attr("width", opts.width)
        .attr("height", opts.height)
        .attr("fill", "none")
        .style("pointer-events", "all");

    layer.on("pointerdown", function (event) {
        downX = event.clientX;
        downY = event.clientY;
    });

    layer.on("click", function (event) {
        // 平移星系之后松手也会补一次 click，那不属于「点按」。
        // 只在真的收到过 pointerdown 时才做这个判断——万一它没来，宁可照点不误。
        if (downX !== null && Math.hypot(event.clientX - downX, event.clientY - downY) > TAP_SLOP) return;

        // 这一层在 g 里，而 g 带着缩放/平移的变换，所以 d3.pointer 直接给出数据坐标
        const [px, py] = d3.pointer(event, opts.g.node());
        let best = null;
        let bestD2 = Infinity;
        opts.nodes.forEach(function (d) {
            const dx = d.x - px;
            const dy = d.y - py;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) { bestD2 = d2; best = d; }
        });

        // 容差按当前缩放折算：放大 5 倍时，同一个「44px 手指范围」在数据坐标里小得多
        const k = d3.zoomTransform(opts.svg.node()).k || 1;
        if (!best || bestD2 > Math.pow(TOLERANCE / k, 2)) return;

        // 关掉弹窗后焦点要回到刚才那个点，所以得找到它对应的圆点元素
        lastGalaxyTrigger = opts.circles.nodes().find(node => node.__data__ === best) || null;
        hideTooltip();
        openGalaxyModal(best);
    });
}

// ==========================================
// 📜 悬浮页控制函数
// ==========================================

// 弹窗里那句「这是摘录，不是全文」的说明。百分比按真正显示出来的字符算（_preview 会补
// 省略号，那三个点不是原文），不写死 1200——短摘录（150 字符）走到这里时，写死 1200
// 就会变成另一句假话。取长摘录成功/失败两条路径都用它，保证口径一致。
//
// 这里不再写绝对字数（第四十四批）：本片段多少词，上面那个徽章（formatWordCount）已经写了；
// 这段摘录多少字符，下面那个复制按钮也写了。同一个弹窗、同一屏、同一个数，本来写了两遍。
// 这一行只留徽章和按钮都给不出的那一件事——占全片段多大比例。
function modalExcerptNote(excerpt, wordCount) {
    const wc = Number(wordCount);
    if (Number.isFinite(wc) && wc > 0) {
        // 英文平均一个词连同后随空格约 6 个字符，只用来给一个数量级感受
        const pct = Math.max(1, Math.round(excerptCharCount(excerpt) / (wc * 6) * 100));
        return `这里显示的是片段开头的一段（约占 ${pct}%），不是全文。`;
    }
    return '这里显示的是片段开头的一段，不是全文。';
}

function openGalaxyModal(d) {
    const modal = document.getElementById('galaxy-modal');
    if (!modal) return;

    // 在途请求令牌：弹窗是复用的一个节点，连开两段时后开的必须赢；
    // 关掉弹窗后在途响应也要作废（见 closeGalaxyModal）
    const excerptToken = ++galaxyExcerptToken;

    const titleEl = document.getElementById('modal-book-title');
    if (titleEl) titleEl.textContent = getBookDisplayName(d.book);

    const blockEl = document.getElementById('modal-block-id');
    if (blockEl) {
        const loc = formatBlockLocation(d.book, d.blockIndex) + formatWordCount(d.wordCount);
        blockEl.textContent = loc || `第 ${Number(d.blockIndex) + 1} 个片段`;
    }

    const valDisplay = formatMetric(d.realValue);
    const metricEl = document.getElementById('modal-metric-val');
    if (metricEl) metricEl.textContent = `${getMetricLabel(currentMetric)}：${valDisplay}`;

    const keywordContainer = document.getElementById('modal-keywords');
    if (keywordContainer) {
        keywordContainer.replaceChildren();
        if (Array.isArray(d.keywords) && d.keywords.length > 0) {
            d.keywords.forEach(kw => {
                const span = document.createElement('span');
                span.textContent = kw;
                // 关键词是英文（the / his / of 这类功能词）。不标 lang，读屏会拿中文音库
                // 逐字母去念；标了才会切到英文音库。只标这一个 span——下面那个「无关键词」
                // 的中文 span 不能跟着被标成英文。
                span.lang = 'en';
                keywordContainer.appendChild(span);
            });
        } else {
            const empty = document.createElement('span');
            empty.style.color = '#6b6254';
            empty.textContent = '无关键词';
            keywordContainer.appendChild(empty);
        }
    }

    const textContainer = document.getElementById('modal-long-text');
    // 先显示页面上已有的短摘录（页面响应不再带长摘录），长的那段取到后再替换。
    const shortExcerpt = d.preview || '';
    if (textContainer) {
        textContainer.textContent = shortExcerpt || "暂无详细文本内容…";
        // 有摘录时这段是英文原文，要标 lang 让读屏换英文音库；没有摘录时容器里放的是
        // 中文兜底文案，那就得把 lang 摘掉——元素是复用的，上一本书留下的 lang="en"
        // 会让这句中文也被按英文念。
        if (shortExcerpt) textContainer.lang = 'en';
        else textContainer.removeAttribute('lang');
    }

    const noteEl = document.getElementById('modal-text-note');
    // 这时正文里放的是页面上已有的那段短摘录，说明就先按它写；长摘录取回来会在下面改写一次。
    // 不在这里写「正在取更长的摘录…」——按钮上已经写着同一句话（第四十四批）。只有连短摘录
    // 都没有时（那时复制按钮是隐藏的，不会重复）才由这行小字顶替那句加载提示。
    if (noteEl) {
        noteEl.textContent = shortExcerpt
            ? modalExcerptNote(shortExcerpt, d.wordCount)
            : '正在取本片段更长的摘录…';
    }

    const modalCopyBtn = document.getElementById('modal-copy-btn');
    if (modalCopyBtn) {
        // 复用节点：先清掉上一段的快照/索引，否则会跨段还原出旧字数
        resetCopyButton(modalCopyBtn);
        modalCopyBtn.hidden = !shortExcerpt;
        if (shortExcerpt) {
            modalCopyBtn.disabled = true;
            modalCopyBtn.setAttribute('aria-busy', 'true');
            modalCopyBtn.textContent = '正在取长摘录…';
        }
    }

    // 只取到短文（或无文）时的降级显示：正文保持短摘录，备注/按钮按实际拿到的算
    const showShortExcerptOnly = (reason) => {
        if (noteEl) {
            noteEl.textContent = shortExcerpt
                ? modalExcerptNote(shortExcerpt, d.wordCount) + reason
                : '这个片段暂时没有可显示的摘录。';
        }
        if (modalCopyBtn) {
            modalCopyBtn.disabled = false;
            modalCopyBtn.removeAttribute('aria-busy');
            if (shortExcerpt) {
                setCopyButtonLabel(modalCopyBtn,
                    `⧉ 复制这段摘录（${excerptCharCount(shortExcerpt)} 字符）`);
                modalCopyBtn.dataset.copyIdx = registerCopySource(shortExcerpt);
                modalCopyBtn.hidden = false;
            } else {
                modalCopyBtn.hidden = true;
            }
        }
    };

    if (!d.book) {
        showShortExcerptOnly('');
    } else {
        resolveExcerpt(d.book, d.blockIndex).then((payload) => {
            if (excerptToken !== galaxyExcerptToken) return; // 已被新弹窗/关闭作废
            if (textContainer) {
                textContainer.textContent = payload.excerpt;
                textContainer.lang = 'en';
            }
            if (noteEl) noteEl.textContent = modalExcerptNote(payload.excerpt, d.wordCount);
            if (modalCopyBtn) {
                modalCopyBtn.disabled = false;
                modalCopyBtn.removeAttribute('aria-busy');
                modalCopyBtn.hidden = false;
                setCopyButtonLabel(modalCopyBtn,
                    `⧉ 复制这段摘录（${excerptCharCount(payload.excerpt)} 字符）`);
                modalCopyBtn.dataset.copyIdx = registerCopySource(payload.excerpt);
            }
        }).catch((e) => {
            if (excerptToken !== galaxyExcerptToken) return;
            console.warn('取长摘录失败:', e);
            showShortExcerptOnly('（没能取到更长的摘录）');
        });
    }

    modal.setAttribute('aria-hidden', 'false');
    modal.style.display = 'flex';
    document.addEventListener('keydown', trapModalFocus);
    setTimeout(() => {
        modal.classList.add('show');
        const closeButton = modal.querySelector('.galaxy-modal-close');
        if (closeButton) closeButton.focus();
    }, 10);
}

// 键盘焦点陷阱：弹窗打开时 Tab 只在弹窗内部循环，
// 否则焦点会跑到背后看不见的页面上，读屏用户会彻底迷失
function trapFocusWithin(modal, event) {
    if (!modal || event.key !== 'Tab') return;

    const focusables = Array.from(
        modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter(el => !el.hidden && el.offsetParent !== null);
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function trapModalFocus(event) {
    trapFocusWithin(document.getElementById('galaxy-modal'), event);
}

function trapShelfModalFocus(event) {
    trapFocusWithin(document.getElementById('shelf-modal'), event);
}

function closeGalaxyModal() {
    const modal = document.getElementById('galaxy-modal');
    if (!modal) return;

    galaxyExcerptToken += 1; // 关掉后，还在路上的长摘录响应全部作废
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', trapModalFocus);
    setTimeout(() => {
        modal.style.display = 'none';
        if (lastGalaxyTrigger && typeof lastGalaxyTrigger.focus === 'function') {
            lastGalaxyTrigger.focus();
        }
        lastGalaxyTrigger = null;
    }, 300);
}

document.addEventListener('DOMContentLoaded', function() {
    const modal = document.getElementById('galaxy-modal');
    if (modal) {
        modal.addEventListener('click', function(e) {
            if (e.target === this) closeGalaxyModal();
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && modal.getAttribute('aria-hidden') === 'false') {
                closeGalaxyModal();
            }
        });
    }

    // 「书架编号」弹窗：点遮罩关闭、Esc 关闭、复制编号、切换书架
    const shelfModal = document.getElementById('shelf-modal');
    if (shelfModal) {
        shelfModal.addEventListener('click', function(e) {
            if (e.target === this) closeShelfModal();
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && shelfModal.getAttribute('aria-hidden') === 'false') {
                closeShelfModal();
            }
        });
        const copyBtn = document.getElementById('shelf-code-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', function() {
                // 编号还没到手（接口失败等）时按钮上本来就没东西可复制，别去闪一句错的提示
                if (!currentShelfCode) return;
                copyTextToClipboard(currentShelfCode, copyBtn, '✓ 已复制');
            });
        }
        const claimBtn = document.getElementById('shelf-code-claim');
        if (claimBtn) claimBtn.addEventListener('click', claimShelfCode);
        const input = document.getElementById('shelf-code-input');
        if (input) {
            input.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    claimShelfCode();
                }
            });
        }
    }

    // 「同名覆盖」确认弹窗：点遮罩等同于取消、Esc 也等同于取消（不替换）。
    // 两个出口都走 cancelOverwriteUpload：一致地清掉待传文件并把焦点还回去。
    const overwriteModal = document.getElementById('overwrite-modal');
    if (overwriteModal) {
        overwriteModal.addEventListener('click', function(e) {
            if (e.target === this) cancelOverwriteUpload();
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && overwriteModal.getAttribute('aria-hidden') === 'false') {
                cancelOverwriteUpload();
            }
        });
    }

    // 文本雨按钮避让吸顶页签条：滚动、窗口尺寸、以及页面高度的变化都要重算一次。
    syncMatrixBtnDodge();
    window.addEventListener('scroll', scheduleMatrixBtnDodge, { passive: true });
    window.addEventListener('resize', scheduleMatrixBtnDodge);
    // 字体/图片到位后工具区高度还会再变一次，量早了会算在错的位置上。
    window.addEventListener('load', scheduleMatrixBtnDodge);
    if (typeof ResizeObserver === 'function') {
        // 页签条上方那一片（选书 chip 换行、快速开始横幅收起、书单变长…）一变高变矮，
        // 就推着页签条在文档里上下移动，body 的高度跟着变——盯 body 就覆盖得到。
        new ResizeObserver(scheduleMatrixBtnDodge).observe(document.body);
    }
});

window.openShelfModal = openShelfModal;
window.closeShelfModal = closeShelfModal;
window.cancelOverwriteUpload = cancelOverwriteUpload;
window.confirmOverwriteUpload = confirmOverwriteUpload;

window.restartGalaxy = function() {
    // 这个按钮承诺的是「重新布局」，所以要先丢掉上一轮的落点缓存——
    // 留着的话力导向会从上一次的稳态起步，几乎不动，按钮看起来失灵。
    galaxyPositions.clear();
    initStyleGalaxy();
};

window.selectBook = selectBook;

// ==========================================
// ◎ 星系探针分析逻辑
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

// 星系右上角那块说明的空闲态文案。触屏上「悬停」这个动作根本不存在，写着「移到圆点上」
// 等于在教一个做不到的操作，所以文案跟着输入方式来（判断同 d3-style.css 末尾那段）。
function setGalaxyIdleHint() {
    const hud = document.getElementById('galaxy-hud');
    if (!hud) return;
    const title = hud.querySelector('.hud-title');
    const content = hud.querySelector('.hud-content');
    if (!title || !content) return;

    // 说「附近点」而不是「区域」：面板里那几十个点是按屏幕距离挑出来的，放大缩小
    // 会变多变小（见 findNeighbors 的调用处）。写成「区域」会让人以为图上真的有一块
    // 划出来的地界，而它其实是跟着镜头走的（第三十六批）。
    if (usesCoarsePointer()) {
        title.innerText = "◎ 点按查看附近点";
        content.innerHTML = '<p style="color:#6b6254; font-size:12px;">点按任意圆点，查看附近各点的共同特征。</p>';
    } else {
        title.innerText = "◎ 悬停查看附近点";
        content.innerHTML = '<p style="color:#6b6254; font-size:12px;">将鼠标移到任意圆点上，查看附近各点的共同特征。</p>';
    }
}

function updateHUD(analysisData, metricLabel, totalCount) {
    const hud = document.getElementById('galaxy-hud');
    const content = hud.querySelector('.hud-content');
    const title = hud.querySelector('.hud-title');

    if (!analysisData) {
        title.innerText = "◎ 正在分析…";
        content.innerHTML = `<p style="color:#6b6254; font-size:12px;">正在分析附近的点…</p>`;
        return;
    }

    // 说「附近的点」而不是「选中区域」：这里全程没有任何选择动作，只是把光标附近
    // 这一小片圆点聚起来看看。写「选中」会让人以为自己点中了什么、还想找「取消选中」。
    // 也不再写「区域」——它是跟着镜头走的（放大就变少），不是图上划出来的一块地界。
    // 带上占比是第一要务：报「附近 50 个片段」而全图只有 166 个，读者会以为
    // 这 50 个是一小撮，实际它是全图的三成（第三十六批）。
    const total = Number(totalCount);
    const share = (Number.isFinite(total) && total > 0)
        ? ` · 占本图 ${Math.round(analysisData.count / total * 100)}%`
        : '';
    title.innerHTML = `◎ 附近的 ${analysisData.count} 个点${share}`;

    // 「这 N 个点的平均句长」而不是「区域平均句长」：标签自带「平均」，指标名也自带
    // 「平均」，拼起来会读成「区域平均平均句长」；去掉标签自己的前导「平均」，
    // 再把「区域」换成「这 N 个点」，读者才知道这个数是谁的平均（第三十六批）。
    const hudMetricLabel = String(metricLabel || '').replace(/^平均/, '');
    // 书名统一走 getBookDisplayName（别处都显示《野性的呼唤》，这里原来显示
    // 截断的原始英文 key），截断交给已有的 truncateText，别硬切 15 个字
    const hudBookName = truncateText(getBookDisplayName(analysisData.dominantBook), 18);

    let html = `
        <div class="hud-row">
            <span class="hud-label">主要来自:</span>
            <span class="hud-value" style="color:#2f2a23">${escapeHtml(hudBookName)}</span>
        </div>
        <div class="hud-bar-bg" title="这本书占比 ${analysisData.dominanceRate.toFixed(0)}%">
            <div class="hud-bar-fill" style="width: ${analysisData.dominanceRate}%;"></div>
        </div>
        <div class="hud-row" style="margin-top:8px;">
            <span class="hud-label">这 ${analysisData.count} 个点的平均${escapeHtml(hudMetricLabel)}:</span>
            <span class="hud-value" style="color:#b5472f">${formatMetric(analysisData.avgMetric)}</span>
        </div>
        <div class="hud-row" style="margin-top:8px;">
            <span class="hud-label">共同关键词:</span>
        </div>
        <div class="hud-tags">
            ${analysisData.topKeywords.map(k => `<span class="hud-tag" lang="en">${k}</span>`).join('')}
        </div>
        <div style="margin-top:10px; padding-top:5px; border-top:1px dashed rgba(46, 42, 36, 0.12); font-size:10px; color:#6b6254;">
            * 位置接近只说明高频小词的用法相近，不代表内容或水平相似。
        </div>
    `;

    content.innerHTML = html;
}

// ==========================================
// ⋮ 黑客帝国文本雨 (Matrix Keyword Rain)
// ==========================================

let matrixInterval = null;
let isMatrixOn = false;
// 停止时要把画布擦干净，但得等那层淡出走完，所以是延时 1 秒才动手。
// 这 1 秒里用户要是又点了「开始」，这个待执行的清除会落在**新的** interval 上，
// 把刚起来的雨冻住——所以把计时器存下来，重新开始时先撤掉它。
let matrixStopTimer = null;
// 换窗口大小时要按新宽度补/删列。用命名函数保存，重启时先把上一次的摘掉，
// 免得反复开关堆出一串监听器（旧写法用 window.onresize = 赋值，虽然不会叠加，
// 但它只改画布尺寸、不重算列数，拉宽后右边会空一条）。
let matrixResizeHandler = null;

function initMatrixRain() {
    const canvas = document.getElementById('matrix-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // 收集书籍关键词（读起来更像「文字」，而非乱码）
    let words = [];
    if (typeof realData !== 'undefined' && realData) {
        Object.values(realData).forEach(bookData => {
            const metricData = bookData[currentMetric] || Object.values(bookData)[0];
            if (Array.isArray(metricData)) {
                metricData.forEach(block => {
                    if (block.keywords && Array.isArray(block.keywords)) {
                        words.push(...block.keywords.filter(w => w.length < 12));
                    }
                });
            }
        });
    }
    if (words.length < 50) {
        words = [
            'Literature', 'Style', 'Twain', 'London', 'Novel', 'Plot',
            'Character', 'Emotion', 'Fingerprint', 'Text', 'Stream', 'Galaxy'
        ];
    }
    words = [...new Set(words)];

    const fontSize = 15;
    const fontFamily = 'Consolas, "Microsoft YaHei", monospace';
    const columns = Math.floor(canvas.width / fontSize);

    // 暖墨 · 羊皮纸 · 金，贴合「墨」主题（低饱和、不刺眼）
    const PALETTE = ['#c9bda3', '#b3a58a', '#98907f', '#a67c3d', '#b5472f'];

    // 每列一枚「雨滴」：颜色、文字、速度、透明度在下落全程保持不变，避免闪烁
    const makeDrop = () => ({
        y: Math.random() * -60,
        speed: 0.25 + Math.random() * 0.6,
        word: words[Math.floor(Math.random() * words.length)],
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        opacity: 0.12 + Math.random() * 0.45
    });

    const drops = [];
    for (let i = 0; i < columns; i++) {
        drops[i] = makeDrop();
    }

    function draw() {
        // 轻柔淡出拖尾（淡入暖墨背景）
        ctx.fillStyle = 'rgba(242, 231, 205, 0.08)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.textAlign = 'center';
        ctx.font = `${fontSize}px ${fontFamily}`;

        for (let i = 0; i < drops.length; i++) {
            const d = drops[i];
            const x = i * fontSize + fontSize / 2;
            const y = d.y * fontSize;

            ctx.globalAlpha = d.opacity;
            ctx.fillStyle = d.color;
            ctx.fillText(d.word, x, y);
            ctx.globalAlpha = 1;

            d.y += d.speed;

            if (y > canvas.height + 40) {
                d.y = Math.random() * -15;
                d.word = words[Math.floor(Math.random() * words.length)];
                d.color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
            }
        }
    }

    if (matrixStopTimer) {
        clearTimeout(matrixStopTimer);
        matrixStopTimer = null;
    }
    if (matrixInterval) clearInterval(matrixInterval);
    matrixInterval = setInterval(draw, 50);

    if (matrixResizeHandler) window.removeEventListener('resize', matrixResizeHandler);
    matrixResizeHandler = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        // 列数组是按旧宽度建的：拉宽后右边空一条，收窄则有一截画在画布外。
        // 按新宽度补/删列，已经在下的雨滴原样留着（它们下一帧会落到新的 x 上）。
        const nextColumns = Math.max(1, Math.floor(canvas.width / fontSize));
        while (drops.length < nextColumns) drops.push(makeDrop());
        if (drops.length > nextColumns) drops.length = nextColumns;
    };
    window.addEventListener('resize', matrixResizeHandler);
}

// 手机上（≤560px）不做文本雨（第四十二批）。断点与 d3-style.css 里
// #matrix-canvas / #btn-matrix 那条 display:none 必须一致，两边同进同退：
// 只靠 CSS 隐藏的话，那层动画还在画一张看不见的画布。
function matrixRainUnsupported() {
    try {
        return !!(window.matchMedia && window.matchMedia('(max-width: 560px)').matches);
    } catch (e) {
        return false;
    }
}

function setMatrixRain(on) {
    const canvas = document.getElementById('matrix-canvas');
    const btn = document.getElementById('btn-matrix');
    if (!canvas || !btn) return;
    // 窄屏上这块整个不显示，所以一律拒绝**启动**：否则会留一颗看不见的按钮挂着
    // aria-pressed 在无障碍树里，读屏用户还会遍历到它，而且动画在画一张没人看得见的画布。
    // 「关」（on 为假）必须照常走完——从宽屏缩到手机宽之后，得有人把那层动画停掉。
    if (on && matrixRainUnsupported()) return;

    isMatrixOn = !!on;

    if (isMatrixOn) {
        initMatrixRain();
        canvas.classList.add('active');
        btn.classList.add('active');
        btn.innerHTML = "■ 停止文本雨";
        btn.setAttribute('aria-pressed', 'true');
    } else {
        canvas.classList.remove('active');
        btn.classList.remove('active');
        btn.innerHTML = "⋮ 激活文本雨";
        btn.setAttribute('aria-pressed', 'false');

        matrixStopTimer = setTimeout(() => {
            matrixStopTimer = null;
            if (matrixInterval) {
                clearInterval(matrixInterval);
                matrixInterval = null;
            }
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (matrixResizeHandler) {
                window.removeEventListener('resize', matrixResizeHandler);
                matrixResizeHandler = null;
            }
        }, 1000);
    }
}

function toggleMatrixRain() {
    setMatrixRain(!isMatrixOn);
}

// —— 文本雨悬浮按钮给吸顶页签条让位 ——
// 手机上（≤560px）这个按钮钉在右下角，页签条还没滚到吸顶位置、恰好落进视口底部那一段时
// 两者会叠上：窗口 512×800（视口实测 512×702）下按钮在 662–690，压着「全书对比」页签的
// 682–719，`elementFromPoint` 在页签右上角命中的是按钮——那一下点击就被文本雨吃掉了。
// 病根是层叠上下文，不是 z-index 大小：.container 带 backdrop-filter（配上 position:relative;
// z-index:1），整棵子树在根上下文里只算 z-index 1——页签条自己的 z-index:30 根本出不去，
// 按钮只要在它上面（20 也好 9999 也好）就永远赢。既然比不出高下，就几何让位：
// 两者矩形相交时把按钮抬到页签条上沿之上，不相交就还原。
// 桌面档按钮钉在右上角（top:20px），跟页签条不在一条线上；两档靠 CSS 里的
// --anchored-bottom 分开（只有 ≤560px 那条规则给它赋值）。**不能**拿
// getComputedStyle(btn).top 来判断：对定位元素浏览器返回的是算好的像素值
// （实测返回 "662px" 而不是 "auto"），那样永远会走进桌面分支。
function matrixBtnAnchoredBottom() {
    const btn = document.getElementById('btn-matrix');
    if (!btn) return null;
    const v = parseFloat(getComputedStyle(btn).getPropertyValue('--anchored-bottom'));
    return isFinite(v) ? v : null;
}

let matrixBtnDodgeRaf = 0;

function syncMatrixBtnDodge() {
    matrixBtnDodgeRaf = 0;
    const btn = document.getElementById('btn-matrix');
    const nav = document.querySelector('.tab-navigation');
    if (!btn || !nav) return;

    const rest = matrixBtnAnchoredBottom();
    if (rest === null) {
        // 桌面档：内联的 bottom 必须摘干净——top 与 bottom 同时有值、高度又是 auto 时，
        // 盒子会被拉伸成从上沿到下沿的长条，而不是保持一颗药丸。
        if (btn.style.bottom) btn.style.bottom = '';
        return;
    }

    // 判断只用「页签条的矩形」＋「按钮不躲时该在的位置」，刻意不读按钮当前的矩形：
    // 否则抬起后不相交 → 还原 → 又相交 → 再抬起，会自激成抖动。
    const vh = window.innerHeight;
    const h = btn.offsetHeight;
    const restBottomEdge = vh - rest;      // 不躲时按钮下沿的 y
    const restTop = restBottomEdge - h;    // 不躲时按钮上沿的 y
    const bar = nav.getBoundingClientRect();

    let next = rest;
    if (bar.bottom > restTop && bar.top < restBottomEdge) {
        // 抬到页签条上沿之上 12px；视口极矮时再夹一下，别把按钮顶出屏幕。
        next = Math.min(Math.max(rest, vh - bar.top + 12), Math.max(0, vh - h - 4));
    }

    const cur = parseFloat(btn.style.bottom);
    if (!(isFinite(cur) && Math.abs(cur - next) < 0.5)) btn.style.bottom = next + 'px';
}

// rAF 合并：滚动时一帧里可能来好几个事件，量矩形只做一次。
function scheduleMatrixBtnDodge() {
    if (matrixBtnDodgeRaf) return;
    matrixBtnDodgeRaf = requestAnimationFrame(syncMatrixBtnDodge);
}

// 系统是否要求「减少动态效果」。原本只用来决定文本雨的默认开关，而页面里真正会动的
// 东西（d3 的过渡、星系的力导向收敛）一条都没走这个判断——用户在系统里关了动效，
// 打开这里照样满屏飞。下面这个函数给所有 d3 过渡用：要减少动效时把时长压成 0
// （瞬时到位，不是不动：不动的话柱状图会停在上一次的旧高度上）。
// 输入是不是手指。和 CSS 里那段 (pointer: coarse) 是同一个判断——用屏幕宽度判断
// 会误伤平板横屏和带触摸屏的笔记本（见 d3-style.css 末尾的说明）。
function usesCoarsePointer() {
    try {
        return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch (e) {
        return false;
    }
}

function prefersReducedMotion() {
    try {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
        return false;
    }
}

function motionDuration(ms) {
    return prefersReducedMotion() ? 0 : ms;
}