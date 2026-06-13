// 引擎配置编辑器:薄封装 PresetEditor —— 提供 engineSchema 字段 + useEngineConfigs 动作。
// 每个引擎各存各的配置,可多套命名预设。
import { ENGINE_FIELDS, engineDefaults, type EngineKey } from '../../lib/engineSchema';
import { useEngineConfigs } from './useEngineConfigs';
import PresetEditor, { type PresetActions } from './PresetEditor';

export default function EngineConfigEditor({ engine }: { engine: EngineKey }) {
  const { data, save, del, active } = useEngineConfigs();
  const group = data?.engines?.[engine];

  const actions: PresetActions = {
    switchActive: (id) => active.mutate({ engine, id }),
    save: (args, onSuccess) => save.mutate({ engine, ...args }, { onSuccess }),
    remove: (id, onSuccess) => del.mutate({ engine, id }, { onSuccess }),
  };

  return (
    <PresetEditor
      group={group} fields={ENGINE_FIELDS[engine]} defaults={engineDefaults(engine)} actions={actions} resetKey={engine}
      presetLabel="引擎配置" newName="新配置"
      emptyHint="本引擎无可调参数,使用内置默认。"
    />
  );
}
