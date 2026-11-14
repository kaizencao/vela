// 后台 service worker：侧边栏行为、右键菜单（快捷动作组动态生成）、pendingTask 中转。
// 不做网络请求——流式 fetch 与页面功能编排全在面板/聊天页上下文里执行，规避 MV3 SW 30 秒回收。

import { loadSettings, DEFAULT_QUICK_ACTIONS } from '../llm/store.js';
import { DRAFT_KEY, DRAFT_MAX_PAGES, PAGE_CTX_MAX, pageKeyOf, addItem, removeItems, setPageText } from '../mindmap/draft.js';
import { isPdfUrl, pdfNameFromUrl } from '../page/pdf-doc.js';
import { pageToMarkdown } from '../content/injected.js';

const MENU_ROOT = 'om-root';
const MENU_CHAT_TAB = 'om-chat-tab';
const MENU_TRANSLATE = 'om-translate-page';
const MENU_READ_SERIES = 'om-read-series';
const MENU_DOWNLOAD_MD = 'om-download-md';
const MENU_PDF_SUM = 'om-pdf-sum';
const MENU_PDF_TRANS = 'om-pdf-trans';
const menuActionId = (actionId) => `om-qa:${actionId}`;

async function rebuildMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create(
    { id: MENU_ROOT, title: 'Vela', contexts: ['selection', 'page'] },
    () => void chrome.runtime.lastError,
  );
  chrome.contextMenus.create(
    { id: MENU_CHAT_TAB, parentId: MENU_ROOT, title: '打开独立聊天页', contexts: ['selection', 'page'] },
    () => void chrome.runtime.lastError,
  );
  chrome.contextMenus.create(
    { id: MENU_TRANSLATE, parentId: MENU_ROOT, title: '翻译此网页', contexts: ['page'] },
    () => void chrome.runtime.lastError,
  );
  chrome.contextMenus.create(
    { id: MENU_READ_SERIES, parentId: MENU_ROOT, title: '连读此文档（跟随下一页）', contexts: ['page'] },
    () => void chrome.runtime.lastError,
  );
  chrome.contextMenus.create(
    { id: MENU_DOWNLOAD_MD, parentId: MENU_ROOT, title: '下载此网页为 Markdown', contexts: ['page'] },
    () => void chrome.runtime.lastError,
  );
  // PDF 链接入口（内建 PDF 查看器注入不了内容脚本，链接右键是 PDF 的一期主入口）。
  // contextMenus 无法按链接目标过滤：所有链接右键都会显示，点击时非 PDF 静默忽略
  chrome.contextMenus.create(
    { id: MENU_PDF_SUM, title: 'Vela：总结此 PDF', contexts: ['link'] },
    () => void chrome.runtime.lastError,
  );
  chrome.contextMenus.create(
    { id: MENU_PDF_TRANS, title: 'Vela：翻译此 PDF', contexts: ['link'] },
    () => void chrome.runtime.lastError,
  );
  chrome.contextMenus.create(
    { id: 'om-qa-sep', parentId: MENU_ROOT, type: 'separator', contexts: ['selection'] },
    () => void chrome.runtime.lastError,
  );
  const { quickActions } = await loadSettings();
  for (const qa of quickActions) {
    chrome.contextMenus.create(
      { id: menuActionId(qa.id), parentId: MENU_ROOT, title: qa.title, contexts: ['selection'] },
      () => void chrome.runtime.lastError,
    );
  }
}

// 页面常驻浮窗 + 划词工具条：persistAcrossSessions 的注册在扩展重载后仍存活，Chrome 会继续用
// 缓存的旧脚本内容注入（改了脚本不重新注册的话，页面刷新拿到的还是旧代码，
// 表现为改完 logo/文案后浮窗一直不变）。每次 onInstalled 都 updateContentScripts
// 强制按当前磁盘文件重读；id 不存在时回落注册。
const WIDGET_SCRIPT = {
  id: 'om-widget',
  matches: ['http://*/*', 'https://*/*'],
  js: ['src/content/widget.js', 'src/content/selection-popup.js'],
  runAt: 'document_idle',
  persistAcrossSessions: true,
};
async function ensureWidgetRegistered() {
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    if (registered.some((s) => s.id === 'om-widget')) {
      await chrome.scripting.updateContentScripts([WIDGET_SCRIPT]);
      return;
    }
    await chrome.scripting.registerContentScripts([WIDGET_SCRIPT]);
  } catch (e) {
    console.error('浮窗注册失败:', e);
  }
}

// 安装/更新时向已打开的 http(s) 标签页补注浮窗（注册式注入只对之后加载的页面生效）。
// 安装窗口内（30 秒）还有加载中的页面：导航在注册生效前已开始的页面注册式注入赶不上，
// 立即 executeScript 又可能落进即将被替换的旧文档，两头落空（表现为装好/更新后该页划词无工具条、
// 后台 om:open-card 报 Receiving end does not exist）。窗口内每个加载完成的页面再补一次；
// 重复注入由脚本自身的单例守卫去重
async function backfillWidgetTabs() {
  const files = ['src/content/widget.js', 'src/content/selection-popup.js'];
  const inject = (tabId) => chrome.scripting.executeScript({ target: { tabId }, files }).catch(() => {});
  const onUpdated = (tabId, info, tab) => {
    if (info.status === 'complete' && /^https?:/i.test(tab?.url || '')) inject(tabId);
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  setTimeout(() => chrome.tabs.onUpdated.removeListener(onUpdated), 30000);
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const t of tabs) if (t.id != null && !t.discarded) inject(t.id);
  } catch (e) {
    console.error('浮窗补注失败:', e);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  // 工具栏图标 / Ctrl+M 不开原生侧边栏：原生面板窗口级常驻、跟随新标签页出现且无关闭 API。
  // 图标动作改由 action.onClicked 开关当前标签页的页内聊天卡；原生面板只能从
  // Chrome 自带的侧边栏下拉显式打开（不再设扩展自己的入口）。
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((e) => console.error('setPanelBehavior 失败:', e));
  await rebuildMenus();
  await ensureWidgetRegistered();
  await backfillWidgetTabs();
});

// 顶层聊天界面（原生侧边栏 / 独立聊天页）可见时广播：收起各页面浮窗的聊天卡，
// 避免侧边栏与聊天卡并存（原生侧边栏没有关闭 API，只能反向收卡）
async function closeCardsInAllTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.allSettled(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'om:close-card' })));
  } catch { /* 标签查询失败忽略 */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'om:refresh-menus') {
    rebuildMenus();
    return;
  }
  if (msg?.type === 'om:panel-visible') {
    closeCardsInAllTabs();
    return;
  }
  if (msg?.type === 'om:open-options') {
    chrome.runtime.openOptionsPage().catch(() => {});
    return;
  }
  if (msg?.type === 'om:capture-visible-tab') {
    // 高亮像素终验用：内容脚本无截屏权限，由 SW 截来源窗口的可见标签页回传 dataUrl。
    // host_permissions <all_urls> 已覆盖 captureVisibleTab 所需授权
    chrome.tabs.captureVisibleTab(sender?.tab?.windowId, { format: 'png' }, (dataUrl) => {
      sendResponse(chrome.runtime.lastError ? { ok: false } : { ok: true, dataUrl });
    });
    return true; // 异步 sendResponse
  }
  if (msg?.type === 'om:widget-action') {
    handleWidgetAction(msg, sender.tab)
      .then((res) => sendResponse(res ?? { ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // 异步 sendResponse
  }
  if (msg?.type === 'om:mindmap-collect') {
    collectMindmap(msg, sender.tab)
      .then((res) => sendResponse(res ?? { ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // 异步 sendResponse
  }
});

// 高亮 → 本页思维导图素材库（omMindmapInbox，按页 key 聚合）。只写 storage 属路由职责，
// 不碰网络；页来源以 sender 标签页为准（页 key 不可信内容拼不出来）。条目清空即删，
// 防无限增长按 updatedAt 淘汰最久未更新的页。
async function collectMindmap(msg, tab) {
  const texts = (Array.isArray(msg?.texts) ? msg.texts : [msg?.texts])
    .map((t) => String(t || ''))
    .filter((t) => t.trim())
    .slice(0, 20);
  if (!texts.length) return { ok: false };
  const key = pageKeyOf(tab?.url || msg?.url || '');
  if (!/^https?:/i.test(key)) return { ok: false, reason: 'not-web-page' };
  const title = String(msg?.title || tab?.title || '').slice(0, 200);
  const o = await chrome.storage.local.get(DRAFT_KEY);
  const all = o[DRAFT_KEY] || {};
  const cur = all[key] || { url: key, title: '', items: [] };
  const page = msg.op === 'remove' ? removeItems(cur, texts) : addItem(cur, { texts, title, ts: Date.now() });
  if (page.items.length) all[key] = page;
  else delete all[key];
  const keys = Object.keys(all);
  if (keys.length > DRAFT_MAX_PAGES) {
    keys.sort((a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0));
    for (const k of keys.slice(0, keys.length - DRAFT_MAX_PAGES)) delete all[k];
  }
  await chrome.storage.local.set({ [DRAFT_KEY]: all });
  return { ok: true, count: page.items.length };
}

async function resolveQuickAction(actionId) {
  const { quickActions } = await loadSettings();
  return quickActions.find((a) => a.id === actionId)
    ?? DEFAULT_QUICK_ACTIONS.find((a) => a.id === actionId);
}

// 浮窗动作 → 后台只写 pendingTask，LLM 由浮窗自行打开的页内聊天卡执行。
// 划词工具条（from: 'sel-popup'）没有本地开卡能力：写完任务后由后台回开聊天卡。
// ask 默认「快速提问」预填输入框；面板追问带 autoSend 直接发送。
async function handleWidgetAction(msg, tab) {
  const ts = Date.now();
  if (msg.kind === 'page-summary' || msg.kind === 'translate-page' || msg.kind === 'read-series') {
    await chrome.storage.session.set({ pendingTask: { kind: msg.kind, tabId: tab?.id ?? null, ts } });
    return { ok: true };
  }
  if (msg.kind === 'ask') {
    if (msg.from === 'sel-popup' && tab) await openChatInTab(tab);
    await chrome.storage.session.set({
      pendingTask: {
        kind: 'ask',
        title: '快速提问',
        prompt: (msg.selection || '').slice(0, 8000),
        sourceUrl: tab?.url || '',
        autoSend: msg.autoSend === true,
        ts,
      },
    });
    return { ok: true };
  }
  if (msg.kind === 'mindmap') {
    // 查看本页思维导图：任务参数一次性暂存 session 再开查看页（避开 URL 长度限制）。
    // 高亮素材来自 omMindmapInbox（见 om:mindmap-collect）；生成由用户在查看页里显式点击，
    // 流式生成也在查看页跑（MV3 约束，不进 SW）。内容脚本顺带带回页面正文快照，
    // 存进素材页条目——高亮模式作 LLM 上下文，整页模式是生成原料；没有条目也建
    //（items 为空）：整页生成不需要任何高亮素材。同样按 updatedAt 淘汰防增长。
    const url = tab?.url || '';
    if (msg.pageText && /^https?:/i.test(url)) {
      const o = await chrome.storage.local.get(DRAFT_KEY);
      const all = o[DRAFT_KEY] || {};
      const key = pageKeyOf(url);
      all[key] = setPageText(all[key] || { url: key, title: String(tab?.title || msg?.title || '').slice(0, 200), items: [], updatedAt: ts },
        { text: String(msg.pageText).slice(0, PAGE_CTX_MAX), ts });
      const keys = Object.keys(all);
      if (keys.length > DRAFT_MAX_PAGES) {
        keys.sort((a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0));
        for (const k of keys.slice(0, keys.length - DRAFT_MAX_PAGES)) delete all[k];
      }
      await chrome.storage.local.set({ [DRAFT_KEY]: all });
    }
    const jobId = `mmjob-${ts.toString(36)}`;
    await chrome.storage.session.set({
      [`omMindmapJob:${jobId}`]: {
        view: 1,
        url,
        title: String(tab?.title || msg.title || ''),
        ts,
      },
    });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/mindmap/mindmap.html#job=${jobId}`) });
    return { ok: true };
  }
  if (msg.kind === 'download-md') {
    return downloadMarkdown(tab);
  }
  if (msg.kind === 'quick-action') {
    const qa = await resolveQuickAction(msg.actionId);
    if (!qa) return { ok: false };
    const selection = (msg.selection || '').slice(0, 8000);
    const prompt = qa.prompt.includes('{text}') ? qa.prompt.replace('{text}', selection) : `${qa.prompt}\n\n${selection}`;
    if (msg.from === 'sel-popup' && tab) await openChatInTab(tab);
    await chrome.storage.session.set({
      pendingTask: { kind: 'quick-action', actionId: msg.actionId, title: qa.title, prompt, sourceUrl: tab?.url || '', ts },
    });
    return { ok: true };
  }
  return { ok: false };
}

// 向标签页浮窗发消息；无应答时先就地补注浮窗再试一次
//（扩展重载后旧页面浮窗上下文失效的常见场景，浮窗脚本自带失效自检重铺）。
// 返回 true 表示送达；页面不可注入（chrome:// 页等）返回 false。
async function messageWidget(tab, msg) {
  if (tab?.id == null) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
    return true;
  } catch { /* 本页浮窗不可用 → 补注后重试 */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/widget.js'] });
    await chrome.tabs.sendMessage(tab.id, msg);
    return true;
  } catch { /* 页面不可注入 */ return false; }
}

// 在动作来源标签页展开页内聊天卡（Monica 式：聊天窗按标签页隔离，新标签页不出现）。
// 聊天卡与原生面板同为 sidepanel.html，pendingTask 的挂载消费与 onChanged 实时消费都能接住。
// 页面不可注入时开独立聊天页兜底。绝不开原生侧边栏：原生面板窗口级常驻、无关闭 API。
async function openChatInTab(tab) {
  if (await messageWidget(tab, { type: 'om:open-card' })) return 'card';
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/chatpage/chat.html') });
  return 'tab';
}

// PDF 标签页 / PDF 链接 → 一次性任务写 storage.session，开独立聊天页按 hash 消费。
// 内建 PDF 查看器（PDFium plugin 文档）注入不了任何内容脚本，浮窗 / 页内聊天卡两路都不通；
// 聊天页里 fetch 字节 → 建知识库快照 → 跑 LLM，全在扩展页完成（流式不进 SW）。
// 返回 false 表示不是 PDF（调用方落回原有路径）
async function openPdfJob(tab, action) {
  const url = tab?.url || '';
  if (!isPdfUrl(url)) return false;
  const jobId = `pdf-${Date.now().toString(36)}`;
  await chrome.storage.session.set({
    [`omPdfJob:${jobId}`]: {
      v: 1,
      url,
      title: pdfNameFromUrl(url) || String(tab?.title || '').slice(0, 120),
      action, // 'summary' 总结 | 'translate' 翻译 | 'chat' 分析
      ts: Date.now(),
    },
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`src/chatpage/chat.html#pdf=${jobId}`) });
  return true;
}

// ---- 网页下载为 Markdown ----
// 编排全在 SW：executeScript 注入 injected.js 的 pageToMarkdown 原样转换（自包含函数），
// 拿到 md 后交离屏文档造 Blob 落盘。SW 不能 URL.createObjectURL，data: URL 有 ~2MB 上限，
// chrome.offscreen 是官方给 blob 下载留的通道（minimum_chrome_version 116 > 109，可用）。

// 文件名：<页面标题>.md。safeFilename（browser-tools.js）同规则就地内联——那是页面模块，SW 不 import
function mdFilename(title) {
  const safe = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '').slice(0, 80).trim();
  return `${safe || 'page'}.md`;
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'src/page/offscreen.html',
    reasons: ['BLOBS'],
    justification: '把网页 Markdown 经 Blob 落盘下载（SW 不能 createObjectURL）',
  });
}

// 在途下载计数：归零后延时关文档，避免连续下载每次都建/关一轮（createDocument 有冷启动开销）
let offscreenBusy = 0;

// createDocument 返回时离屏模块脚本可能还没挂上 onMessage（报 Receiving end does not exist）：
// 轮询重发直到送达（上限约 3s）。只对「未送达」类错误重试——「message port closed」说明已送达
// 只是没等到回执，重发会触发第二次下载，直接抛给上层按失败处理。
async function sendOffscreen(msg) {
  for (let i = 0; i < 12; i++) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      const text = e?.message || String(e);
      if (!/Receiving end does not exist/i.test(text)) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('离屏文档未就绪');
}

// 离屏锚点点击后立即回执；落定由 SW 查 downloads 记录确认（blob URL 精确匹配），250ms × 120 ≈ 30s
async function waitDownloadDone(url) {
  for (let i = 0; i < 120; i++) {
    const list = await chrome.downloads.search({ url }).catch(() => []);
    const rec = list[0];
    if (rec && (rec.state === 'complete' || rec.state === 'interrupted')) {
      return rec.state === 'complete' ? { ok: true } : { ok: false, error: rec.error || '下载中断' };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, error: '下载超时' };
}

async function downloadViaOffscreen(content, filename) {
  await ensureOffscreen();
  offscreenBusy += 1;
  try {
    return await Promise.race([
      (async () => {
        const res = await sendOffscreen({ type: 'om:offscreen-download', content, filename });
        if (!res?.ok) return res ?? { ok: false, error: '离屏文档无回执' };
        return waitDownloadDone(res.url);
      })(),
      new Promise((r) => setTimeout(() => r({ ok: false, error: '下载超时' }), 30000)),
    ]);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    offscreenBusy -= 1;
    setTimeout(() => {
      if (offscreenBusy <= 0) chrome.offscreen.closeDocument().catch(() => { /* 已关或不存在 */ });
    }, 15000);
  }
}

// 入口（右键菜单 / 浮窗「下载 MD」钮）都汇到这里。不可注入或空内容返回 { ok:false }：
// 菜单侧静默忽略，浮窗侧据此亮「动作失败」提示
async function downloadMarkdown(tab) {
  if (!tab?.id || !/^https?:/i.test(tab.url || '')) return { ok: false };
  let first;
  try {
    [first] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageToMarkdown });
  } catch {
    return { ok: false }; // PDF / chrome:// 等页面注入不了：静默
  }
  const { title, md } = first?.result || {};
  if (!md || !String(md).trim()) return { ok: false };
  return downloadViaOffscreen(String(md), mdFilename(title));
}

// 工具栏图标 / Ctrl+M（_execute_action）：开关当前标签页的页内聊天卡；
// PDF 页默认发起总结（注入不了浮窗）；无浮窗页面（chrome:// 新标签页等）回落独立聊天页标签。
chrome.action.onClicked.addListener(async (tab) => {
  if (await openPdfJob(tab, 'summary')) return;
  if (!(await messageWidget(tab, { type: 'om:toggle-card' }))) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/chatpage/chat.html') });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_CHAT_TAB) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/chatpage/chat.html') });
    return;
  }
  if (info.menuItemId === MENU_PDF_SUM || info.menuItemId === MENU_PDF_TRANS) {
    await openPdfJob({ url: info.linkUrl || '' }, info.menuItemId === MENU_PDF_TRANS ? 'translate' : 'summary');
    return; // 非 PDF 链接：静默忽略（菜单无法按目标过滤）
  }
  if (info.menuItemId === MENU_TRANSLATE) {
    if (await openPdfJob(tab, 'translate')) return; // PDF 页没有可注入的正文：转整份文档管线
    await openChatInTab(tab); // 先开聊天界面再写任务，界面加载后经 onChanged 消费
    await chrome.storage.session.set({
      pendingTask: { kind: 'translate-page', tabId: tab?.id ?? null, ts: Date.now() },
    });
    return;
  }
  if (info.menuItemId === MENU_READ_SERIES) {
    if (await openPdfJob(tab, 'summary')) return; // PDF 没有「下一页」可跟：连读退化为总结
    await openChatInTab(tab);
    await chrome.storage.session.set({
      pendingTask: { kind: 'read-series', tabId: tab?.id ?? null, ts: Date.now() },
    });
    return;
  }
  if (info.menuItemId === MENU_DOWNLOAD_MD) {
    await downloadMarkdown(tab); // 不可注入页面（PDF 等）静默失败，与 PDF 链接菜单同约定
    return;
  }
  if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('om-qa:')) {
    const actionId = info.menuItemId.slice(6);
    const qa = await resolveQuickAction(actionId);
    if (!qa) return;
    const selection = (info.selectionText || '').slice(0, 2000);
    const prompt = qa.prompt.includes('{text}') ? qa.prompt.replace('{text}', selection) : `${qa.prompt}\n\n${selection}`;
    await openChatInTab(tab);
    await chrome.storage.session.set({
      pendingTask: {
        kind: 'quick-action',
        actionId,
        title: qa.title,
        prompt,
        sourceUrl: tab?.url || '',
        ts: Date.now(),
      },
    });
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-chat-tab') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/chatpage/chat.html') });
  }
  // _execute_action（Ctrl+M）与工具栏图标同走 action.onClicked：开关本页聊天卡
});
