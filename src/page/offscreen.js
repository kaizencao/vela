// 离屏下载中转：收 SW 的 {type:'om:offscreen-download', content, filename}，造 Blob →
// <a download> 锚点点击触发下载。离屏文档是精简 API 面（没有 chrome.downloads），
// blob 落盘只能走锚点下载流；本文档留活由 SW 按在途计数延时关闭，关闭时 blob URL 随之失效，无需 revoke。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'om:offscreen-download') return; // 不处理也不拦别人的消息
  let url = '';
  try {
    const blob = new Blob([String(msg.content ?? '')], { type: 'text/markdown;charset=utf-8' });
    url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(msg.filename || 'page.md');
    document.body.appendChild(a);
    a.click();
    a.remove();
    sendResponse({ ok: true, url }); // 落定由 SW 侧查 downloads 记录确认（blob URL 精确匹配）
  } catch (e) {
    if (url) URL.revokeObjectURL(url);
    sendResponse({ ok: false, error: e?.message || String(e) });
  }
});
