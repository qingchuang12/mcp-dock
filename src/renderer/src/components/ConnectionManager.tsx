/**
 * API 直连管理卡片（P2-6）
 * 实现已抽到通用 SourceManager，本文件仅做参数化薄 wrapper。
 */
import {BUILTIN_SKILL_SOURCE_IDS, PLATFORM_META, SKILL_PLATFORM_TYPES} from '../../../shared/platform-constants';
import SourceManager from './SourceManager';

interface Props {
    /** 源列表变化后通知外部（Store 下拉需要重新拉取） */
    onChanged?: () => void;
}

export default function ConnectionManager({onChanged}: Props) {
    return (
        <SourceManager
            namespace="skillSource"
            kind="skill"
            platformTypes={SKILL_PLATFORM_TYPES}
            builtinIds={[BUILTIN_SKILL_SOURCE_IDS.github, BUILTIN_SKILL_SOURCE_IDS.clawhub]}
            createDefaults={{platformType: 'modelscope', baseUrl: PLATFORM_META.modelscope.defaultBaseUrl}}
            exportNames={{single: 'connection.json', multi: 'connections.json'}}
            unknownPlatformFallback
            noTokenColor="text-[#ff9f0a]"
            badgeOrder="default-builtin"
            onChanged={onChanged}
        />
    );
}
