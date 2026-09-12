/**
 * 商店「已安装」徽章的判定口径测试（S-INSTALLED-BADGE）
 *
 * 覆盖：平台源展示名与落盘目录名不一致时的命中、内置源 name 即目录名的命中、
 * id 末段与目录名不同源时靠 source_url 子路径兜底，以及不误判的边界。
 */
import {describe, expect, it} from 'vitest';
import {
    buildInstalledSkillKeys,
    isSkillInstalled,
    skillItemKeys,
    skillMatchKeys,
    skillSourceUrlKeys,
} from '../shared/skill-identity';

describe('skillMatchKeys', () => {
    it('普通目录名只产出全名', () => {
        expect(skillMatchKeys('pdf')).toEqual(['pdf']);
    });

    it('owner/slug 额外产出末段，并统一小写', () => {
        expect(skillMatchKeys('@AMap-Web/amap-lbs-skill')).toEqual([
            '@amap-web/amap-lbs-skill',
            'amap-lbs-skill',
        ]);
    });

    it('空值与纯空白不产出别名', () => {
        expect(skillMatchKeys('')).toEqual([]);
        expect(skillMatchKeys('   ')).toEqual([]);
    });
});

describe('skillSourceUrlKeys', () => {
    it('tree 子路径链接取末段（覆盖 id 末段 ≠ 目录名的场景）', () => {
        expect(skillSourceUrlKeys('https://github.com/baidu-netdisk/bdpan-storage/tree/main/skills/baidu-netdisk'))
            .toEqual(['baidu-netdisk']);
    });

    it('blob 子路径链接同样取末段', () => {
        expect(skillSourceUrlKeys('https://github.com/ant-credit/credit_payment/blob/main/zhima-credit-payafteruse-skill'))
            .toEqual(['zhima-credit-payafteruse-skill']);
    });

    it('仓库根链接不产出别名（末段是仓库名，易误判）', () => {
        expect(skillSourceUrlKeys('https://github.com/pskoett/self-improving-agent')).toEqual([]);
    });

    it('平台页面链接不产出别名（避免把页面名当 skill 名）', () => {
        expect(skillSourceUrlKeys('https://modelscope.cn/studios')).toEqual([]);
    });

    it('带 query 的链接先剥离参数再取末段', () => {
        expect(skillSourceUrlKeys('https://github.com/o/r/tree/main/skills/foo?ref=1#top'))
            .toEqual(['foo']);
    });
});

describe('buildInstalledSkillKeys', () => {
    it('把物理目录名展开为判定集合', () => {
        expect([...buildInstalledSkillKeys(['amap-lbs-skill', 'pdf'])].sort())
            .toEqual(['amap-lbs-skill', 'pdf']);
    });

    it('空输入得到空集合', () => {
        expect(buildInstalledSkillKeys([]).size).toBe(0);
    });
});

describe('isSkillInstalled —— 平台直连源（ModelScope 实测样本）', () => {
    // 落盘目录名来自安装时解析出的 slug，与列表展示名（display_name）不同
    const installed = buildInstalledSkillKeys(['amap-lbs-skill', 'self-improving-agent', 'weather']);

    it('展示名是中文、id 末段即目录名时命中', () => {
        expect(isSkillInstalled(installed, skillItemKeys({
            id: '@AMap-Web/amap-lbs-skill',
            name: '高德地图综合服务Skill',
            sourceUrl: 'https://github.com/AMap-Web/amap-lbs-skill',
        }))).toBe(true);
    });

    it('展示名与 id 末段都不同时靠 id 命中', () => {
        expect(isSkillInstalled(installed, skillItemKeys({
            id: '@pskoett/self-improving-agent',
            name: 'self-improvement',
            sourceUrl: 'https://github.com/pskoett/self-improving-agent',
        }))).toBe(true);
    });

    it('id 大小写与目录名不同也能命中（Windows 目录大小写不敏感）', () => {
        expect(isSkillInstalled(installed, skillItemKeys({
            id: '@Steipete/Weather',
            name: 'weather天气查询',
            sourceUrl: 'https://clawhub.ai/steipete/weather',
        }))).toBe(true);
    });

    it('仅按展示名比对会漏判（回归守卫：旧实现的行为）', () => {
        const byDisplayNameOnly = new Set(['amap-lbs-skill']).has('高德地图综合服务Skill');
        expect(byDisplayNameOnly).toBe(false);
    });
});

describe('isSkillInstalled —— 内置 GitHub Registry 源', () => {
    const installed = buildInstalledSkillKeys(['pdf', 'brand-guidelines']);

    it('name 即目录名时命中（此时 id 形如 skill-<dir>，末段反而匹配不上）', () => {
        expect(isSkillInstalled(installed, skillItemKeys({
            id: 'skill-pdf',
            name: 'pdf',
            sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
        }))).toBe(true);
    });

    it('未安装的同名不同 skill 不误判', () => {
        expect(isSkillInstalled(installed, skillItemKeys({
            id: 'skill-docx',
            name: 'docx',
        }))).toBe(false);
    });
});

describe('isSkillInstalled —— id 末段与目录名不同源', () => {
    const installed = buildInstalledSkillKeys(['baidu-netdisk']);

    it('靠 source_url 的 tree 子路径末段命中', () => {
        expect(isSkillInstalled(installed, skillItemKeys({
            id: 'BaiduDrive/baidu-drive',
            name: '百度网盘官方skill (baidu-drive)',
            sourceUrl: 'https://github.com/baidu-netdisk/bdpan-storage/tree/main/skills/baidu-netdisk',
        }))).toBe(true);
    });
});

describe('isSkillInstalled —— 边界', () => {
    const installed = buildInstalledSkillKeys(['amap-lbs-skill']);

    it('全空标识不命中', () => {
        expect(isSkillInstalled(installed, skillItemKeys({}))).toBe(false);
    });

    it('已安装集合为空时一律不命中', () => {
        expect(isSkillInstalled(new Set(), skillItemKeys({id: 'a/b', name: 'b'}))).toBe(false);
    });
});
