# 常见问题排查

按症状查。

---

## 构建阶段

### `❌ 找不到源目录` / `ENOENT`

`build.js` 的参数写错了。它会 `path.resolve(process.cwd(), ...)`，所以：

- 相对路径以**你执行命令时所在的目录**为基准，不是脚本目录
- 建议直接用绝对路径

```bash
# ✅ 稳妥
node scripts/build.js --src /abs/path/to/handbook --out /abs/path/to/dist

# ⚠️ 相对路径也对，但要在项目根目录执行
cd /path/to/mcm-defense-kit
node mcm-defense-kit/scripts/build.js --src examples/demo-handbook --out /tmp/out
```

### `文档 0 篇` / 页面空白

`meta.json` 里的文件名与实际不匹配。

```bash
# 先单独跑 make-meta 看它扫到了什么
node scripts/make-meta.js --dir <md目录> --title "测试"
cat <md目录>/meta.json
```

`make-meta.js` 内置 11 条规则，按**文件名关键词**匹配。命中的会排进 1–11；没命中的按 `90+` 追加。如果全都追加了，说明文件名和规则差太远 —— 回头改文件名，或者手改 `meta.json` 后加 `--skip-meta`。

### `❌ 语法错误` / bundle 报 `vm.Script`

`bundle.js` 会用 `vm.Script` 预检内联的脚本。报错说明模板里的 JS 或注入的数据里有语法问题。

常见原因：
- 数据里含未转义的 `</script>`
- 数据里含孤立的反斜杠

**快速定位**：看报错的行号，去 `assets/template.html` 对应位置找。

### 体积异常（< 100 KB 或 > 5 MB）

- **太小** → 数据没注入成功，检查 `<out>/.assets/*.json` 是否为空
- **太大** → 有外链图片被内联了。`bundle.js` 会打印外链计数，正常应该是「✓ 无外链图片资源」

---

## 公式渲染阶段

### 页面里出现 `\alpha`、`\sum` 这类原文

**头号问题。** 三种原因，逐个排查：

#### 原因 1：写成了 `\(...\)` 或 `\[...\]`

渲染管线**只认** `$...$` 和 `$$...$$`。全文替换掉。

#### 原因 2：表格单元格里的公式含 `|`

Markdown 表格用 `|` 分隔列。公式 `$|\Delta f_i|$` 里的竖线会把一行劈成好几列。

**已修复**：`parse.js` 的 `splitRow()` 会在切分前把 `$...$` 内部的竖线占位保护起来。

如果你手改过 `parse.js` 导致失效，检查：
```js
function splitRow(line) {
  const keep = [];
  const guarded = String(line).replace(/\$([^$\n]*)\$/g, (m, p) => {
    keep.push(m);
    return '\u0003P' + (keep.length - 1) + '\u0003';
  });
  // ...切分后还原
}
```

#### 原因 3：跨行的 `$$...$$` 被拆散

块级公式如果跨多行（`cases` / `aligned` 环境），会被按行切分后拆碎。

**已修复**：`mdToHtml()` 开头会把跨行 `$$...$$` 整体抽出成占位符 `\u0002B{n}\u0002`。

检查 `parse.js` 的 `mdToHtml()` 开头是否有这段：
```js
const text = String(md).replace(/\r\n?/g, '\n')
  .replace(/\$\$([\s\S]+?)\$\$/g, (m, p) => {
    blocks.push('<div class="mathblk">' + texToHtml(p) + '</div>');
    return '\u0002B' + (blocks.length - 1) + '\u0002';
  });
```

同时确认 `restore()` 被包在**所有** `inline()` 调用点外面（表格 TD/TH、段落、列表）。

### 公式渲染了，但上下标没出来

`latex.js` 的 `SUP` / `SUB` 表可能没有该符号。

打开 `scripts/latex.js`，在 `SUP`（上标）或 `SUB`（下标）表里补：

```js
const SUP = {
  // ...
  'n': 'ⁿ', 'i': 'ⁱ', 'j': 'ʲ', 'k': 'ᵏ',
};
```

补完重新构建。注意 `latex.js` 是双用途导出（Node + 浏览器），改动后两边都会生效。

### 想要某个特殊符号

同样在 `latex.js` 的 `SYM` 表里加：

```js
const SYM = {
  // ...
  '\\varnothing': '∅',
};
```

---

## 运行时阶段

### 设置面板打不开

**历史 Bug**：`openSet()` 里访问了不存在的 DOM id，抛错导致整个面板卡死。

**已修复**：所有控件访问都通过 `setV()` / `gv()` 兜底。

如果你改动设置面板 HTML，**务必确认这些 id 都存在**：

```
#apiPreset #apiKey #apiBase #apiModelInput #modelSuggest #apiThinking #apiStyle
#asrEngine #asrWhisperBox #asrPreset #asrPresetHint #asrBase #asrKey
#asrModel #asrModelSuggest #asrChunk #asrLang
#optAutoAsk #optEmbedAnswer #optInterim #optDark
#setTest #setTestAsr #setClear #setSave #apiStatus
```

缺任何一个，`openSet` 里对应的 `setV()` 会打一条 `console.warn` 但不会崩 —— 这是兜底逻辑的意义。但 `#asrPresetHint` 这种被 `.textContent =` 直接赋值的，**必须存在**。

### 搜索报 `toLowerCase of undefined`

某个索引项的 `text` 是 undefined。

**已修复**：`fuzzy()` 和 `hl()` 都加了 `String()` 兜底。

如果自己改了 `buildIndex()`，确保 `idx.push` 的每一项都有 `text` 字段且是字符串：
```js
idx.push({
  type: 'q', qid: q.id, title: label + ' ' + q.q,
  text: [q.q, q.a || q.oral || '', q.point || ''].join(' '),  // ← 必须有
  src: String(label),
});
```

### 角色芯片计数全是 0

问题对象的 `roles` 字段格式不对。

模板里的 `qMatches()` 会拿 `roles` 跟 `CATS[].role`（英文）做**包含判断**：

```js
const CATS = [
  { role: 'model', name: '建模手' },
  { role: 'code',  name: '编程手' },
  { role: 'paper', name: '论文手' },
  { role: 'all',   name: '通用' },
];
```

所以 `roles` 必须是**英文键数组**，如 `['model', 'code']`，不能是中文。

`parse.js` 的 `mkQ()` 用 `ROLE_KEY` 做映射：
```js
const ROLE_KEY = {
  '建模手':'model','模型':'model',
  '编程手':'code','代码':'code','程序':'code',
  '论文手':'paper','写作':'paper','论文':'paper',
  '通用':'all','全员':'all','all':'all',
};
```

新增角色关键词时，**中文和英文都要加**。

### 语音识别没反应

按引擎分别排查：

**浏览器内置引擎**
- 只在 Chrome / Edge 可用（Firefox、部分 Safari 不支持）
- **必须 HTTPS 或 localhost**，`file://` 打开会静默失败
- 检查浏览器是否已授予麦克风权限

**Whisper 引擎**
1. 点设置 → 语音识别 → 选 whisper 引擎
2. 填 Base URL + API Key + 模型名
3. 点「测试识别」—— 它会上传一段静音 WAV，能验证密钥和端点是否通
4. 测试通过后再点录音

如果测试通过但录音失败：
- 看控制台错误
- 检查 `切片时长`，网络差就调大（默认 6 秒）
- 单段失败只 `console.warn`，连续 3 次才提示 —— 看 console 才知道

**本地服务（faster-whisper / Ollama）**
- 确认服务在跑：`curl http://localhost:8000/v1/models`
- 确认端点实现了 `/audio/transcriptions`（有些只实现 `/chat/completions`）

### AI 问答报错

**401 / 403** → API Key 错，或该 key 没开通这个模型
**404** → Base URL 或模型名错。注意有些服务商要带 `/v1`，有些不带
**400** → 请求体格式问题。检查是不是该服务商不支持 `thinking` 字段

**无密钥能不能用** → 只有 Ollama 和 `localhost` 地址可以。其他都要 key。

### 页面白屏 + 控制台报 `Cannot read properties of null`

某个 DOM id 不存在，初始化时抛错。按报错里的 id 名去 `template.html` 里找，补上对应元素。

---

## 验收清单（交付前逐项过）

```
□ 11 篇文档都能点开
□ 每页零 LaTeX 残留（搜 `\alpha` 这种应无结果）
□ 每页零 `$` 残留
□ 公式上下标正常（有 <sup>/<sub>）
□ 问题卡数 = 源文件题数
□ 角色芯片计数不为 0
□ 话术表按组正常显示
□ 搜索核心词有命中
□ 控制台零 pageerror
□ 手机宽度 375px 不横向溢出
□ 设置面板能开，8 模型预设可切
□ 5 个语音预设可切
□ 「测试识别」按钮有反馈
```

**任意一项不过，不要交付。**
