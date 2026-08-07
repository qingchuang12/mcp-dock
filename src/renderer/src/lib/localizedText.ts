/**
 * 多语言文本择优（按「设置 → 语言」决定展示哪一份文案）。
 *
 * 规则：当前界面语言 → 英文 → 任意可用语言。
 * 各 skill 源给出的描述语言并不统一（SkillHub 同时给 description 与 description_zh，
 * ModelScope 大量条目只有中文，GitHub Registry 基本只有英文），所以不能在主进程写死优先级，
 * 必须把各语言变体透传到渲染端，由界面语言决定。
 */

/** 中日韩统一表意文字（含扩展 A），用于判定未标注语言的文本是否为中文 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

export interface LocalizedCandidate {
  text?: string | null;
  /** 语言码（如 zh / zh-CN / en）。缺省表示语言未知，按内容判定 */
  lang?: string;
}

/** 'zh-CN' / 'zh_TW' → 'zh'；空值返回空串（区别于「未知语言」的判定路径） */
export function normalizeLang(lang?: string | null): string {
  return (lang || '').toLowerCase().split(/[-_]/)[0];
}

/** 未标注语言时按内容判定：含中日韩汉字视为中文，否则按英文处理 */
export function detectLang(text: string): string {
  return CJK_RE.test(text) ? 'zh' : 'en';
}

/**
 * 在候选文案中按界面语言择优。候选顺序即同语言下的优先级（靠前者胜出）。
 */
export function pickLocalizedText(candidates: LocalizedCandidate[], uiLang?: string): string {
  const preferred = normalizeLang(uiLang) || 'en';

  const entries = candidates
    .map(c => {
      const text = (c.text || '').trim();
      if (!text) return null;
      return { text, lang: normalizeLang(c.lang) || detectLang(text) };
    })
    .filter((e): e is { text: string; lang: string } => e !== null);

  if (entries.length === 0) return '';

  return (
    entries.find(e => e.lang === preferred)?.text ||
    entries.find(e => e.lang === 'en')?.text ||
    entries[0].text
  );
}

/** `description` / `description_zh` / `description-en` 等键名的语言后缀 */
const DESCRIPTION_KEY_RE = /^description(?:[_-]([a-z]{2}(?:[-_][a-z]{2})?))?$/i;

/**
 * 汇总一个 skill 的所有简介候选并按界面语言择优。
 *
 * 优先级（同语言内）：SKILL.md frontmatter（技能自带的权威简介）
 * → 列表接口给出的显式语言变体 → 列表项主描述。
 */
export function pickSkillDescription(
  uiLang: string | undefined,
  opts: {
    /** 已解析的 SKILL.md frontmatter，可能同时含 description 与 description_zh */
    frontmatter?: Record<string, string>;
    /** 列表接口显式标注语言的描述变体，如 { zh: '…' } */
    locales?: Record<string, string>;
    /** 列表项主描述，语言未知 */
    primary?: string;
  }
): string {
  const candidates: LocalizedCandidate[] = [];

  if (opts.frontmatter) {
    for (const [key, value] of Object.entries(opts.frontmatter)) {
      const m = key.match(DESCRIPTION_KEY_RE);
      if (m) candidates.push({ text: value, lang: m[1] });
    }
  }
  if (opts.locales) {
    for (const [lang, text] of Object.entries(opts.locales)) {
      candidates.push({ text, lang });
    }
  }
  candidates.push({ text: opts.primary });

  return pickLocalizedText(candidates, uiLang);
}
