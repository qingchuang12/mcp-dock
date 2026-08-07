/**
 * SKILL.md 的 YAML frontmatter 解析（主进程与渲染端共用）。
 *
 * 两端必须用同一份实现：渲染端详情页此前自带一套「单行正则」解析，
 * 遇到真实仓库里的块标量写法会把 description 解析成字面量 ">"，
 * 于是列表能看到简介、点进详情反而空白/异常。
 *
 * 需要容忍的真实写法：
 *   1) 行内：`description: Create diagrams...`（可带成对引号）
 *   2) 块标量：`description: >` / `|`（含 `-` `+` chomp 后缀），正文在随后的缩进行
 *   3) 文件头带 BOM、行尾为 CRLF
 *
 * 只做 frontmatter 的扁平 key/value 提取，不解析嵌套结构（skill 元数据用不到）。
 */
export function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};

  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let v = kv[2].trim();

    if (/^[|>][-+]?$/.test(v)) {
      // 块标量：收集后续缩进行（> 折叠为空格，| 保留换行）
      const fold = v.startsWith('>');
      const buf: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j];
        // 空行属于块的一部分；非缩进的非空行意味着块结束
        if (ln.trim() === '') {
          buf.push('');
          continue;
        }
        if (!/^\s+/.test(ln)) break;
        buf.push(ln.trim());
        i = j;
      }
      v = fold ? buf.join(' ').replace(/\s+/g, ' ').trim() : buf.join('\n').trim();
    } else if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }

    out[key] = v;
  }

  return out;
}
