import { useState } from 'react'
import { ArrowRight, Check, Files, LockKeyhole, Scissors } from 'lucide-react'
import MergeWorkspace from '../features/merge/MergeWorkspace'
import SplitWorkspace from '../features/split/SplitWorkspace'

type Tool = 'merge' | 'split'

export default function App() {
  const [tool, setTool] = useState<Tool>('merge')

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand" aria-label="PDF Forge"><div className="brand-mark"><span /></div><span>PDF Forge</span></div>
        <div className="header-right"><span className="header-caption">PDF 工作台</span><span className="header-privacy"><LockKeyhole size={14} /> 本機處理・無需上傳</span></div>
      </header>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <div className="hero-kicker"><span className="kicker-line" /> YOUR PDF, YOUR WAY</div>
            <h1>PDF 整理，<br /><em>剛剛好。</em></h1>
            <p>合併需要的，拆出想留下的。<br />簡單幾步，讓檔案回到你的節奏。</p>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-orbit art-orbit--one" />
            <div className="art-orbit art-orbit--two" />
            <div className="art-sheet art-sheet--back"><span /><span /><span /></div>
            <div className="art-sheet art-sheet--middle"><span /><span /><span /></div>
            <div className="art-sheet art-sheet--front"><div className="art-pdf">PDF</div><span /><span /><span /></div>
            <div className="art-spark art-spark--one">✳</div><div className="art-spark art-spark--two">✳</div>
          </div>
        </section>

        <nav className="tool-nav" aria-label="PDF 工具">
          <button className={tool === 'merge' ? 'tool-tab active' : 'tool-tab'} onClick={() => setTool('merge')} aria-current={tool === 'merge' ? 'page' : undefined}>
            <div className="tool-tab-icon"><Files size={20} strokeWidth={1.8} /></div>
            <span><strong>合併 PDF</strong><small>把多份整理成一份</small></span>
            <ArrowRight size={18} className="tool-tab-arrow" />
          </button>
          <button className={tool === 'split' ? 'tool-tab active' : 'tool-tab'} onClick={() => setTool('split')} aria-current={tool === 'split' ? 'page' : undefined}>
            <div className="tool-tab-icon"><Scissors size={20} strokeWidth={1.8} /></div>
            <span><strong>拆分 PDF</strong><small>取出真正需要的頁面</small></span>
            <ArrowRight size={18} className="tool-tab-arrow" />
          </button>
        </nav>
        <div className="workspace" key={tool}>{tool === 'merge' ? <MergeWorkspace /> : <SplitWorkspace />}</div>
      </main>
      <footer className="site-footer"><span>PDF Forge / 在瀏覽器裡，安心整理 PDF。</span><span>MADE FOR THE LITTLE DETAILS <Check size={14} /></span></footer>
    </div>
  )
}
