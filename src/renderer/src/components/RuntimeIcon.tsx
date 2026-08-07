/**
 * 运行时图标组件
 * 使用本地 icon 目录中的图标
 */

// 导入本地图标
import nodeIcon from '../../assets/icons/Node.js.png';
import pythonIcon from '../../assets/icons/Python.png';

// 运行时类型
export type RuntimeType = 'node' | 'python' | 'git';

// 运行时图标映射（git 无本地 png，走内联 SVG 分支）
const RuntimeIconMap: Partial<Record<RuntimeType, string>> = {
    node: nodeIcon,
    python: pythonIcon,
};

interface RuntimeIconProps {
    runtime: RuntimeType;
    size?: number;
    className?: string;
}

/**
 * 运行时图标组件
 */
export default function RuntimeIcon({
                                        runtime,
                                        size = 20,
                                        className = '',
                                    }: RuntimeIconProps) {
    const iconSrc = RuntimeIconMap[runtime];

    // Git：无本地图标资源，用内联 SVG（橙色底 + 分支图形）
    if (!iconSrc) {
        return (
            <div
                className={`inline-flex items-center justify-center rounded bg-[#f05133] ${className}`}
                style={{width: size, height: size}}
            >
                <svg className="w-3/5 h-3/5" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.2}>
                    <circle cx="6" cy="6" r="2.4"/>
                    <circle cx="6" cy="18" r="2.4"/>
                    <circle cx="18" cy="12" r="2.4"/>
                    <path strokeLinecap="round" d="M6 8.4v7.2"/>
                    <path strokeLinecap="round" d="M15.6 12H12a6 6 0 01-6-6"/>
                </svg>
            </div>
        );
    }

    return (
        <img
            src={iconSrc}
            alt={runtime}
            width={size}
            height={size}
            className={`inline-block object-contain ${className}`}
        />
    );
}
