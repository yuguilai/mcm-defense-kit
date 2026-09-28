/* ============================================================
   LaTeX → Unicode/HTML 轻量转换器（构建期 + 前端共用）
   ------------------------------------------------------------
   目标：把答辩手册里写的 LaTeX 公式，转成"手机上直接能看懂"的
   普通字符 + 少量 HTML 上标/下标。不引 KaTeX/MathJax（体积太大，
   且单文件离线场景不能依赖外部 CDN）。

   设计要点
   1. 先做"结构处理"（去掉 \left \right \displaystyle 等排版指令、
      展开 \text{}/\mathrm{} 等包裹命令），再做"符号替换"。
   2. 中文/数字紧跟命令时必须补空格：如 \Delta g → "Δ g" 而不是 "Δg"，
      但 \Delta_{i} 这种带下标的不能补。
   3. 全部输出都经过 HTML 转义，避免把用户内容当标签注入。
   4. 上下标用 <sup>/<sub>，其余用 Unicode 字符。
   ============================================================ */
'use strict';

/* ---------- 符号表：LaTeX 命令 → Unicode ---------- */
const SYM = {
  // 希腊字母（小写）
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  // 希腊字母（大写）
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // 运算与关系
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  equiv: '≡', approx: '≈', sim: '∼', simeq: '≃', propto: '∝',
  ll: '≪', gg: '≫', iff: '⟺', Leftrightarrow: '⟺', implies: '⟹',
  Rightarrow: '⟹', leftarrow: '←', to: '→', mapsto: '↦',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆',
  supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖',
  emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬',
  land: '∧', wedge: '∧', lor: '∨', vee: '∨',
  infty: '∞', partial: '∂', nabla: '∇',
  // ★ 定界符类：\mid \vert \Vert 常出现在"集合定义"里（如 {x | x>0}）
  mid: ' | ', vert: '|', Vert: '‖', lvert: '|', rvert: '|', lVert: '‖', rVert: '‖',
  // 其他常见关系符
  star: '⋆', bullet: '•', oplus: '⊕', otimes: '⊗', sqcup: '⊔', sqcap: '⊓',
  triangleq: '≜', coloneqq: '≔', vdash: '⊢', models: '⊨', top: '⊤', bot: '⊥',
  lesssim: '≲', gtrsim: '≳',
  overset: '', underset: '', stackrel: '',
  // 大运算符
  sum: '∑', prod: '∏', int: '∫', oint: '∮',
  max: 'max', min: 'min', argmax: 'argmax', argmin: 'argmin',
  log: 'log', ln: 'ln', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan',
  gcd: 'gcd', sup: 'sup', inf: 'inf', lim: 'lim', mod: ' mod ',
  bmod: 'mod', pmod: 'mod',
  // 箭头与括号
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  langle: '⟨', rangle: '⟩',
  // 其他
  dots: '…', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  quad: '\u2003', qquad: '\u2003\u2003', thinspace: ' ', enskip: '\u2002',
  percent: '%', hash: '#', amp: '&', underscore: '_', dollar: '$',
  circ: '∘', prime: '′', degree: '°', angle: '∠', perp: '⊥', parallel: '∥',
  therefore: '∴', because: '∵', checkmark: '✓',
  mathbb: '', mathcal: '', mathbf: '', mathrm: '', mathit: '', mathsf: '',
  text: '', textbf: '', textit: '', operatorname: '', ensuremath: '',
  left: '', right: '', big: '', Big: '', bigg: '', Bigg: '',
  displaystyle: '', textstyle: '', limits: '', nolimits: '',
  ' ': ' ', ',' : ' ', ';': ' ', '!': '', ':': ' ',
};

/* ---------- 上标/下标里也用到的特殊字符映射 ---------- */
const SUP = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹',
  '+':'⁺','-':'⁻','=':'⁼','(':'⁽',')':'⁾','n':'ⁿ','i':'ⁱ' };
const SUB = { '0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉',
  '+':'₊','-':'₋','=':'₌','(':'₍',')':'₎','a':'ₐ','e':'ₑ','i':'ᵢ','j':'ⱼ','k':'ₖ','n':'ₙ',
  'o':'ₒ','p':'ₚ','r':'ᵣ','s':'ₛ','t':'ₜ','u':'ᵤ','v':'ᵥ','x':'ₓ' };

function htmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* 判断一个字符是否"字母类"（用于决定是否补空格） */
function isWordChar(c) {
  if (!c) return false;
  return /[A-Za-z0-9\u4e00-\u9fff]/.test(c);
}

/**
 * 把一段 LaTeX（不含最外层 $）转成 HTML 片段。
 * 输入应当是**未转义**的原始文本。
 */
function texToHtml(src) {
  let s = String(src == null ? '' : src);

  // ---------- 0. 还原 HTML 实体 ----------
  // 公式片段常常来自"已经转义过的 HTML"（如文档正文），
  // 若不解码，\max(a,c) &lt; \min(b,d) 会被当成 &lt; 文本，最后变成 "lt;"。
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
       .replace(/&amp;/g, '&');

  // ---------- 1. 结构：\begin{...}...\end{...} 环境 ----------
  // 常见 cases / aligned / matrix：转成换行分隔的可读文本
  s = s.replace(/\\begin\{(cases|aligned|align\*?|array|matrix|pmatrix|bmatrix)\}/g, '');
  s = s.replace(/\\end\{(cases|aligned|align\*?|array|matrix|pmatrix|bmatrix)\}/g, '');
  s = s.replace(/\\hline/g, '');
  // 对齐符 & → 空格（保持可读，不做真对齐）
  s = s.replace(/&/g, '\u2003');
  // \\ 换行（在文本里显示为换行）
  s = s.replace(/\\\\/g, '<br>');

  // ---------- 2. 递归展开"包裹型"命令 ----------
  // \text{...} \mathrm{...} \mathbf{...} \mathcal{...} \operatorname{...}
  // 这些命令只影响字形，去掉命令保留内容（内容做转义）
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s.replace(/\\(?:text|textrm|textit|textbf|textsf|texttt|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|mathfrak|operatorname|ensuremath)\s*\{([^{}]*)\}/g,
      (m, inner) => texToHtml(inner));
    if (s === before) break;
  }

  // \frac{a}{b} → a/b（用括号保证优先级可读）
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s.replace(/\\dfrac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
    s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
    if (s === before) break;
  }

  // \sqrt{a} → √(a)
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');

  // ---------- 3. 上下标 ----------
  // 上标：^{...} 或 ^x
  s = s.replace(/\^\{([^{}]*)\}/g, (m, p) => '<sup>' + texToHtml(p) + '</sup>');
  s = s.replace(/\^(-?[A-Za-z0-9])/g, (m, p) => '<sup>' + texToHtml(p) + '</sup>');
  // 下标：_{...} 或 _x
  s = s.replace(/_\{([^{}]*)\}/g, (m, p) => '<sub>' + texToHtml(p) + '</sub>');
  s = s.replace(/_(-?[A-Za-z0-9])/g, (m, p) => '<sub>' + texToHtml(p) + '</sub>');

  // ---------- 4. 单字符命令转义 ----------
  s = s.replace(/\\([%#$&_{}])/g, '$1');

  // ---------- 5. 命令替换 ----------
  // ★ 关键：用一个"占位符"方案，先把命令换成唯一占位符，最后统一替换，
  //   避免 \ge 把 \gemin 之类误伤，也避免替换结果又被后续规则再处理一次。
  const names = Object.keys(SYM).filter(k => /^[A-Za-z]+$/.test(k)).sort((a, b) => b.length - a.length);
  const mapToken = new Map();
  names.forEach((name, i) => {
    const tok = '\u0001' + i + '\u0002';
    mapToken.set(tok, SYM[name]);
    // 必须在命令后紧跟非字母（或用负向前瞻），否则 \gemin 不该被 \ge 匹配
    s = s.replace(new RegExp('\\\\' + name + '(?![A-Za-z])', 'g'), tok);
  });
  // 反斜杠后紧跟空格 = LaTeX 的"强制空格"，必须还原成普通空格
  s = s.replace(/\\ /g, ' ');
  // 单字符符号命令：\, \; \! \: 空格类
  s = s.replace(/\\,/g, ' ').replace(/\\;/g, ' ').replace(/\\!/g, '').replace(/\\:/g, ' ');

  // ---------- 6. 未识别的命令：去掉反斜杠，保留名字 ----------
  s = s.replace(/\\([A-Za-z]+)/g, '$1');
  // 残余的孤立反斜杠（如 \| \} 之类）直接去掉
  s = s.replace(/\\(?![A-Za-z0-9])/g, '');

  // ---------- 7. 占位符还原 ----------
  for (const [tok, val] of mapToken) {
    if (s.includes(tok)) s = s.split(tok).join(val === undefined ? '' : val);
  }

  // ---------- 7.5 去掉符号两侧多余的空格 ----------
  // 7.5a LaTeX 源码里 `\mathrm{max}(a,c) < \min` 这类写法，空格是给人读源码用的；
  //      产出的 HTML 里 < 紧贴两侧字母没问题，浏览器不会误解析。
  s = s.replace(/([A-Za-z0-9\u4e00-\u9fff>]) +(?=[<>\u2264\u2265\u2260])/g, '$1');
  s = s.replace(/([<>\u2264\u2265\u2260]) +(?=[A-Za-z0-9\u4e00-\u9fff<])/g, '$1');
  // 7.5b 紧跟符号/上标下标后的空格：`\le 10` → `≤10`、`\Delta f_i` → `Δf_i`、
  //      `|Δf_i| \le 10` → `|Δf_i|≤10`。
  //      规则：左侧是非字母数字（运算符/开括号/闭合标签）且右侧是"内容起始"时删空格；
  //      右侧是 ( [ { 之类的开括号则保留，维持 `∈ [-10,10]` 这类可读性。
  const OPS = '∈∉∋⊂⊆⊇∩∪∀∃∧∨¬≤≥≠≈≡⟹⟺→←↔±×÷∑∏√∞∇⊕⊗';
  const OPENB = '(（[【{';
  s = s.replace(new RegExp('([^\\sA-Za-z0-9\\u4e00-\\u9fff]) +(?=[A-Za-z0-9\\u4e00-\\u9fff<])', 'g'), (m, p, off, str) => {
    const nxt = String(str).slice(off + p.length + 1);
    // 先看右侧是不是运算符（`|Δf_i| ≤ 10`）——是运算符就一律删空格
    if (new RegExp('^[' + OPS + ']').test(nxt)) return p;
    // 右侧是开括号/区间：保留空格（`∈ [-10,10]`）
    if (new RegExp('^[' + OPENB + ']').test(nxt)) return m;
    // 左侧是开括号：括号内不该有前导空格（`∑_i \left(...` → `∑_i(...`）
    if (new RegExp('[' + OPENB + ']$').test(p)) return p;
    // 右侧是上标/下标/闭括号前的空格再交给后面的规则处理，这里删掉更干净
    return p;
  });
  // 7.5c 字母数字 + 空格 + 纯运算符（`x \in` → `x∈`、`n ≥ 5` → `n≥5`）
  s = s.replace(new RegExp('([A-Za-z0-9\\u4e00-\\u9fff>]) +(?=[' + OPS + '])', 'g'), '$1');
  // 7.5d 闭合标签（</sub>）后紧跟符号（`x_i \in A` → `x_i∈ A`）——标签已产出，前面规则看不到
  s = s.replace(/<\/(sub|sup)> +(?=[' + OPS + '])/g, '</$1>');
  // 7.5e 成对定界符内部去空格：`‖x ‖_2` → `‖x‖_2`、`| Δf |` → `|Δf|`、`⌊ n/2 ⌋` → `⌊n/2⌋`
  //      用成对匹配（而非全局删）以免误伤 `a | b` 这类真正的分隔用法。
  s = s.replace(/‖([^‖\n]*?)‖/g, (m, p) => '‖' + p.trim() + '‖');
  s = s.replace(/⌊([^⌊⌋\n]*?)⌋/g, (m, p) => '⌊' + p.trim() + '⌋');
  s = s.replace(/⌈([^⌈⌉\n]*?)⌉/g, (m, p) => '⌈' + p.trim() + '⌉');
  // 单竖线：只有当"|...|"看起来是绝对值/模（内部无逗号分隔的并列项）时才收紧
  s = s.replace(/\|([^|\n]*?)\|/g, (m, p) => (/,/.test(p) ? m : '|' + p.trim() + '|'));

  // ---------- 8. 收尾清理 ----------
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/\s+([,.;:!?，。；：！？])/g, '$1');
  s = s.replace(/^\s+|\s+$/g, '');
  // 去掉空的上标/下标（\mathrm 之类被清空后可能留下空标签）
  s = s.replace(/<sup><\/sup>/g, '').replace(/<sub><\/sub>/g, '');

  // ---------- 9. 安全性：只保留 sup/sub/br，其余尖括号转义 ----------
  // 用一个临时占位符护住我们要保留的标签，转义后还原。
  const keep = [];
  s = s.replace(/<\/?(?:sup|sub|br)\s*\/?>/g, m => {
    keep.push(m);
    return '\u0003' + (keep.length - 1) + '\u0004';
  });
  s = s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/\u0003(\d+)\u0004/g, (m, i) => keep[+i]);

  return s;
}

/**
 * 前端/构建期通用：把正文里的 $...$ 与 $$...$$ 转成 <span class="math">。
 * 输入是**已 HTML 转义**的文本。
 */
function renderMathInEscaped(escaped) {
  // 先处理块级 $$...$$
  let out = escaped.replace(/\$\$([\s\S]+?)\$\$/g, (m, p) =>
    '<span class="math blk">' + texToHtml(p) + '</span>');
  // 再处理行内 $...$（避免跨行贪婪）
  out = out.replace(/\$([^$\n]+?)\$/g, (m, p) =>
    '<span class="math">' + texToHtml(p) + '</span>');
  return out;
}

/* 双用途导出：
   - Node 构建脚本用 module.exports
   - 浏览器里（bundle.js 内联本文件源码时）挂到 window 上，供 mdLite() 调用
   两边都用 typeof 守卫，因此同一份源码在 Node 和浏览器里都能直接跑。 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { texToHtml, renderMathInEscaped, SYM, htmlEsc };
}
if (typeof window !== 'undefined') {
  window.texToHtml = texToHtml;
  window.renderMathInEscaped = renderMathInEscaped;
}
