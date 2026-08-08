/* 一次性主题改写（修正版）：把组件类名里的硬编码设计令牌颜色转换为 var(--color-*) 任意值。
   处理 className="..." / className={'...'} / className={`...`}，包括模板字符串 ${} 内的条件字符串字面量。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../src/renderer/src');

const TOKEN_MAP = [
    ['bg-[#1c1c1e]', 'bg-[var(--color-bg)]'],
    ['bg-[#2c2c2e]', 'bg-[var(--color-surface)]'],
    ['bg-[#3a3a3c]', 'bg-[var(--color-surface-hover)]'],
    ['bg-[#48484a]', 'bg-[var(--color-surface-active)]'],
    ['bg-[#0a84ff]', 'bg-[var(--color-accent)]'],
    ['border-[#3a3a3c]', 'border-[var(--color-border)]'],
    ['border-[#0a84ff]', 'border-[var(--color-accent)]'],
    ['text-[#636366]', 'text-[var(--color-muted)]'],
    ['text-[#98989d]', 'text-[var(--color-muted2)]'],
    ['text-[#0a84ff]', 'text-[var(--color-accent)]'],
    ['bg-white', 'bg-[var(--color-surface)]'],
    ['border-white', 'border-[var(--color-border)]'],
    ['text-black', 'text-[var(--color-text)]'],
    ['bg-black', 'bg-[var(--color-bg)]'],
];

// 强调色 / 彩色背景：其上 text-white 应保持白色（两种主题都可读）
const COLORED_BG = /(bg-accent|bg-success|bg-warning|bg-danger|bg-red|bg-green|bg-blue|bg-primary|bg-gradient|bg-\[#(0a84ff|34c759|ff3b30|ff9f0a|248a3d|d70015|b25000|0969da|5ac8fa|e81123)\]|bg-\[var\(--color-(accent|success|warning|danger)\)\])/;

function transformClasses(cls) {
    let out = cls;
    for (const [from, to] of TOKEN_MAP) {
        out = out.split(from).join(to);
    }
    // text-white：中性背景上切换为深色文本；彩色背景上保持白色
    if (!COLORED_BG.test(out)) {
        out = out.split('text-white').join('text-[var(--color-text)]');
    }
    return out;
}

// 转换文本中的双/单引号字符串字面量内容（用于 ${} 插值内的条件分支）
function transformQuotedStrings(text) {
    let out = text.replace(/"([^"]*)"/g, (_, s) => `"${transformClasses(s)}"`);
    out = out.replace(/'([^']*)'/g, (_, s) => `'${transformClasses(s)}'`);
    return out;
}

function processTemplateContent(inner) {
    return inner.replace(/(\$\{([\s\S]*?)\})|([^$]+)/g, (m, interp) => {
        if (interp) return transformQuotedStrings(interp); // 转换插值内的字符串字面量
        return transformClasses(m);                        // 转换静态文本
    });
}

function rewrite(content) {
    let out = content;
    // 双引号 className="..."
    out = out.replace(/className="([^"]*)"/g, (m, inner) => `className="${transformClasses(inner)}"`);
    // 单引号 className='...'
    out = out.replace(/className='([^']*)'/g, (m, inner) => `className='${transformClasses(inner)}'`);
    // 模板字符串 className={`...`}
    out = out.replace(/className=\{`([\s\S]*?)`\}/g, (m, inner) => `className={\`${processTemplateContent(inner)}\`}`);
    return out;
}

function walk(dir) {
    let changed = 0;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            changed += walk(full);
        } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
            const src = fs.readFileSync(full, 'utf8');
            const next = rewrite(src);
            if (next !== src) {
                fs.writeFileSync(full, next, 'utf8');
                changed++;
                console.log('updated:', path.relative(ROOT, full));
            }
        }
    }
    return changed;
}

const n = walk(ROOT);
console.log(`\nDone. ${n} files updated.`);
