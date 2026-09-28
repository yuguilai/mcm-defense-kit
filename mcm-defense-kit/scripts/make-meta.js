#!/usr/bin/env node
/* ============================================================
   make-meta.js — 生成 meta.json
   ------------------------------------------------------------
   meta.json 决定侧边栏中文档的顺序、编号与标题。
   不写它也能用（parse.js 会按文件名兜底），但写了才能保证
   编号连续、标题干净（不会出现「一、」「1.」这类前缀）。

   用法：
     node make-meta.js --dir <md目录> --title "《论文标题》" --team "第 XX 号队伍"
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = { dir: '', title: '', team: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') a.dir = argv[++i];
    else if (argv[i] === '--title') a.title = argv[++i];
    else if (argv[i] === '--team') a.team = argv[++i];
  }
  if (!a.dir) {
    console.error('用法: node make-meta.js --dir <md目录> [--title "标题"] [--team "队伍"]');
    process.exit(1);
  }
  return a;
}
const A = parseArgs(process.argv.slice(2));

if (!fs.existsSync(A.dir)) { console.error('✗ 目录不存在: ' + A.dir); process.exit(1); }

/* 标准 11 份文件的推荐顺序与标题。
   key 是文件名前缀中的关键词，用于匹配实际文件名。 */
const SCHEMA = [
  { match: /总目录|README|目录/i,            no: '00', title: '总目录 · 五分钟速览',       order: 0 },
  { match: /答辩流程|流程与准备|答辩准备/,    no: '01', title: '答辩流程与准备',           order: 1 },
  { match: /自述|讲稿|汇报稿/,               no: '02', title: '自述讲稿（可直接背诵）',    order: 2 },
  { match: /公式/,                           no: '03', title: '公式圣经（全部公式）',      order: 3 },
  { match: /分工/,                           no: '04', title: '三人分工与准备清单',       order: 4 },
  { match: /不匹配|代码与论文|对照/,          no: '05', title: '代码与论文不匹配应对',      order: 5 },
  { match: /问题库|评委问题|问答/,            no: '06', title: '评委问题库（含标准回答）',  order: 6 },
  { match: /速记|数字卡|核心数字/,            no: '07', title: '核心数字速记卡',           order: 7 },
  { match: /不懂代码/,                       no: '08', title: '不懂代码的准备策略',       order: 8 },
  { match: /应急|话术|救场/,                  no: '09', title: '应急话术（按场景查表）',   order: 9 },
  { match: /倒计时|清单|三天/,                no: '10', title: '三天倒计时清单',           order: 10 },
];

const files = fs.readdirSync(A.dir)
  .filter(f => f.toLowerCase().endsWith('.md'))
  /* 排除仓库/示例自带的说明文件，它们不是答辩手册的一部分 */
  .filter(f => !/^(README|LICENSE|CHANGELOG|CONTRIBUTING|SKILL)\.md$/i.test(f));
const used = new Set();
const entries = [];

for (const f of files) {
  const hit = SCHEMA.find(s => !used.has(s.no) && s.match.test(f));
  if (hit) {
    used.add(hit.no);
    entries.push({ file: f, no: hit.no, title: hit.title, order: hit.order });
  }
}

// 未匹配到的文件，按序号递增追加
let extra = 90;
for (const f of files) {
  if (entries.some(e => e.file === f)) continue;
  entries.push({
    file: f, no: String(extra++), order: 100,
    title: f.replace(/\.md$/, '').replace(/^\d+[_\-.\s]*/, ''),
  });
}

entries.sort((a, b) => a.order - b.order);

const meta = {
  title: A.title || '',
  team: A.team || '',
  docs: entries.map(e => ({ file: e.file, no: e.no, title: e.title })),
  builtBy: 'mcm-defense-kit/make-meta.js',
  builtAt: new Date().toISOString().slice(0, 10),
};

const out = path.join(A.dir, 'meta.json');
fs.writeFileSync(out, JSON.stringify(meta, null, 2));

console.log('✅ 生成 ' + out);
console.log('   登记 ' + entries.length + ' 份文档：');
entries.forEach(e => console.log('     ' + e.no + '  ' + e.title + '  ←  ' + e.file));
if (files.length - entries.length === 0) {
  console.log('   ✓ 目录下所有 .md 均已登记');
}
