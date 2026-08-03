import {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import ClientIcon from './ClientIcon';
import type {ClientInfo, SkillClientType} from '../lib/electron';

export interface CreateSkillModalProps {
  onClose: () => void;
  /** 全部客户端列表（含 supportsSkills 标记） */
  clients: ClientInfo[];
  /** 编辑模式：传入已安装 skill 的当前数据 */
  editData?: {
    name: string;
    description: string;
    body: string;
    clients: SkillClientType[];
  } | null;
  /** 默认选中的客户端（创建时） */
  defaultClients?: SkillClientType[];
  /** 提交回调：编辑时 originalName 为原名称，创建时为 undefined */
  onSubmit: (originalName: string | undefined, input: { name: string; description: string; body: string }, clients: SkillClientType[]) => Promise<{ success: boolean; error?: string }>;
}

export function CreateSkillModal({ onClose, clients, editData, defaultClients, onSubmit }: CreateSkillModalProps) {
  const { t } = useTranslation();
  const isEdit = !!editData;
  const skillClients = clients.filter(c => c.supportsSkills && c.installed);

  const [name, setName] = useState(editData?.name ?? '');
  const [description, setDescription] = useState(editData?.description ?? '');
  const [body, setBody] = useState(editData?.body ?? '');
  const [selectedClients, setSelectedClients] = useState<SkillClientType[]>(
    (editData?.clients ?? defaultClients ?? ['cursor']) as SkillClientType[]
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const initialRef = useRef({
    name: editData?.name ?? '',
    description: editData?.description ?? '',
    body: editData?.body ?? '',
    clients: (editData?.clients ?? defaultClients ?? ['cursor']) as SkillClientType[],
  });

  const isDirty =
    name !== initialRef.current.name ||
    description !== initialRef.current.description ||
    body !== initialRef.current.body ||
    selectedClients.length !== initialRef.current.clients.length ||
    selectedClients.some(c => !initialRef.current.clients.includes(c));

  const requestClose = () => {
    if (isDirty) {
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  };

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);

  const toggleClient = (id: SkillClientType) => {
    setSelectedClients(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError(t('library.skillNameRequired') || '请输入 Skill 名称');
      return;
    }
    if (selectedClients.length === 0) {
      setError(t('library.skillClientRequired') || '请至少选择一个目标客户端');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await onSubmit(
        isEdit ? editData!.name : undefined,
        { name: name.trim(), description: description.trim(), body: body.trim() },
        selectedClients
      );
      if (!result.success) {
        setError(result.error || (t('library.skillSaveFailed') || '保存失败'));
        setSubmitting(false);
      } else {
        onClose();
      }
    } catch (e: any) {
      setError(e?.message || (t('library.skillSaveFailed') || '保存失败'));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) requestClose(); }}
    >
      <div
        className="w-[640px] max-w-[92vw] max-h-[88vh] overflow-y-auto rounded-2xl border border-[#3a3a3c] bg-[#2c2c2e] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[#3a3a3c] px-6 py-4">
          <h2 className="text-[14px] font-semibold text-white">
            {isEdit ? (t('library.editSkill') || '编辑 Skill') : (t('library.createCustomSkill') || '新建自定义 Skill')}
          </h2>
          <button onClick={requestClose} className="rounded-md p-1 text-[#98989d] transition-colors hover:bg-[#3a3a3c] hover:text-white">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-[#ff453a]/40 bg-[#ff453a]/10 px-3 py-2 text-[12px] text-[#ff6961]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-[#98989d]">{t('library.name') || '名称'}</label>
            <input
              ref={nameRef}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('library.skillNamePlaceholder') || 'my-custom-skill'}
              className="w-full rounded-lg border border-[#3a3a3c] bg-[#1c1c1e] px-3 py-2 text-[13px] text-white outline-none transition-colors focus:border-[#0a84ff]"
            />
            <p className="mt-1 text-[11px] text-[#636366]">{t('library.skillNameHint') || '仅允许字母、数字、点、中划线、下划线，将作为目录名'}</p>
          </div>

          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-[#98989d]">{t('library.description') || '描述'}</label>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('library.skillDescPlaceholder') || '一句话描述这个 Skill 的用途'}
              className="w-full rounded-lg border border-[#3a3a3c] bg-[#1c1c1e] px-3 py-2 text-[13px] text-white outline-none transition-colors focus:border-[#0a84ff]"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-[#98989d]">SKILL.md {t('library.content') || '正文'}</label>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={10}
              placeholder={t('library.skillBodyPlaceholder') || '描述 Skill 的用途、使用场景与示例……'}
              className="w-full resize-y rounded-lg border border-[#3a3a3c] bg-[#1c1c1e] px-3 py-2 font-mono text-[12px] leading-relaxed text-white outline-none transition-colors focus:border-[#0a84ff]"
            />
          </div>

          <div>
            <label className="mb-2 block text-[12px] font-medium text-[#98989d]">{t('library.targetClients') || '目标客户端'}</label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {skillClients.map(client => {
                const checked = selectedClients.includes(client.id as SkillClientType);
                return (
                  <button
                    key={client.id}
                    type="button"
                    onClick={() => toggleClient(client.id as SkillClientType)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] transition-colors ${
                      checked
                        ? 'border-[#0a84ff] bg-[#0a84ff]/15 text-white'
                        : 'border-[#3a3a3c] bg-[#1c1c1e] text-[#98989d] hover:border-[#636366]'
                    }`}
                  >
                    <span
                      className={`flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border ${
                        checked ? 'border-[#0a84ff] bg-[#0a84ff]' : 'border-[#636366]'
                      }`}
                    >
                      {checked && (
                        <svg width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M1 5l3 3 5-6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      )}
                    </span>
                    <ClientIcon clientId={client.id} size={14} />
                    {client.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-[#3a3a3c] px-6 py-4">
          <button
            onClick={requestClose}
            className="rounded-lg border border-[#3a3a3c] px-4 py-2 text-[13px] text-[#98989d] transition-colors hover:bg-[#3a3a3c] hover:text-white"
          >
            {t('common.cancel') || '取消'}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-2 rounded-lg bg-[#0a84ff] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#0a84ff]/85 disabled:opacity-50"
          >
            {submitting && (
              <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            )}
            {isEdit ? (t('common.save') || '保存') : (t('library.create') || '创建')}
          </button>
        </div>
      </div>

      {confirmDiscard && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
          onClick={e => { if (e.target === e.currentTarget) setConfirmDiscard(false); }}
        >
          <div className="w-[380px] max-w-[88vw] rounded-2xl border border-[#3a3a3c] bg-[#2c2c2e] p-5 shadow-2xl">
            <h3 className="text-[14px] font-semibold text-white">{t('library.discardTitle') || '放弃编辑内容？'}</h3>
            <p className="mt-2 text-[12px] leading-relaxed text-[#98989d]">{t('library.discardHint') || '您已修改内容但尚未保存，关闭后将丢失这些改动。'}</p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setConfirmDiscard(false)}
                className="rounded-lg border border-[#3a3a3c] px-4 py-2 text-[13px] text-[#98989d] transition-colors hover:bg-[#3a3a3c] hover:text-white"
              >
                {t('library.keepEditing') || '继续编辑'}
              </button>
              <button
                onClick={() => { setConfirmDiscard(false); onClose(); }}
                className="rounded-lg bg-[#ff453a] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#ff453a]/85"
              >
                {t('library.discardChanges') || '放弃'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
