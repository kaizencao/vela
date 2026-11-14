// 自包含页面提取函数：经 chrome.scripting.executeScript({func}) 序列化进页面执行。
// 约束：每个导出函数必须完全自包含——不引用外部作用域、不做 import。

// 网页正文提取（总结用）：挑文本密度最高的候选容器，读 innerText。
// 返回 { title, url, text }；空页面返回 { text: '' }。
export function extractArticle() {
  const SKIP = 'script,style,noscript,template,iframe,svg,canvas,nav,footer,aside,form,button';
  const clones = document.querySelectorAll(SKIP);
  const hidden = [];
  // 记下原内联 display 再隐藏：还原时写回原值，不能一律清空——
  // 页面自己用内联 display:none 藏起来的菜单/弹层会被意外显示出来
  for (const n of clones) { hidden.push([n, n.style.display]); n.style.display = 'none'; }
  let title = document.title || '';
  let best = null;
  let bestScore = 0;
  const candidates = document.querySelectorAll(
    'article, main, [role="main"], #content, .content, .post, .article, .markdown-body',
  );
  for (const c of candidates) {
    const text = c.innerText || '';
    const score = text.length * (c.matches('article, main, [role="main"]') ? 1.2 : 1);
    if (text.length > 200 && score > bestScore) { best = c; bestScore = score; }
  }
  const container = best || document.body;
  const text = (container.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  for (const [n, display] of hidden) n.style.display = display;
  return {
    title,
    url: location.href,
    text,
    usedContainer: best ? 'main' : 'body',
  };
}

// 当前选区文本（LLM 任务模式 get_selection 工具用）。输入框内的选区 getSelection 拿不到，单独读
export function getSelectionText() {
  const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|email)$/i.test(a.type)))) {
    const t = a.value.slice(a.selectionStart ?? 0, a.selectionEnd ?? 0);
    if (t.trim()) return { title: document.title, url: location.href, text: t };
  }
  return { title: document.title, url: location.href, text: String(window.getSelection() || '') };
}

// 连续阅读：收集本页链接清单与 <link rel=next> 声明，交 src/read/series.js 的打分挑「下一页」。
// 归一化逻辑与 series.js normalizeUrl 同款（经典脚本禁 import，就地内联）：去 hash、只收 http(s)、相对地址按本页解析
export function collectAnchors() {
  const norm = (raw) => {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    try {
      const u = new URL(s, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      u.hash = '';
      return u.href;
    } catch { return ''; }
  };
  const linkNext = norm(document.querySelector('link[rel="next" i]')?.getAttribute('href') || '');
  const anchors = [];
  for (const a of document.querySelectorAll('a[href]')) {
    if (anchors.length >= 800) break;
    const href = norm(a.getAttribute('href') || '');
    if (!href) continue;
    anchors.push({
      href,
      text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      rel: (a.getAttribute('rel') || '').toLowerCase().split(/\s+/).filter(Boolean),
      inNav: !!a.closest('nav,footer,[role="navigation"],[class*="pag"],[class*="next"]'),
      order: anchors.length,
    });
  }
  return { linkNext, anchors };
}

// ---------- LLM 任务模式：页内元素快照 / 点击 / 等待 / 配方采集 ----------
// 同为自包含函数，经 executeScript({func, args}) 注入目标标签页执行（ISOLATED world）。
// 元素引用落在页内 data-om-ref 属性上：扩展侧零状态，页面重渲染后旧 ref 查不到，
// 由调用方识别并提示模型重新快照。ref 值固定 omx-<n> 前缀，方便清理与防串。

// 可交互元素快照：编号 + 打 data-om-ref。只列可见元素，本扩展自己的浮层跳过
export function snapInteractive(maxItems) {
  // 短 CSS 路径（id 优先截断，否则同标签兄弟 nth-of-type，最多 5 层）——给模型当结构线索
  // 用，不保证全局唯一。函数定义在体内：executeScript 只序列化函数本体，模块内辅助函数
  // 不会跟着进页面（自包含红线）
  const omPathOf = (el) => {
    const parts = [];
    let n = el;
    for (let d = 0; n && n.nodeType === 1 && d < 5; d++, n = n.parentElement) {
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift('#' + n.id); break; }
      let s = n.tagName.toLowerCase();
      const p = n.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const cap = Math.min(Math.max(Number(maxItems) || 80, 10), 300);
  for (const old of document.querySelectorAll('[data-om-ref^="omx-"]')) old.removeAttribute('data-om-ref');
  const SEL = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[onclick],[tabindex]:not([tabindex="-1"])';
  const items = [];
  let total = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (el.closest('[id^="om-"]')) continue; // 本扩展浮窗 / 悬停弹层等自有宿主
    try { if (el.checkVisibility && !el.checkVisibility()) continue; } catch { /* 判不了按可见算 */ }
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    total++;
    if (items.length >= cap) continue;
    const n = items.length + 1;
    el.setAttribute('data-om-ref', `omx-${n}`);
    const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '';
    items.push({
      n,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      aria: String(aria).replace(/\s+/g, ' ').trim().slice(0, 40),
      value: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? String(el.value || '').slice(0, 40) : '',
      path: omPathOf(el),
    });
  }
  return { title: document.title || '', url: location.href.split('#')[0], total, truncated: total > cap, items };
}

// 按 ref 真实点击：完整鼠标事件序列（pointer/mouse down-up-click，中心点坐标，事件冒泡穿透
// shadow 边界），比 el.click() 兼容 React 合成事件与 mousedown/mouseup 分步监听的站点。
// 合成事件 isTrusted=false，行为检测严格的站点可能不响应——已知边界
export function clickByRef(ref) {
  const el = document.querySelector(`[data-om-ref="${ref}"]`);
  if (!el) return { ok: false, error: 'ref 已过期（页面可能已重渲染或已跳转），请重新 snapshot_interactive' };
  try { el.scrollIntoView({ block: 'center' }); } catch { /* 已在视口外兜底直接点 */ }
  const r = el.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
  };
  try { if (typeof el.focus === 'function') el.focus(); } catch { /* 不可聚焦元素 */ }
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Ev = t.startsWith('pointer') && window.PointerEvent ? window.PointerEvent : MouseEvent;
    el.dispatchEvent(new Ev(t, opts));
  }
  return {
    ok: true,
    clicked: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    url: location.href.split('#')[0],
  };
}

// 等待信号：文本子串 / 选择器出现（或 gone=true 时消失），无信号参数就是纯延时。
// 250ms 轮询在页面里跑，超时返回 { ok:false, timeout:true } 不抛错
export function waitSignal(text, selector, ms, gone) {
  const budget = Math.min(Math.max(Number(ms) || 8000, 200), 30000);
  const t0 = Date.now();
  const has = () => {
    try {
      if (selector) return gone ? !document.querySelector(selector) : !!document.querySelector(selector);
      if (text) {
        const hit = (document.body?.innerText || '').includes(text);
        return gone ? !hit : hit;
      }
    } catch { /* 选择器语法错误按永不满足处理 */ }
    return true;
  };
  return new Promise((resolve) => {
    const tick = () => {
      if (has()) { resolve({ ok: true, ms: Date.now() - t0 }); return; }
      if (Date.now() - t0 >= budget) { resolve({ ok: false, timeout: true, ms: budget }); return; }
      setTimeout(tick, 250);
    };
    setTimeout(tick, 120);
  });
}

// 配方采集：列出列表项（翻页与逐项迭代都每轮重查——SPA 重渲染后旧引用会失效）。
// 不做可见性过滤：过滤会让这里的下标与逐项点击的下标错位，可见性检查放在快照层
export function listRecipeItems(itemsSel, scopeSel, sampleLimit) {
  let root = document;
  if (scopeSel) {
    root = document.querySelector(scopeSel);
    if (!root) return { error: `容器选择器没匹配到元素：${scopeSel}` };
  }
  let els;
  try { els = [...root.querySelectorAll(itemsSel)]; } catch { return { error: `选择器语法错误：${itemsSel}` }; }
  return {
    count: els.length,
    samples: els.slice(0, Math.min(Number(sampleLimit) || 3, 10)).map((el, i) => ({
      i: i + 1,
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    })),
  };
}

// 按下标点击列表项（clickSel 相对项内；省略 = 点项本身）
export function clickRecipeItem(itemsSel, scopeSel, clickSel, index) {
  let root = document;
  if (scopeSel) {
    root = document.querySelector(scopeSel);
    if (!root) return { ok: false, error: `容器没找到：${scopeSel}` };
  }
  const el = root.querySelectorAll(itemsSel)[index];
  if (!el) return { ok: false, error: `第 ${index + 1} 项没找到（列表可能已变短）` };
  const target = clickSel ? el.querySelector(clickSel) : el;
  if (clickSel && !target) return { ok: false, error: `项内点击目标没找到：${clickSel}` };
  try { target.scrollIntoView({ block: 'center' }); } catch { /* 同 clickByRef */ }
  const r = target.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
  };
  try { if (typeof target.focus === 'function') target.focus(); } catch { /* 不可聚焦 */ }
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Ev = t.startsWith('pointer') && window.PointerEvent ? window.PointerEvent : MouseEvent;
    target.dispatchEvent(new Ev(t, opts));
  }
  return { ok: true };
}

// 按配方读一行字段：rel='item' 相对列表项（详情展开在项内），rel='page' 相对整页或
// fieldsScope 容器（详情渲染在页面别处）。读不到的字段记 null 不中断
export function extractRecipeFields(itemsSel, scopeSel, fields, fieldsScopeSel, rel, index) {
  let scopeRoot = document;
  if (scopeSel) {
    scopeRoot = document.querySelector(scopeSel);
    if (!scopeRoot) return { error: `容器没找到：${scopeSel}` };
  }
  const item = scopeRoot.querySelectorAll(itemsSel)[index];
  if (!item) return { error: `第 ${index + 1} 项没找到` };
  let base = rel === 'item' ? item : (fieldsScopeSel ? document.querySelector(fieldsScopeSel) : document);
  if (rel !== 'item' && fieldsScopeSel && !base) return { error: `详情容器没找到：${fieldsScopeSel}` };
  const row = {};
  for (const f of fields) {
    let v = null;
    try {
      const t = base.querySelector(f.selector);
      if (t) {
        const raw = f.attr ? t.getAttribute(f.attr) : (t.innerText || t.textContent || '');
        v = String(raw).replace(/\s+/g, ' ').trim().slice(0, 300) || null;
      }
    } catch { v = null; }
    row[f.name] = v;
  }
  return row;
}

// 点「下一页」；不存在 / 禁用返回 gone，调用方按末页处理
export function clickRecipeNext(clickSel) {
  const el = document.querySelector(clickSel);
  if (!el) return { ok: false, gone: true };
  if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled')) {
    return { ok: false, gone: true, reason: 'disabled' };
  }
  try { el.scrollIntoView({ block: 'center' }); } catch { /* 同上 */ }
  const r = el.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
  };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Ev = t.startsWith('pointer') && window.PointerEvent ? window.PointerEvent : MouseEvent;
    el.dispatchEvent(new Ev(t, opts));
  }
  return { ok: true };
}

// ---------- 整页转 Markdown（下载网页为 .md 用） ----------
// 原样遍历 document.body，不做正文抽取：只剔除脚本 / 样式 / 表单控件 / iframe / 隐藏子树
// （display:none、visibility:hidden、aria-hidden——轮播图与弹窗的不可见副本随之消失）。
// 隐藏判断依赖渲染样式，getComputedStyle 只在活文档上有值，因此只读遍历原树、不克隆。
// 返回 { title, url, md }。全自包含（executeScript 只序列化函数本体）。
export function pageToMarkdown() {
  // 整段丢弃的标签：无 Markdown 对应物的非内容元素
  const SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO',
    'OBJECT', 'EMBED', 'LINK', 'META', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'DATALIST',
    'SOURCE', 'TRACK', 'MAP', 'AREA', 'MATH',
  ]);
  // 块级标签：前后由调用方补空行；其余标签当透明容器拼接内联内容
  const BLOCK = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'PRE', 'BLOCKQUOTE',
    'HR', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE',
    'FIGCAPTION', 'DL', 'DT', 'DD', 'DETAILS', 'SUMMARY', 'ADDRESS', 'FIELDSET', 'FORM', 'TR',
  ]);

  const isHidden = (el) => {
    if (el.hidden) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  };
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return String(u || ''); } };

  // 行内文本轻转义：只处理会改变 Markdown 语义的记号，保可读性、不穷举全部可转义字符
  const escText = (raw, atLineStart, inCell) => {
    let s = String(raw).replace(/[ \t\r\n\f]+/g, ' ');
    if (!s.trim()) return '';
    s = s.replace(/\\/g, '\\\\').replace(/!(?=\[)/g, '\\!').replace(/([`*_\[\]])/g, '\\$1').replace(/</g, '\\<');
    if (inCell) s = s.replace(/\|/g, '\\|');
    if (atLineStart) {
      s = s.replace(/^([-+#>])(?=\s)/, '\\$1');
      s = s.replace(/^(\d+)(\.)(?=\s)/, '$1\\$2');
    }
    return s;
  };

  // 行内片段渲染：a/strong/em/code/img/br 有着落，其余行内标签透传子节点
  const inlineOf = (node, inCell = false) => {
    if (node.nodeType === 3) return escText(node.textContent, false, inCell);
    if (node.nodeType !== 1) return '';
    const tag = node.tagName;
    if (SKIP.has(tag) || isHidden(node)) return '';
    const inner = () => node.childNodes.length ? [...node.childNodes].map((n) => inlineOf(n, inCell)).join('') : '';
    if (tag === 'BR') return '\n';
    if (tag === 'A') {
      const href = node.getAttribute('href');
      if (!href || /^(javascript|mailto|tel):/i.test(href)) return inner(); // 空链 / 脚本链只留文字
      const label = inner().trim() || abs(href);
      return `[${label}](${abs(href)})`;
    }
    if (tag === 'IMG') {
      const src = node.getAttribute('src') || '';
      const alt = String(node.getAttribute('alt') || '');
      if (!src || /^data:/i.test(src)) return alt; // data: 图不动进 Markdown（体积失控），留 alt 文字
      return `![${escText(alt, false, inCell)}](${abs(src)})`;
    }
    if (tag === 'STRONG' || tag === 'B') return `**${inner().trim()}**`;
    if (tag === 'EM' || tag === 'I') return `*${inner().trim()}*`;
    if (tag === 'DEL' || tag === 'S') return `~~${inner().trim()}~~`;
    if (tag === 'MARK') return `**${inner().trim()}**`;
    if (tag === 'CODE') {
      const c = node.textContent.replace(/\s+/g, ' ');
      // 含反引号按 CommonMark 用空格 + 双反引号包边；转义不适用于行内码（内容原样保留）
      return /`/.test(c) ? '` ' + c.replace(/`+$/, '') + ' `' : '`' + c + '`';
    }
    return inner();
  };

  // GFM 管道表：第一行当表头（col/rowspan 不展开，各自成格）
  const tableOf = (el) => {
    const cell = (td) => [...td.childNodes].map((n) => inlineOf(n, true)).join('').replace(/\n/g, ' ').replace(/ {2,}/g, ' ').trim() || ' ';
    const rows = [...el.rows].map((tr) => [...tr.cells].map(cell));
    if (!rows.length) return '';
    const head = rows[0];
    const line = (cells) => `| ${cells.join(' | ')} |`;
    return [line(head), `| ${head.map(() => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
  };

  // 列表：marker 打在 li 首段行首，后续行与嵌套列表按 marker 宽度缩进
  const listOf = (el, depth) => {
    const ordered = el.tagName === 'OL';
    const lines = [];
    let i = 1;
    for (const li of el.children) {
      if (li.tagName !== 'LI' || isHidden(li)) continue;
      const marker = ordered ? `${i++}. ` : '- ';
      const pad = ' '.repeat(marker.length);
      const childLists = [...li.children].filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
      const inline = [...li.childNodes].filter((n) => !(n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL')))
        .map((n) => inlineOf(n)).join('').replace(/\s+/g, ' ').trim();
      const bodyLines = (inline ? inline.split('\n') : []);
      bodyLines.forEach((l, k) => lines.push(`${k === 0 ? marker : pad}${l}`));
      if (!bodyLines.length) lines.push(marker.trimEnd());
      for (const sub of childLists) {
        const subMd = listOf(sub, depth + 1);
        // 嵌套列表整体按父 marker 宽度缩进（首个 marker 行已带序号语义）
        lines.push(...subMd.split('\n').map((l) => pad + l));
      }
    }
    return lines.join('\n');
  };

  // 块级渲染：按标签分发；DIV 等容器递归切块（连续内联内容合成段落）
  const renderBlock = (el) => {
    const tag = el.tagName;
    if (SKIP.has(tag) || isHidden(el)) return '';
    if (/^H[1-6]$/.test(tag)) {
      const t = [...el.childNodes].map((n) => inlineOf(n)).join('').replace(/\s+/g, ' ').trim();
      return t ? `${'#'.repeat(+tag[1])} ${t}` : '';
    }
    if (tag === 'P') {
      const kids = [...el.childNodes];
      let t = '';
      kids.forEach((n, k) => {
        // 段首文本按行首转义（「- x」「# x」「1. x」开头的普通段落不被当 Markdown 记号）
        if (k === 0 && n.nodeType === 3) t += escText(n.textContent, true, false);
        else t += inlineOf(n);
      });
      t = t.replace(/ {2,}/g, ' ').trim();
      return t || '';
    }
    if (tag === 'PRE') {
      const raw = (el.querySelector('code')?.textContent ?? el.textContent).replace(/\r/g, '').replace(/\n+$/, '');
      if (!raw.trim()) return '';
      const runs = raw.match(/`+/g);
      const ticks = '`'.repeat(Math.max(3, (runs ? Math.max(...runs.map((r) => r.length)) : 0) + 1));
      return `${ticks}\n${raw}\n${ticks}`;
    }
    if (tag === 'UL' || tag === 'OL') return listOf(el, 0);
    if (tag === 'TABLE') return tableOf(el);
    if (tag === 'HR') return '---';
    if (tag === 'BLOCKQUOTE') {
      const inner = blocksOf(el).join('\n\n');
      return inner ? inner.split('\n').map((l) => `> ${l}`).join('\n') : '';
    }
    if (tag === 'DL') {
      const out = [];
      for (const n of el.children) {
        if (n.tagName === 'DT') out.push(`**${[...n.childNodes].map((c) => inlineOf(c)).join('').trim()}**`);
        if (n.tagName === 'DD') out.push([...n.childNodes].map((c) => inlineOf(c)).join('').trim());
      }
      return out.filter(Boolean).join('\n\n');
    }
    if (tag === 'DETAILS') {
      const sum = el.querySelector(':scope > summary');
      const head = sum ? [...sum.childNodes].map((n) => inlineOf(n)).join('').replace(/\s+/g, ' ').trim() : '';
      const rest = blocksOf(el).filter((c) => !(sum && c === head)).join('\n\n');
      return [head ? `**${head}**` : '', rest].filter(Boolean).join('\n\n');
    }
    // FIGURE / DIV / SECTION 等容器：递归切块后原样拼接
    return blocksOf(el).join('\n\n');
  };

  // 把 parent 的子节点切成块序列：连续的内联内容累积成一个段落
  function blocksOf(parent) {
    const chunks = [];
    let buf = '';
    const flush = () => {
      const t = buf.replace(/ {2,}/g, ' ').replace(/\n{2,}/g, '\n').trim();
      if (t) chunks.push(t);
      buf = '';
    };
    for (const n of parent.childNodes) {
      if (n.nodeType === 3) { buf += escText(n.textContent, !buf.trim(), false); continue; }
      if (n.nodeType !== 1) continue;
      if (BLOCK.has(n.tagName) || n.tagName === 'TABLE') {
        flush();
        const rendered = renderBlock(n);
        if (rendered) chunks.push(rendered);
      } else {
        buf += inlineOf(n);
      }
    }
    flush();
    return chunks;
  }

  const body = document.body;
  if (!body) return { title: document.title || '', url: location.href, md: '' };
  const title = String(document.title || '').trim();
  const chunks = blocksOf(body);
  const md = [`# ${title || '（无标题）'}`, `> 来源：${location.href}`, ...chunks].filter(Boolean).join('\n\n');
  return { title, url: location.href, md };
}
