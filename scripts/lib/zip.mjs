// 共用零依赖 zip writer（store 模式），package.mjs / package-bridge.mjs 复用。
// 与成熟压缩器同构：显式目录条目（带 DOS 目录属性位）+ 文件归档位——
// 缺这两样的极简 zip 部分第三方解压工具（360 压缩等）会报「包损坏」。
import { readFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// 写一个条目的本地头 + 中心目录头（offset 为本地头在包内的位置）
function writeEntry(kind, name, data, crc, time, date, offset, locals, centrals) {
  const nameBuf = Buffer.from(name, 'utf8');
  // DOS 属性位：目录 0x10，文件 0x20（archive），放 external attrs 低 16 位
  const attrs = kind === 'dir' ? 0x10 : 0x20;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x800, 6); // UTF-8 名称标志
  local.writeUInt16LE(0, 8); // method: store
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  locals.push(local, nameBuf, data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by（MS-DOS）
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(attrs, 38); // external attrs（DOS 位）
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);
  return 30 + nameBuf.length + data.length;
}

// base：zip 内相对路径的基准目录（zip 根 = base 本身）
export function buildZip(files, base) {
  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;
  // 显式目录条目：文件路径的各级祖先目录去重，排在文件前（父先于子）
  const dirSet = new Set();
  for (const abs of files) {
    const rel = relative(base, dirname(abs)).split(sep).join('/');
    if (!rel || rel === '.') continue;
    const segs = rel.split('/');
    for (let i = 1; i <= segs.length; i++) dirSet.add(segs.slice(0, i).join('/'));
  }
  const dirs = [...dirSet].sort();
  for (const d of dirs) {
    offset += writeEntry('dir', `${d}/`, Buffer.alloc(0), 0, time, date, offset, locals, centrals);
  }
  for (const abs of files) {
    const name = relative(base, abs).split(sep).join('/');
    const data = readFileSync(abs);
    offset += writeEntry('file', name, data, crc32(data), time, date, offset, locals, centrals);
  }
  const count = dirs.length + files.length;
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

// 产物自检：逐条目核 CRC / 尺寸、中心目录回指、EOCD 落位。
// 返回问题清单（空数组 = 通过），调用方据此抛错拦下坏包。
export function verifyZip(buf) {
  const problems = [];
  let off = 0;
  let n = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const crc = buf.readUInt32LE(off + 14);
    const csize = buf.readUInt32LE(off + 18);
    const sz = buf.readUInt32LE(off + 22);
    const nl = buf.readUInt16LE(off + 26);
    const el = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nl).toString('utf8');
    const data = buf.slice(off + 30 + nl + el, off + 30 + nl + el + csize);
    if (data.length !== sz) problems.push(`${name}: 解压尺寸不符`);
    if (crc32(data) !== crc) problems.push(`${name}: CRC 不符`);
    n++;
    off += 30 + nl + el + csize;
  }
  // 本地条目扫描终点 = 中心目录起点；中心目录扫描终点 = EOCD 落点
  const cdStart = off;
  if (buf.readUInt32LE(cdStart) !== 0x02014b50) problems.push('本地条目扫描终点不是中心目录');
  let cd = cdStart;
  let m = 0;
  while (cd + 4 <= buf.length && buf.readUInt32LE(cd) === 0x02014b50) {
    const crc = buf.readUInt32LE(cd + 16);
    const sz = buf.readUInt32LE(cd + 24);
    const nl = buf.readUInt16LE(cd + 28);
    const el = buf.readUInt16LE(cd + 30);
    const cl = buf.readUInt16LE(cd + 32);
    const lho = buf.readUInt32LE(cd + 42);
    const name = buf.slice(cd + 46, cd + 46 + nl).toString('utf8');
    if (buf.readUInt32LE(lho) !== 0x04034b50 || buf.readUInt32LE(lho + 14) !== crc || buf.readUInt32LE(lho + 22) !== sz) {
      problems.push(`${name}: 中心目录回指的本地头不一致`);
    }
    m++;
    cd += 46 + nl + el + cl;
  }
  if (buf.readUInt32LE(cd) !== 0x06054b50) problems.push('EOCD 没落在中心目录扫描终点');
  if (buf.readUInt16LE(cd + 10) !== n) problems.push(`EOCD 条目数 ${buf.readUInt16LE(cd + 10)} ≠ 本地条目数 ${n}`);
  if (m !== n) problems.push(`中心目录条目数 ${m} ≠ 本地条目数 ${n}`);
  if (buf.readUInt32LE(cd + 16) !== cdStart) problems.push('EOCD 的中心目录起点与实际位置不符');
  if (buf.readUInt32LE(cd + 12) !== cd - cdStart) problems.push('中心目录尺寸对不上');
  if (cd + 22 !== buf.length) problems.push('EOCD 后有多余字节');
  return problems;
}
