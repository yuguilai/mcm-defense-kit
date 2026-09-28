#!/usr/bin/env node
/* ============================================================
   build.js — 一条命令走完三步
   ------------------------------------------------------------
     node build.js --src <md目录> --out <输出目录> \
          --template <template.html> --title "答辩助手标题"

   内部依次调用：
     1. make-meta.js  生成 meta.json（保证编号与标题整齐）
     2. parse.js      md → JSON
     3. bundle.js     内嵌成单文件 index.html

   产物：<输出目录>/index.html（自包含，可直接双击打开或分享）
   ============================================================ */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const a = { src: '', out: '', template: '', title: '', slogan: '', team: '', skipMeta: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--src') a.src = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--template') a.template = argv[++i];
    else if (k === '--title') a.title = argv[++i];
    else if (k === '--slogan') a.slogan = argv[++i];
    else if (k === '--team') a.team = argv[++i];
    else if (k === '--skip-meta') a.skipMeta = true;
  }
  if (!a.src || !a.out) {
    console.error('用法: node build.js --src <md目录> --out <输出目录> [--template <tpl>] [--title "标题"] [--slogan "副标题"] [--team "队名"]');
    process.exit(1);
  }
  // 模板默认用技能自带的
  if (!a.template) a.template = path.join(__dirname, '..', 'assets', 'template.html');
  return a;
}
const A = parseArgs(process.argv.slice(2));

// ★ 子进程的 cwd 会切到脚本所在目录，因此这里必须把用户给的相对路径
//   转成绝对路径再传下去，否则子进程里找不到。
const BASE = process.cwd();
A.src = path.resolve(BASE, A.src);
A.out = path.resolve(BASE, A.out);
if (A.template) A.template = path.resolve(BASE, A.template);

const here = __dirname;
const assetsDir = path.join(A.out, '.assets');

if (!require('fs').existsSync(A.src)) {
  console.error('✗ Markdown 目录不存在: ' + A.src);
  process.exit(1);
}
if (!require('fs').existsSync(A.template)) {
  console.error('✗ 模板文件不存在: ' + A.template);
  process.exit(1);
}

function run(script, args, label) {
  console.log('\n── ' + label + ' ──');
  const r = spawnSync(process.execPath, [path.join(here, script), ...args],
    { stdio: 'inherit', cwd: here });
  if (r.status !== 0) {
    console.error('\n✗ ' + label + ' 失败（退出码 ' + r.status + '）');
    process.exit(r.status || 1);
  }
}

/* 1. meta.json */
if (!A.skipMeta) {
  run('make-meta.js', ['--dir', A.src, '--title', A.title || '', '--team', A.team || ''], '第 1 步 / 3：整理文档目录');
}

/* 2. md → JSON */
run('parse.js', ['--src', A.src, '--out', assetsDir], '第 2 步 / 3：解析 Markdown');

/* 3. JSON → 单文件 HTML */
run('bundle.js', ['--assets', assetsDir, '--template', A.template,
  '--out', A.out, '--title', A.title || '数学建模答辩助手',
  '--slogan', A.slogan || ''], '第 3 步 / 3：生成单文件 HTML');

console.log('\n' + '='.repeat(56));
console.log('✅ 构建完成');
console.log('   ' + path.join(A.out, 'index.html'));
console.log('   临时数据在 ' + assetsDir + '（可删除，不影响产物）');
console.log('='.repeat(56));
