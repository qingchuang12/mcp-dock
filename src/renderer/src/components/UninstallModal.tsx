import type {ReactNode} from 'react';
import {useTranslation} from 'react-i18next';
import type {ClientInfo} from '../lib/electron';
import ClientPickerModal from './ClientPickerModal';

interface UninstallModalProps {
    /** 是否打开 */
    open: boolean;
    /** 标题 */
    title: string;
    /** 副标题 / 说明文字 */
    subtitle: ReactNode;
    /** 目标名称 */
    displayName: string;
    /** 待渲染的客户端列表 */
    clients: ClientInfo[];
    /** 当前勾选的客户端 id 集合 */
    selected: string[];
    /** 点击切换某客户端勾选态 */
    onToggle: (id: string) => void;
    /** 全选 */
    onSelectAll: () => void;
    /** 点击关闭（取消 / 遮罩） */
    onClose: () => void;
    /** 点击确认卸载 */
    onConfirm: () => void;
}

/**
 * 卸载确认弹窗（P2-2）。
 * 视觉与「同步到客户端」弹窗统一，由 ClientPickerModal(variant="uninstall") 承载，
 * 仅配色（危险红）与确认按钮语义不同。
 */
export default function UninstallModal(props: UninstallModalProps) {
    const {t} = useTranslation();
    return (
        <ClientPickerModal
            variant="uninstall"
            open={props.open}
            title={props.title}
            subtitle={props.subtitle}
            displayName={props.displayName}
            clients={props.clients}
            selected={props.selected}
            onToggle={props.onToggle}
            onSelectAll={props.onSelectAll}
            selectAllLabel={t('installed.selectAll')}
            onClose={props.onClose}
            onConfirm={props.onConfirm}
            confirmLabel={t('installed.confirmUninstall')}
            confirmDisabled={props.selected.length === 0}
            cancelLabel={t('common.cancel')}
        />
    );
}
