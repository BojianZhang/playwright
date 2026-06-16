// 向导第 4 步:回显模板(运行结束后每个账号输出一行的格式)。
import { Icon } from '../../lib/icons';
import { useConsole } from './ConsoleStateContext';

export default function StepEcho() {
  const c = useConsole();
  return (
    <section className="card echo-band">
      <div className="eb-top"><span className="idx c-green">4</span><h3>回显模板</h3><span className="head-hint">运行结束后每个账号输出一行,点「编辑格式」可插变量、调分隔符并实时预览</span></div>
      <div className="eb-grid">
        <div className="eb-col">
          <div className="io-head" style={{ marginBottom: 8 }}><span className="io-title ok"><Icon name="okcircle" size={14} />成功回显</span><button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => c.setEchoModal('success')}><Icon name="edit" size={14} />编辑格式</button></div>
          <textarea value={c.tplOk} spellCheck={false} style={{ minHeight: 100 }} onChange={(e) => c.setTplOk(e.target.value)} />
        </div>
        <div className="eb-col">
          <div className="io-head" style={{ marginBottom: 8 }}><span className="io-title fail"><Icon name="xcircle" size={14} />失败回显</span><button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => c.setEchoModal('fail')}><Icon name="edit" size={14} />编辑格式</button></div>
          <textarea value={c.tplFail} spellCheck={false} style={{ minHeight: 100 }} onChange={(e) => c.setTplFail(e.target.value)} />
        </div>
      </div>
    </section>
  );
}
