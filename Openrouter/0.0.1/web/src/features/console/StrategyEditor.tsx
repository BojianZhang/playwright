// 环节命名策略编辑器:薄封装 PresetEditor —— 提供 strategySchema 字段(按引擎过滤)+ useStrategies 动作。
import { STRATEGY_SCHEMA, stageDefaults, type PresetStage, type EngineKey } from '../../lib/strategySchema';
import { useStrategies } from './useStrategies';
import PresetEditor, { type PresetActions } from './PresetEditor';

export default function StrategyEditor({ stage, engine }: { stage: PresetStage; engine: EngineKey }) {
  const { data, save, del, active } = useStrategies();
  const group = data?.stages?.[stage];
  const fields = STRATEGY_SCHEMA[stage].filter((f) => !f.engines || f.engines.includes(engine));

  const actions: PresetActions = {
    switchActive: (id) => active.mutate({ stage, id }),
    save: (args, onSuccess) => save.mutate({ stage, ...args }, { onSuccess }),
    remove: (id, onSuccess) => del.mutate({ stage, id }, { onSuccess }),
  };

  return (
    <PresetEditor
      group={group} fields={fields} defaults={stageDefaults(stage)} actions={actions} resetKey={stage}
      presetLabel="策略预设" newName="新策略"
      emptyHint="本环节在当前引擎下无可调参数,使用内置默认。"
    />
  );
}
