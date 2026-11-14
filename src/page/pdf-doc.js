// PDF 标签页管线（一期）：把「当前 PDF 标签页 / PDF 链接」变成聊天会话里的知识库快照。
// isPdfUrl / pdfNameFromUrl 是纯函数，SW 做入口判断用；fetchPdfDocument 在扩展页
// （聊天页 / 面板）执行——下载可能远超 30 秒，按 MV3 约束不进 service worker。

export const PDF_FETCH_TIMEOUT_MS = 20000;
export const PDF_FETCH_MAX_BYTES = 30 * 1024 * 1024; // 下载上限（快照库单文件 50MB 内；模型读取另按 15MB 阈值分流）
// 问答模式每轮附件预算：覆盖知识库 PDF 单文件 15MB 上限，base64 后 ~21MB，
// 距 Anthropic 32MB 请求体上限留足余量（OpenAI 侧同套取严）
export const PDF_QA_MAX_FILES = 2;
export const PDF_QA_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const errNamed = (name, message) => Object.assign(new Error(message), { name });

// 入口判断（SW / 右键菜单）：http(s) / file 且路径以 .pdf 结尾（大小写不敏感）。
// 无 .pdf 后缀的动态下载链接触不到 content-type（webRequest 不用），识别不了——接受的取舍
export function isPdfUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return false;
    return /\.pdf$/i.test(u.pathname);
  } catch {
    return false;
  }
}

// 从 URL 取 PDF 文件名（最后一段，容错 decode）；不是 .pdf 或取不到返回 ''（调用方回退 tab.title）
export function pdfNameFromUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    if (!/\.pdf$/i.test(seg)) return '';
    const name = decodeURIComponent(seg);
    return /^[^\\/:*?"<>|]+$/.test(name) ? name : '';
  } catch {
    return '';
  }
}

// 下载 PDF 字节（超时 20s、有界读、魔数校验）。返回 { bytes, size, contentType, url }。
// 失败以 Error.name 区分，聊天页按名字出对应引导文案：
//   http-status / timeout / too-large / not-pdf / file-access（file:// 未开「允许访问文件网址」）/ network
export async function fetchPdfDocument(url, signal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(errNamed('timeout', `下载超时（${PDF_FETCH_TIMEOUT_MS / 1000} 秒）`)), PDF_FETCH_TIMEOUT_MS);
  const onAbort = () => ac.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res;
    try {
      res = await fetch(url, { signal: ac.signal, credentials: 'omit', redirect: 'follow' });
    } catch (e) {
      if (signal?.aborted) throw e; // 调用方主动取消：原样上抛
      if (ac.signal.reason?.name === 'timeout') throw ac.signal.reason;
      if (String(url).startsWith('file:')) {
        throw errNamed('file-access', '无法读取本机文件：请在 chrome://extensions 的 Vela 详情页打开「允许访问文件网址」开关后重试');
      }
      throw errNamed('network', e.message || '网络请求失败');
    }
    if (!res.ok) throw errNamed('http-status', `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    const contentType = res.headers.get('content-type') || '';
    const bytes = await readPdfBytes(res);
    // %PDF- 魔数为准：content-type 标错的错误页 / HTML 拦在 not-pdf；标对但内容不对的也拦住
    if (!(bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
      throw errNamed('not-pdf', '该地址返回的内容不是 PDF 文件（可能是错误页或 HTML）');
    }
    return { bytes, size: bytes.length, contentType, url: res.url || url };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// 有界流式读：超 30MB 立即掐断，防止大文件把扩展页内存撑爆
async function readPdfBytes(res) {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > PDF_FETCH_MAX_BYTES) {
      reader.cancel().catch(() => {});
      throw errNamed('too-large', `PDF 超过 ${Math.round(PDF_FETCH_MAX_BYTES / 1048576)} MB 下载上限`);
    }
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
