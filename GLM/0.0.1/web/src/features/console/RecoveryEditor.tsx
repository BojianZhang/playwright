// 失败恢复策略编辑器:薄封装 PresetEditor —— 提供 recoverySchema 字段 + useRecovery 动作(单一全局命名空间)。
import { RECOVERY_FIELDS, recoveryDefaults } from '../../lib/recoverySchema';
import { useRecovery } from './useRecovery';
import PresetEditor, { type PresetActions } from './PresetEditor';

export default function RecoveryEditor() {
  const { data, save, del, active } = useRecovery();
  const group = data?.recovery;

  const actions: PresetActions = {
    switchActive: (id) => active.mutate({ id }),
    save: (args, onSuccess) => save.mutate({ ...args }, { onSuccess }),
    remove: (id, onSuccess) => del.mutate({ id }, { onSuccess }),
  };

  return (
    <PresetEditor
      group={group} fields={RECOVERY_FIELDS} defaults={recoveryDefaults()} actions={actions} resetKey="recovery"
      presetLabel="恢复预设" newName="新恢复策略"
      emptyHint="无可调参数。"
    />
  );
}
