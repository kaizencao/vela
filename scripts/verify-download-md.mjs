// e2e：下载网页为 Markdown——本地 fixture 页（标题 / 相对链接 / 嵌套列表 / 表格 / 代码块 /
// 引用 / 行首记号段 / 隐藏块 / 脚本 / data: 图），点浮窗「下载 MD」钮走完整链路：
//   widget → SW om:widget-action → executeScript(injected.js pageToMarkdown) → offscreen Blob 下载落盘。
// 断言落盘 .md 的转换正确性（含相对链接转绝对、单元格 | 转义、行首记号转义）与剔除项
// （display:none 子树、script、data: 图不进正文）。右键菜单入口 CDP 模拟不了真实右键，不在此覆盖；
// 不可注入页面（PDF / chrome://）的静默失败走 downloadMarkdown 的早退分支，与 PDF 链接菜单同约定。
// CDP 挂的下载行为可能把落盘文件名换成 GUID（verify-llm-chat 同款坑）：按目录唯一文件读内容。
// 用法：node scripts/verify-download-md.mjs
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, waitFor, createChecker } from './lib/cdp.mjs';

const { check, summary } = createChecker();

// ---- fixture 页：标记尽量互不干扰（搜索子串断言用） ----
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>MD 落盘夹具</title></head><body>
<h1>主标题一</h1>
<h2>二级标题</h2>
<p>段落带 <a href="/sub/page.html">相对链接</a> 与 <strong>加粗</strong>、<code>inline_code</code> 文本。</p>
<p>- 这不是列表</p>
<p>3. 这不是有序列表</p>
<ul><li>苹果<ul><li>红富士</li></ul></li><li>香蕉</li></ul>
<ol><li>第一</li><li>第二</li></ol>
<blockquote><p>引用一句话</p></blockquote>
<pre><code>const x = 1;
const y = 2;</code></pre>
<table><tr><th>名称</th><th>数值</th></tr><tr><td>a|b</td><td>42</td></tr></table>
<div style="display:none"><p>隐藏内容不该出现</p></div>
<script>var hiddenMarker = 1;</script>
<img alt="示例图" src="/img.png">
<img alt="内联图" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
</body></html>`;
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const web = createServer((q, r) => {
  if (q.url.startsWith('/page.html')) { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(FIXTURE); return; }
  if (q.url.startsWith('/img.png')) { r.writeHead(200, { 'content-type': 'image/png' }); r.end(PNG_1PX); return; }
  r.writeHead(404); r.end('not found');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${web.address().port}`;

const b = await launch({ port: 9393 });
try {
  const downloadDir = mkdtempSync(join(tmpdir(), 'vela-dl-md-'));
  const page = await b.openTab(`${BASE}/page.html`, { wait: 2000 });
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: false });
  await page.send('Page.bringToFront');
  const E = (expr) => page.evaluate(expr);

  // 浮窗「下载 MD」钮点击（shadow root open，见 widget.js build）。
  // 浮窗默认收起为悬浮球：先断言收起态，真实悬停球展开动作列，再点按钮
  const btnExpr = `document.getElementById('om-widget-host')?.shadowRoot?.querySelector('[data-act="download-md"]')`;
  const W = `document.getElementById('om-widget-host')?.shadowRoot`;
  await waitFor(() => E(`!!${W}?.querySelector('.om-ball')`), { timeout: 15000 });
  const stackOpen = () => E(`!!${W}.querySelector('.stack.open')`);
  check('浮窗默认收起为悬浮球（动作列隐藏）',
    !await stackOpen() && await E(`${W}.querySelector('.om-ball').getBoundingClientRect().width`) === 40);
  const ball = JSON.parse(await E(`(() => {
    const r = ${W}.querySelector('.om-ball').getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  await page.mouse('mouseMoved', ball.x, ball.y);
  await waitFor(stackOpen, { timeout: 5000 });
  check('悬停悬浮球展开动作列', await stackOpen());
  await E(`${btnExpr}.click()`);

  // 落盘：downloads 记录完成（SW 侧查记录）+ 下载目录唯一文件就绪
  const sw = await b.sw();
  const dlDone = await waitFor(async () => {
    const st = JSON.parse(await sw.evaluate(`chrome.downloads.search({}).then((l) => JSON.stringify(l.map((d) => [d.state, d.mime]))).catch(() => '[]')`));
    return st.some(([state, mime]) => state === 'complete' && /markdown/.test(mime || '')) ? st : null;
  }, { timeout: 20000 });
  check('downloads 记录完成且为 markdown 类型', !!dlDone, JSON.stringify(dlDone));

  const mdPath = await waitFor(() => {
    const names = readdirSync(downloadDir).filter((n) => !n.endsWith('.crdownload'));
    return names.length === 1 ? join(downloadDir, names[0]) : null;
  }, { timeout: 8000 });
  const md = mdPath ? readFileSync(mdPath, 'utf8') : '';
  check('落盘 .md 存在且以文档标题开头', !!mdPath && md.startsWith('# MD 落盘夹具'), mdPath || '目录为空');

  // ---- 转换正确性 ----
  check('来源行带页面地址', md.includes(`> 来源：${BASE}/page.html`), md.split('\n').slice(0, 3).join(' | '));
  check('标题层级（h1/h2）', md.includes('# 主标题一') && md.includes('## 二级标题'));
  check('相对链接转成绝对地址', md.includes(`[相对链接](${BASE}/sub/page.html)`));
  check('加粗与行内码', md.includes('**加粗**') && md.includes('`inline_code`'));
  check('行首记号段被转义（不被当列表 / 有序表）', md.includes('\\- 这不是列表') && md.includes('3\\. 这不是有序列表'));
  check('嵌套无序列表缩进', md.includes('- 苹果') && md.includes('  - 红富士') && md.includes('- 香蕉'));
  check('有序列表序号', md.includes('1. 第一') && md.includes('2. 第二'));
  check('引用块', md.includes('> 引用一句话'));
  check('围栏代码块原文保留', md.includes('```\nconst x = 1;\nconst y = 2;\n```'));
  const tableRow = md.split('\n').find((l) => l.includes('名称'));
  check('表格转 GFM 管道表且单元格 | 转义', md.includes('| 名称 | 数值 |') && md.includes('| --- | --- |') && md.includes('| a\\|b | 42 |'), tableRow);
  check('图片带 alt 与绝对地址', md.includes(`![示例图](${BASE}/img.png)`));

  // ---- 剔除项 ----
  check('display:none 子树不出现', !md.includes('隐藏内容不该出现'));
  check('script 内容不出现', !md.includes('hiddenMarker'));
  check('data: 图不进正文（留 alt 文字）', !md.includes('data:image') && md.includes('内联图'));

  sw.close();
  await page.close();
} finally {
  await b.close();
  web.close();
}
process.exit(summary());
