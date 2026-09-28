#!/usr/bin/env node
/* ============================================================
   parse.js — 把答辩手册 Markdown 目录解析成结构化 JSON
   ------------------------------------------------------------
   用法：
     node parse.js --src <md目录> --out <assets目录>

   产出（写入 assets/）：
     docs.json       文档正文 / 目录树 / 纯文本（供搜索）
     data.json       问题库 + 角色统计 + 追问索引
     emergency.json  应急话术
     formulas.json   公式总表
     aicontext.json  喂给 AI 的上下文（赛题摘要 / 事实卡 / 数字）

   ★ 与旧版差异：不再硬编码目录；文档顺序由 meta.json 决定，
     未在 meta.json 中登记的 .md 文件会被自动追加，保证不漏文件。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { texToHtml } = require('./latex.js');

/* ---------------- 参数解析 ---------------- */
function parseArgs(argv) {
  const a = { src: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') a.src = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
  }
  if (!a.src || !a.out) {
    console.error('用法: node parse.js --src <md目录> --out <assets目录>');
    process.exit(1);
  }
  if (!fs.existsSync(a.src)) {
    console.error('✗ 找不到 Markdown 目录: ' + a.src);
    process.exit(1);
  }
  fs.mkdirSync(a.out, { recursive: true });
  return a;
}
const ARGS = parseArgs(process.argv.slice(2));
const SRC = ARGS.src;
const OUT = ARGS.out;

/* ---------------- 基础工具 ---------------- */
const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 去掉 Markdown 标记，用于纯文本搜索索引 */
function stripMd(s) {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/[#>*`_~-]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------- 行内 Markdown → HTML ---------------- */
/* ---------------- 行内 Markdown → HTML ----------------
   ★ 公式渲染的核心约定（踩过的坑，勿改）：

   1. $$...$$ 是**块级**公式，可能跨多行（cases / aligned 环境尤其常见），
      所以它必须在 mdToHtml 层被提前抽走，不能留到 inline() 里处理。
      行内函数拿到的每一行都是单行，永远匹配不到跨行的 $$...$$。

   2. 表格单元格（TD）里的 $...$ 之所以会残留，是因为表格行被 split('|')
      之后没有走 inline()。现在表格也统一走 inline()，问题消失。

   3. \$ 要转成字面美元号，避免把「价格 $5」误判成公式。
---------------------------------------------------- */
/* 表格行切分：$...$ / $$...$$ 内部的竖线是「绝对值符号」，不是列分隔符。
   必须先占位再切，否则 $\gamma\sum(|\Delta f_i|)$ 会被劈成好几列。 */
function splitRow(line) {
  const keep = [];
  const guarded = String(line).replace(/\$([^$\n]*)\$/g, (m, p) => {
    keep.push(m);
    return '\u0003P' + (keep.length - 1) + '\u0003';
  });
  return guarded.trim().replace(/^\||\|$/g, '').split('|').map(s => {
    const t = s.trim().replace(/\u0003P(\d+)\u0003/g, (m, k) => keep[+k]);
    return t;
  });
}

function inline(s) {
  let t = esc(s);

  // 行内代码（先抽出保护，避免内部被其他规则改写）
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (m, p) => {
    codes.push(p);
    return '\u0001C' + (codes.length - 1) + '\u0001';
  });

  // 粗体 / 斜体
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // 公式（此处只剩行内 $...$；块级已在 mdToHtml 抽走）
  t = t.replace(/\\\$/g, '\u0001D\u0001');
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (m, p) => '<span class="math blk">' + texToHtml(p) + '</span>');
  t = t.replace(/\$([^$\n]+?)\$/g, (m, p) => '<span class="math">' + texToHtml(p) + '</span>');
  t = t.replace(/\u0001D\u0001/g, '$');

  // 站内 .md 交叉引用 → 可点击跳转
  t = t.replace(/\[([^\]]+)\]\(([^)]+\.md)(#[^)]*)?\)/g,
    (m, txt, f) => '<a class="xref" data-ref="' + f + '" href="javascript:void(0)">' + txt + '</a>');
  // 外链
  t = t.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // 情感符号美化
  t = t.replace(/❌/g, '<span class="x">✕</span>').replace(/✅/g, '<span class="v">✓</span>');

  // 还原行内代码
  t = t.replace(/\u0001C(\d+)\u0001/g, (m, i) => '<code>' + esc(codes[+i]) + '</code>');

  return t;
}


/* ---------------- 块级 Markdown → HTML ---------------- */
function mdToHtml(md) {
  // ★ 第一步：把跨行的 $$...$$ 块级公式整体抽出并占位。
  //   如果不抽，mdToHtml 按行切分后会把它拆成多行，公式必然渲染失败
  //   （cases / aligned 环境尤其明显）。
  const blocks = [];
  const text = String(md).replace(/\r\n?/g, '\n')
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, p) => {
      blocks.push('<div class="mathblk">' + texToHtml(p) + '</div>');
      return '\u0002B' + (blocks.length - 1) + '\u0002';
    });

  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let hid = 0;
  const toc = [];

  const headingId = (text) => {
    const slug = text.replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return 'h' + (hid++) + (slug ? '-' + slug : '');
  };

  // 占位符还原（可能出现在段落或表格单元格里）
  const restore = (html) => html.replace(/\u0002B(\d+)\u0002/g, (m, k) => blocks[+k]);

  while (i < lines.length) {
    const ln = lines[i];

    // 块级公式占位符独占一行 → 直接输出
    if (/^\u0002B\d+\u0002$/.test(ln.trim())) {
      out.push(restore(ln.trim()));
      i++;
      continue;
    }

    // 代码块
    if (/^\s*```/.test(ln)) {
      const lang = ln.replace(/^\s*```/, '').trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre class="code' + (lang ? ' lang-' + esc(lang) : '') + '"><code>' +
        esc(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // 标题
    const hm = ln.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      const lvl = hm[1].length;
      const txt = hm[2].trim();
      const id = headingId(txt);
      if (lvl <= 3) toc.push({ level: lvl, text: stripMd(txt), id });
      out.push('<h' + lvl + ' id="' + id + '">' + inline(txt) + '</h' + lvl + '>');
      i++;
      continue;
    }

    // 水平线
    if (/^\s*([-*_])\1{2,}\s*$/.test(ln)) { out.push('<hr/>'); i++; continue; }

    // 引用
    if (/^\s*>\s?/.test(ln)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      // 引用内还可能有列表/公式，递归一遍
      // ★ mdToHtml 返回的是 {html, toc} 对象，必须取 .html，
      //   否则字符串拼接会得到 "[object Object]"
      out.push('<blockquote>' + mdToHtml(buf.join('\n')).html + '</blockquote>');
      continue;
    }

    // 表格
    if (/^\s*\|/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = splitRow(ln);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      let h = '<div class="tw"><table><thead><tr>' +
        head.map(c => '<th>' + restore(inline(c)) + '</th>').join('') + '</tr></thead><tbody>';
      // ★ 单元格必须过 inline()，否则格子里的 $...$ 公式会原样显示
      h += rows.map(r => '<tr>' + r.map(c => '<td>' + restore(inline(c)) + '</td>').join('') + '</tr>').join('');
      h += '</tbody></table></div>';
      out.push(h);
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(ln)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      out.push('<ol>' + buf.map(x => '<li>' + restore(inline(x)) + '</li>').join('') + '</ol>');
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(ln)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push('<ul>' + buf.map(x => '<li>' + restore(inline(x)) + '</li>').join('') + '</ul>');
      continue;
    }

    // 空行
    if (!ln.trim()) { i++; continue; }

    // 普通段落
    const buf = [];
    while (i < lines.length && lines[i].trim() &&
      !/^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*\||\s*>|\s*```|\s*([-*_])\1{2,}\s*$)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) out.push('<p>' + restore(inline(buf.join(' '))) + '</p>');
    else i++;
  }

  return { html: out.join('\n'), toc };
}

/* ---------------- 读取 meta.json（可选） ---------------- */
function loadMeta() {
  const p = path.join(SRC, 'meta.json');
  if (!fs.existsSync(p)) return { docs: [], roles: [], events: {} };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('⚠️  meta.json 解析失败，忽略：' + e.message);
    return { docs: [], roles: [], events: {} };
  }
}
const META = loadMeta();

/* ---------------- 收集文档 ---------------- */
/* 排除仓库/示例自带的说明文件，它们不是答辩手册的一部分 */
const IGNORE_MD = /^(README|LICENSE|CHANGELOG|CONTRIBUTING|SKILL)\.md$/i;
let files = fs.readdirSync(SRC)
  .filter(f => f.toLowerCase().endsWith('.md'))
  .filter(f => !IGNORE_MD.test(f));

// 按 meta.docs 的顺序排；未登记的按文件名兜底追加（保证不漏）
const ordered = [];
if (Array.isArray(META.docs) && META.docs.length) {
  for (const d of META.docs) {
    const f = typeof d === 'string' ? d : d.file;
    if (f && files.includes(f) && !ordered.includes(f)) ordered.push(f);
  }
}
const rest = files.filter(f => !ordered.includes(f)).sort((a, b) => a.localeCompare(b, 'zh'));
for (const f of rest) ordered.push(f);

if (!ordered.length) {
  console.error('✗ ' + SRC + ' 下没有找到任何 .md 文件');
  process.exit(1);
}
if (rest.length) {
  console.warn('   注意：' + rest.length + ' 个文件未在 meta.json 登记，已按文件名自动追加');
}

// meta 里登记的编号/标题（字符串或对象两种写法都兼容）
const metaMap = {};
if (Array.isArray(META.docs)) {
  for (const d of META.docs) {
    if (typeof d === 'string') continue;
    if (d.file) metaMap[d.file] = d;
  }
}

const docs = ordered.map((file, idx) => {
  const raw = fs.readFileSync(path.join(SRC, file), 'utf8');
  const parsed = mdToHtml(raw);
  const m = metaMap[file] || {};

  // 编号：优先 meta 指定，否则从文件名前缀（00_ / 01_）取，再退化为序号
  let no = m.no;
  if (!no) {
    const nm = file.match(/^(\d{1,3})[_\-\s]/);
    no = nm ? nm[1] : String(idx).padStart(2, '0');
  }

  // 标题：优先 meta，否则取第一个 H1，再退化文件名
  let title = m.title;
  if (!title) {
    const h1 = raw.match(/^#\s+(.+)$/m);
    title = h1 ? h1[1].trim().replace(/[#*`]/g, '') : file.replace(/\.md$/, '');
  }

  return {
    file,
    no: String(no),
    title,
    html: parsed.html,
    toc: parsed.toc,
    chars: raw.length,
    text: stripMd(raw).slice(0, 24000),
    _raw: raw,
  };
});

/* ---------------- 问题对象归一化 ----------------
   解析出来的原始字段是 {no, q, a, role, priority, cat, point, tip}，
   但前端模板消费的是另一套命名（num / oral / roles / star / notes）。

   ★ roles 必须是模板认的**英文键**（model / code / paper / all），
     因为在 qMatches() 与 renderChips() 里是拿它跟 CATS[].role 做包含判断的。
     中文角色名（建模手…）在这里映射成英文键，否则芯片计数会全是 0。 */
const ROLE_KEY = {
  '建模手': 'model', '模型': 'model',
  '编程手': 'code', '代码': 'code', '程序': 'code',
  '论文手': 'paper', '写作': 'paper', '论文': 'paper',
  '通用': 'all', '全员': 'all', 'all': 'all',
};
function mkQ(o) {
  const stars = Math.max(1, Math.min(3, o.priority || 1));
  const cn = o.role || '通用';
  const key = ROLE_KEY[cn] || 'all';
  return {
    // —— 原始字段（保留，便于二次加工）——
    id: o.id,
    no: o.no,
    q: o.q,
    cat: o.cat || '综合',
    role: cn,
    priority: stars,
    point: o.point || '',
    a: o.a || '',
    tip: o.tip || '',
    // —— 前端消费字段 ——
    num: 'Q' + o.no,
    oral: o.a || '',
    roles: [key],          // ★ 英文键，模板靠它筛选与计数
    roleCn: cn,            // 中文名，展示用
    star: stars >= 3,
    starN: stars,
    catName: '',
    notes: [o.point, o.tip].filter(Boolean),
  };
}

/* ---------------- 问题库抽取 ----------------
   真实格式（模板里固化了这种写法，生成时务必遵守）：

     # 6.1 通用 / 全局问题            ← 二级分类（决定 cat）
     **★Q1：你们这篇论文最核心的创新是什么？**   ← 问题（★ 数量 = 优先级）
     > "答案正文……"                  ← 引用块即答案
     > **追问**：……                   ← 可选，以「追问」开头的行

   容错：也支持「### Q1 · 分类 ｜ 优先级 ★★★ ｜ 角色 建模手」搭配
   「**问** / **答**」的结构化写法。两种混用时都能吃到。
------------------------------------------------ */
function extractQuestions() {
  const qDoc = docs.find(d => /评委问题库|问题库|问答库/.test(d.title) || /问题库/.test(d.file));
  if (!qDoc) return { questions: [], rolesMeta: [] };

  const raw = qDoc._raw;
  const questions = [];
  const roleSet = new Map();

  let cat = '综合';
  let seq = 0;
  const lines = raw.split('\n');

  // 角色关键词 → 用于自动分配答题人
  const ROLE_HINT = [
    [/代码|程序|算法实现|数据结构|复杂度|调试|脚本|函数/, '编程手'],
    [/模型|公式|假设|推导|目标函数|约束|创新|为什么这么|误差|灵敏度|检验/, '建模手'],
    [/论文|写作|图|表|排版|格式|摘要|引用|附录|结构/, '论文手'],
  ];
  const guessRole = (q, explicit) => {
    if (explicit) return explicit;
    for (const [re, r] of ROLE_HINT) if (re.test(q)) return r;
    return '通用';
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // ① 分类标题：# 6.1 xxx  /  ## 6.1 xxx  /  ## 三、xxx
    const catM = ln.match(/^#{1,3}\s+(.+)$/);
    if (catM && !/\*\*Q|Q\d+[：:]/.test(catM[1])) {
      const t = catM[1].trim().replace(/^#+\s*/, '');
      if (/问题库|使用方式|答题总原则|^目录/.test(t)) continue;
      cat = t.replace(/^\d+(\.\d+)*\s*/, '').replace(/^[一二三四五六七八九十]+[、.]\s*/, '') || cat;
      continue;
    }

    // ② 结构化写法：### Q1 · 分类 ｜ 优先级 ★★★ ｜ 角色 建模手
    if (/^#{2,4}\s/.test(ln) && /Q\d+|问题\d+/.test(ln)) {
      const block = [];
      let j = i + 1;
      while (j < lines.length && !/^#{2,4}\s/.test(lines[j])) block.push(lines[j++]);
      const body = block.join('\n');
      const get = (label) => {
        const mm = body.match(new RegExp('\\*\\*' + label + '\\*\\*[:：]?\\s*([\\s\\S]*?)(?=\\n\\*\\*[^\\n]{1,12}\\*\\*[:：]|$)'));
        return mm ? mm[1].trim() : '';
      };
      const q = get('问') || ln.replace(/^#{2,4}\s*/, '').replace(/^Q\d+[·.\s]*/, '').trim();
      if (q) {
        const prioM = ln.match(/★+/);
        const roleM = ln.match(/角色\s*[:：]?\s*([^\s|｜]+)/);
        const role = guessRole(q, roleM ? roleM[1] : '');
        seq++;
        if (!roleSet.has(role)) roleSet.set(role, 0);
        roleSet.set(role, roleSet.get(role) + 1);
        questions.push(mkQ({
          id: 'q' + seq, no: seq, q: q.replace(/\*\*/g, ''),
          cat: ln.split(/[|｜]/)[1]?.trim() || cat,
          role, priority: prioM ? prioM[0].length : 2,
          point: get('考点') || get('考察') || '',
          a: get('答') || get('参考回答') || '',
          tip: get('追问') || get('加分点') || '',
        }));
      }
      i = j - 1;
      continue;
    }

    // ③ 主写法：**★Q1：问题？**
    const qm = ln.match(/^\s*\*\*\s*(★*)\s*(?:Q|问题)\s*(\d+)\s*[：:.]?\s*([\s\S]*?)\s*\*\*\s*$/);
    if (qm) {
      const stars = qm[1].length || 1;
      let q = (qm[3] || '').replace(/\*\*/g, '').trim();
      // 收集后续引用块作为答案
      const ansLines = [];
      let k = i + 1;
      while (k < lines.length) {
        const L = lines[k];
        if (/^\s*>/.test(L)) { ansLines.push(L.replace(/^\s*>\s?/, '')); k++; continue; }
        if (!L.trim()) {
          // 允许引用块之间有单个空行
          if (k + 1 < lines.length && /^\s*>/.test(lines[k + 1])) { k++; continue; }
          break;
        }
        break;
      }
      let a = ansLines.join('\n').trim();
      let tip = '';
      const tipM = a.match(/\*\*追问\*\*[：:]\s*([\s\S]*)$/);
      if (tipM) { tip = tipM[1].trim(); a = a.slice(0, tipM.index).trim(); }
      // 答案去掉最外层成对引号，保留内部加粗
      a = a.replace(/^["“]([\s\S]*)["”]$/, '$1').trim();

      if (q) {
        const role = guessRole(q, '');
        seq++;
        if (!roleSet.has(role)) roleSet.set(role, 0);
        roleSet.set(role, roleSet.get(role) + 1);
        questions.push(mkQ({
          id: 'q' + seq, no: seq, q,
          cat, role, priority: stars,
          point: '', a, tip,
        }));
      }
      i = k - 1;
      continue;
    }
  }

  const rolesMeta = [...roleSet.entries()].map(([name, count]) => ({ name, count }));
  return { questions, rolesMeta };
}

const { questions, rolesMeta } = extractQuestions();
if (!questions.length && docs.length) {
  console.warn('⚠️  未从问题库中解析出问题。请检查 06_评委问题库.md 是否使用 ### 标题 + **问**/**答** 格式。');
}

/* ---------------- 应急话术抽取 ----------------
   真实格式（Markdown 表格）：

     ## 9.1 被问不会的问题
     | 情形 | 话术 |
     |---|---|
     | **是代码问题** | "这个问题涉及代码实现细节……" |

   容错：也支持 `**场景**：…` + `**话术**：…` 的段落写法。
------------------------------------------------ */
function extractEmergency() {
  const doc = docs.find(d => /应急话术|救场/.test(d.title) || /应急话术/.test(d.file));
  if (!doc) return [];
  const raw = doc._raw;
  const groups = [];
  const lines = raw.split('\n');

  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    const h = ln.match(/^#{2,3}\s+(.+)$/);
    if (h) {
      const t = h[1].trim();
      if (/用法|使用方式/.test(t)) { cur = null; continue; }
      cur = { title: t.replace(/^\d+(\.\d+)*\s*/, '').replace(/^[一二三四五六七八九十]+[、.]\s*/, ''), items: [] };
      groups.push(cur);
      continue;
    }

    // 表格行：| 情形 | 话术 |
    if (cur && /^\s*\|/.test(ln)) {
      const cells = ln.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
      if (cells.length < 2) continue;
      if (/^[-:\s]+$/.test(cells[0]) || /^[-:\s]+$/.test(cells[1])) continue;  // 分隔行
      if (/^情形$|^场景$|^情况$/.test(cells[0])) continue;                      // 表头
      const scene = cells[0].replace(/^\*\*|\*\*$/g, '').trim();
      const say = cells[1].replace(/^["“]([\s\S]*)["”]$/, '$1').trim();
      if (scene && say) {
        // 输出两种形态：{scene,say} 便于阅读，{type:'row'} 供模板直接渲染
        cur.items.push({ scene, say, type: 'row', cells: [scene, say] });
      }
      continue;
    }

    // 段落写法兜底
    const pm = ln.match(/^\*\*(?:场景|情况|当)\*\*[：:]\s*(.+)$/);
    if (cur && pm) {
      const nx = lines[i + 1] || '';
      const sm = nx.match(/^\*\*(?:话术|这样说|应对)\*\*[：:]\s*(.+)$/);
      if (sm) { cur.items.push({ scene: pm[1].trim(), say: sm[1].trim() }); i++; }
    }
  }

  return groups.filter(g => g.items.length);
}
const emergency = extractEmergency();
if (!emergency.length) console.warn('⚠️  未解析出应急话术（可选，不影响主体功能）。');

/* ---------------- 公式总表：从 03_公式圣经.md 抽取 ---------------- */
function extractFormulas() {
  const doc = docs.find(d => /公式/.test(d.title) || /公式/.test(d.file));
  if (!doc) return { formulas: [], ultimate: [] };
  const raw = doc._raw;
  const formulas = [];
  // 只取 display math $$...$$
  const re = /\$\$([\s\S]+?)\$\$/g;
  let mm;
  let n = 0;
  while ((mm = re.exec(raw))) {
    const body = mm[1].trim();
    if (!body) continue;
    n++;
    // 往上找最近的标题作为名称
    const before = raw.slice(0, mm.index);
    const hs = [...before.matchAll(/^#{2,4}\s+(.+)$/gm)];
    const name = hs.length ? hs[hs.length - 1][1].trim() : ('公式 ' + n);
    formulas.push({ no: n, name, tex: body, html: texToHtml(body) });
  }
  // 结论速记（## 级别最后一段的表格里的短式）
  const ultimate = formulas.slice(0, 12).map(f => ({ name: f.name, tex: f.tex, html: f.html }));
  return { formulas, ultimate };
}
const formulaData = extractFormulas();

/* ---------------- AI 上下文：拼装喂给模型的赛题材料 ---------------- */
/* 约定：仓库里可放 _context/*.md，或 handbook 目录下的 00_赛题与解读.md 等。
   这里做通用拼装：摘要类文档 + 核心数字卡 + 问题库的问答要点。 */
function buildAIContext() {
  const pick = (re) => docs.filter(d => re.test(d.title) || re.test(d.file));
  const joinDoc = (arr) => arr.map(d => '【' + d.title + '】\n' + d.text).join('\n\n');

  const problem = joinDoc(pick(/赛题|题目|问题重述|审题/));
  const abstract = joinDoc(pick(/摘要|总览|总目录|概览/));
  const factsCard = joinDoc(pick(/速记|数字卡|核心数字|事实/));
  const outline = joinDoc(pick(/讲稿|自述|结构/));
  const defects = joinDoc(pick(/不匹配|口径|瑕疵|不一致/));
  const numbers = (docs.map(d => d.text).join(' ').match(/\b\d[\d,.]*\b/g) || [])
    .slice(0, 400).join(' ');

  return {
    problem: problem.slice(0, 20000),
    abstract: abstract.slice(0, 20000),
    factsCard: factsCard.slice(0, 20000),
    outline: outline.slice(0, 20000),
    defects: defects.slice(0, 20000),
    numbers: numbers.slice(0, 8000),
    // 问答要点：把问题库里每个问题的「考点」拼起来，作为 AI 的答题依据
    qaHints: questions.map(q => q.q + ' → ' + q.point).filter(s => s.length > 3).join('\n').slice(0, 20000),
    // ★ 身份与口径：从 meta.json / 总目录里抽，替代模板里写死的赛题
    identity: buildIdentity(),
    rolesText: buildRolesText(),
    counts: {
      docs: docs.length, questions: questions.length,
      emergency: emergency.length, formulas: formulaData.formulas.length,
    },
  };
}

/* 从 meta.json + 总目录正文里抽「这是什么比赛 / 什么题 / 什么队」，
   让 system prompt 能自报家门，而不是套用别人的赛题。 */
function buildIdentity() {
  const m = META || {};
  const head = (docs.find(d => /总目录|总览|概览/.test(d.title)) || {}).text || '';
  const grab = (re) => { const x = head.match(re); return x ? x[1].trim().slice(0, 120) : ''; };
  return {
    title: m.title || grab(/题目\s*[:：]?\s*([^\n（(]{4,80})/) || '（未提供赛题名称）',
    team: m.team || '',
    competition: grab(/(国赛|美赛|研赛|电工杯|五一赛|深圳杯|统计建模)[^\n，,。]{0,40}/) || '',
    form: grab(/(线上会议|线下答辩|腾讯会议|ZOOM|线上答辩|现场答辩)[^\n，,。]{0,50}/) || '',
  };
}

/* 三人分工口径：从「分工」那篇文档的法定义里抽角色职责。
   注意：docs[].text 是去标签后的纯文本，表格竖线已经没了，
   所以这里改用 docs[].html（表格结构完整）来抽，可靠性高得多。
   两种来源都失败时给通用三段，保证 system prompt 永远有内容。 */
function buildRolesText() {
  const d = docs.find(x => /分工|角色|三人/.test(x.title));
  const html = (d && d.html) || '';
  const ROLES = '(建模手|编程手|论文手|数据手|队长)';
  const got = [];
  const add = (name, duty) => {
    const clean = String(duty).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ')
      .replace(/[*|]/g, '').replace(/\s+/g, ' ').trim();
    if (!got.some(g => g.name === name) && clean.length >= 4) {
      got.push({ name, duty: clean.slice(0, 90) });
    }
  };

  // ① 表格行：<tr><td>建模手（A）</td><td>模型设计、公式推导…</td>…
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let tr;
  while ((tr = trRe.exec(html))) {
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    if (tds.length >= 2) {
      const m = tds[0].replace(/<[^>]+>/g, '').trim()
        .match(new RegExp('^' + ROLES + '\\s*(（[^）]{1,6}）)?'));
      if (m) add(m[1], tds[1]);
    }
  }
  // ② 兜底：纯文本里的「角色：职责」写法
  if (!got.length) {
    const t = (d && d.text) || '';
    for (const line of t.split(/[\n；;]/)) {
      const s = line.replace(/^[\s>*#\-\d.、]+/, '').trim();
      const m = s.match(new RegExp('^' + ROLES + '\\s*(（[^）]{1,6}）)?\\s*[:：]\\s*(.{4,90})$'));
      if (m) add(m[1], m[3]);
    }
  }
  // ③ 按姓名抽取（适用于「按问题分」而非按角色分的队伍）
  //    表格形如：| **张三**（主讲） | **问题一、问题二** —— 因子识别、相关系数 | ...
  //    或：      | **问题一**（因子识别） | **张三** | 王五 |
  if (!got.length) {
    const byName = new Map();
    // 只取文档中「分工表」那一段（前 60%），避免抓到后面"现场纪律"里的条目
    const cut = html.indexOf('现场纪律');
    const scope = cut > 0 ? html.slice(0, cut) : html;
    const push = (who, what) => {
      const name = String(who).replace(/<[^>]+>/g, '').replace(/[*|]/g, '').trim();
      const duty = String(what).replace(/<[^>]+>/g, '').replace(/[*|]/g, ' ')
        .replace(/\s+/g, ' ').replace(/[—–-]{2,}/g, '·').trim();
      // 只认 2–4 个汉字的人名，排除"某某队员"这类泛称和说明文字
      if (!/^[\u4e00-\u9fff]{2,4}$/.test(name)) return;
      if (/队员|同学|老师|主讲|负责|抢答|静音/.test(name)) return;
      // 职责必须描述"负责什么"，而不是行为规范
      if (/抢答|静音|打断|越界|不要|禁止/.test(duty)) return;
      if (duty.length < 4 || duty.length > 90) return;
      if (!byName.has(name)) byName.set(name, duty);
    };
    const trRe2 = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let tr2;
    while ((tr2 = trRe2.exec(scope))) {
      const tds = [...tr2[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
      if (tds.length < 2) continue;
      const c0 = tds[0].replace(/<[^>]+>/g, '').replace(/[*|]/g, '').trim();
      const c1 = tds[1].replace(/<[^>]+>/g, '').replace(/[*|]/g, '').trim();
      // 哪一格是人名，就按哪一格建
      if (/^[\u4e00-\u9fff]{2,4}$/.test(c0)) push(c0, c1);
      else if (/^[\u4e00-\u9fff]{2,4}$/.test(c1)) push(c1, c0);
    }
    for (const [n, d] of byName) got.push({ name: n, duty: d });
  }

  return got.length
    ? got.map(g => '- **' + g.name + '**：' + g.duty).join('\n')
    : '- **建模手（队长）**：讲模型、公式、结果、创新点。\n' +
      '- **编程手**：讲代码主流程、算法实现、运行时间。\n' +
      '- **论文手**：讲数据来源、图表一致性、写作规范。';
}
const aicontext = buildAIContext();

/* ---------------- 写出 ---------------- */
const docsSlim = docs.map(d => ({
  file: d.file, no: d.no, title: d.title,
  html: d.html, toc: d.toc, chars: d.chars, text: d.text,
}));

fs.writeFileSync(path.join(OUT, 'docs.json'), JSON.stringify(docsSlim, null, 0));
fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify({
  questions, rolesMeta: rolesMeta.length ? rolesMeta : [{ name: '通用', count: questions.length }],
  formulaQA: [], numberQA: [],
}, null, 0));
fs.writeFileSync(path.join(OUT, 'emergency.json'), JSON.stringify(emergency, null, 0));
fs.writeFileSync(path.join(OUT, 'formulas.json'), JSON.stringify(formulaData, null, 0));
fs.writeFileSync(path.join(OUT, 'aicontext.json'), JSON.stringify(aicontext, null, 0));

console.log('✅ 解析完成 → ' + OUT);
console.log('   文档 ' + docsSlim.length + ' 篇 | 问题 ' + questions.length + ' 条 | 话术组 ' +
  emergency.length + ' | 公式 ' + formulaData.formulas.length + ' 条');
console.log('   角色分布: ' + (rolesMeta.map(r => r.name + '×' + r.count).join(', ') || '（无）'));
console.log('   AI 上下文: 赛题 ' + aicontext.problem.length + ' / 摘要 ' + aicontext.abstract.length +
  ' / 事实卡 ' + aicontext.factsCard.length + ' / 问答要点 ' + aicontext.qaHints.length);
