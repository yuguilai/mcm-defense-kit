#!/usr/bin/env node
/* ============================================================
   bundle.js — 把 assets/*.json 内嵌进模板，产出单文件 index.html
   ------------------------------------------------------------
   用法：
     node bundle.js --assets <assets目录> --template <template.html> --out <输出目录>

   关键设计（踩过的坑，勿改）：
   1. 用「函数形式」的 replace 做注入。JSON 与内联代码里含大量 $，
      字符串形式的 replace 会把 $& $' $` 当特殊模式，导致整份文档被复制。
   2. 内联 LaTeX 转换器前后加 typeof 守卫，同一份源码在 Node 与浏览器都能跑。
   3. 注入前用 vm.Script 做语法自检 —— 一旦内联代码有语法错误，
      整个页面会白屏且没有任何提示，必须提前拦住。
   4. favicon 内联为 data URI，避免 /favicon.ico 404 噪声。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------------- 参数 ---------------- */
function parseArgs(argv) {
  const a = { assets: '', template: '', out: '', title: '', slogan: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--assets') a.assets = argv[++i];
    else if (k === '--template') a.template = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--title') a.title = argv[++i];
    else if (k === '--slogan') a.slogan = argv[++i];
  }
  if (!a.assets || !a.template || !a.out) {
    console.error('用法: node bundle.js --assets <dir> --template <html> --out <dir> [--title "标题"] [--slogan "副标题"]');
    process.exit(1);
  }
  return a;
}
const A = parseArgs(process.argv.slice(2));
if (!fs.existsSync(A.template)) { console.error('✗ 找不到模板: ' + A.template); process.exit(1); }

const readJSON = (f) => {
  const p = path.join(A.assets, f);
  if (!fs.existsSync(p)) { console.error('✗ 缺少数据文件: ' + p); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};

const docs = readJSON('docs.json');
const emergency = readJSON('emergency.json');
const aicontext = readJSON('aicontext.json');
const data = readJSON('data.json');
const formulas = readJSON('formulas.json');

// 问题以 data.json 为准（parse.js 已把 roles 写进去）
const questions = data.questions || [];

// 文档瘦身：正文保留（渲染要用），text 截断到 24000 字（搜索够用，控制体积）
const docsSlim = docs.map(d => ({
  file: d.file, no: d.no, title: d.title, html: d.html, toc: d.toc, chars: d.chars,
  text: (d.text || '').slice(0, 24000),
}));

const BUNDLE = {
  docs: docsSlim,
  questions,
  emergency,
  aicontext,
  rolesMeta: data.rolesMeta || [],
  formulaQA: data.formulaQA || [],
  numberQA: data.numberQA || [],
  formulas: (formulas.formulas || []),
  ultimate: (formulas.ultimate || []),
  meta: {
    title: A.title || '数学建模答辩助手',
    builtAt: new Date().toISOString().slice(0, 10),
  },
};

let html = fs.readFileSync(A.template, 'utf8');

/* ---------------- 1. 注入数据 ---------------- */
// 安全嵌入：转义 </script> 与 <!-- ，防止把宿主文档提前闭合
const json = JSON.stringify(BUNDLE)
  .replace(/<\//g, '<\\/')
  .replace(/<!--/g, '<\\u0021--');

if (!html.includes('/*__DATA__*/')) {
  // 兼容两种占位符写法
  if (html.includes('/*__DATA__*/{}')) { /* 下面统一处理 */ }
  else { console.error('✗ 模板缺少 /*__DATA__*/ 占位符'); process.exit(1); }
}
html = html.replace('/*__DATA__*/{}', () => json);
html = html.replace('/*__DATA__*/', () => json);

/* ---------------- 2. 注入 LaTeX 转换器 ---------------- */
const latexPath = path.join(__dirname, 'latex.js');
if (!fs.existsSync(latexPath)) { console.error('✗ 找不到 latex.js'); process.exit(1); }
const latexRaw = fs.readFileSync(latexPath, 'utf8');
// 外层包 IIFE 隔离 const/function，防止与页面变量重名
const latexInject = '/* ==== LaTeX → Unicode 转换器（构建期内联，勿手改）==== */\n' +
  '(function(){\n' + latexRaw + '\n})();';

// 语法自检：注入的代码必须能被 JS 引擎解析，否则整页白屏
try {
  new vm.Script(latexInject, { filename: 'latex-inline.js' });
} catch (e) {
  console.error('✗ 内联的 LaTeX 代码有语法错误：' + e.message);
  process.exit(1);
}
if (html.includes('/*__LATEX__*/')) {
  html = html.replace('/*__LATEX__*/', () => latexInject);
} else {
  console.error('✗ 模板缺少 /*__LATEX__*/ 占位符');
  process.exit(1);
}

/* ---------------- 3. favicon ---------------- */
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="#0f172a"/>' +
  '<rect x="7" y="7" width="5" height="18" rx="2" fill="#2f6bff"/>' +
  '<rect x="14" y="12" width="5" height="13" rx="2" fill="#00d48a"/>' +
  '<rect x="21" y="9" width="5" height="16" rx="2" fill="#f5a524"/>' +
  '</svg>');
if (html.includes('<!--__FAVICON__-->')) {
  html = html.replace('<!--__FAVICON__-->', '<link rel="icon" href="' + FAVICON + '">');
} else if (!/rel="icon"/.test(html)) {
  html = html.replace('<title>', '<link rel="icon" href="' + FAVICON + '">\n<title>');
}

/* ---------------- 4. 替换页面标题 ---------------- */
if (A.title) {
  html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>' + A.title + '</title>');
  if (html.includes('__SITE_TITLE__')) html = html.split('__SITE_TITLE__').join(A.title);
}

/* 4b. logo 副标题：优先用 --slogan，否则从标题里取「题号·关键词」一段。
   必须做 HTML 转义 —— 标题来自命令行，可能含 < > & 等字符。 */
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let slogan = A.slogan;
if (!slogan && A.title) {
  // 例："时频冲突 · 答辩作战台" → "时频冲突"
  slogan = A.title.split(/[·|｜\-—\/]/)[0].trim().slice(0, 18);
}
if (slogan) {
  html = html.replace(/(<small id="logoSlogan">)[\s\S]*?(<\/small>)/,
    (m, a, b) => a + escAttr(slogan) + b);
}

/* ---------------- 5. 输出 ---------------- */
fs.mkdirSync(A.out, { recursive: true });
const outFile = path.join(A.out, 'index.html');
fs.writeFileSync(outFile, html);

const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log('✅ 生成 ' + outFile);
console.log('   体积 ' + kb + ' KB');
console.log('   文档 ' + docsSlim.length + ' | 问题 ' + questions.length + ' | 话术组 ' +
  emergency.length + ' | 公式 ' + BUNDLE.formulas.length);

/* ---------------- 6. 自检：残留外链资源会让离线单文件失效 ---------------- */
const imgLinks = (html.match(/https?:\/\/[^\s"'<>)]+\.(?:png|jpe?g|gif|svg|webp)/gi) || []);
if (imgLinks.length) {
  console.warn('⚠️  发现外链图片 ' + imgLinks.length + ' 个（离线打开会失效）：');
  [...new Set(imgLinks)].slice(0, 10).forEach(u => console.warn('    ' + u));
} else {
  console.log('   ✓ 无外链图片资源（自包含）');
}

// 自检 1：关键占位符必须已被替换（这些漏了会导致白屏或公式失效）
// 注意排除 bundle.js 自己代码里出现的字面量（它们在构建产物里不该存在）
const CRITICAL = ['{{TITLE}}', '{{TEAM}}', '{{DATE}}', '{{SLOGAN}}'];
const missingCritical = CRITICAL.filter(t => html.includes(t));
if (missingCritical.length) {
  console.warn('⚠️  关键占位符未替换（可能导致页面缺内容）：' + missingCritical.join(', '));
}

// 自检 2：其余未替换的占位符
const leftovers = (html.match(/\{\{[A-Z_]{3,}\}\}|__[A-Z_]{3,}__/g) || [])
  .filter(t => !CRITICAL.includes(t));
if (leftovers.length) {
  console.warn('⚠️  发现未替换的占位符 ' + leftovers.length + ' 个：' +
    [...new Set(leftovers)].slice(0, 8).join(', '));
}
