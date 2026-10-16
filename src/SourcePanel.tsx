import { useMemo, useState } from 'react'
import { FileCode2, Search, ChevronRight, ChevronDown, FolderClosed, Save, Loader2 } from 'lucide-react'
import { bridge } from './bridge'

/** A TypeScript source entry surfaced in the panel. */
export type TsFile = { path: string; additions?: number; deletions?: number; dirty?: boolean }

/**
 * TypeScript source panel.
 *
 * Replaces the previous "This session" stats column. In the packaged app the
 * tree is supplied by the main process (real filesystem reads via the bridge);
 * in browser preview it falls back to the files this session has touched, so the
 * panel is never a dead placeholder.
 */
export function SourcePanel({ files }: { files: TsFile[] }) {
  const [query, setQuery] = useState('')
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const native = Boolean(bridge())

  const tsFiles = useMemo(
    () => files.filter(f => /\.(ts|tsx|mts|cts)$/.test(f.path)),
    [files],
  )

  // Group by directory so the panel reads like a real source tree.
  const tree = useMemo(() => {
    const q = query.trim().toLowerCase()
    const groups = new Map<string, TsFile[]>()
    for (const file of tsFiles) {
      if (q && !file.path.toLowerCase().includes(q)) continue
      const cut = file.path.lastIndexOf('/')
      const dir = cut === -1 ? '.' : file.path.slice(0, cut)
      const list = groups.get(dir) ?? []
      list.push(file)
      groups.set(dir, list)
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [tsFiles, query])

  const open = async (path: string) => {
    setSelected(path)
    setError(null)
    const api = bridge()
    if (!api) {
      setContent(null)
      setError('Connect the Electron shell to read file contents.')
      return
    }
    setLoading(true)
    try {
      const result = await api.readSourceFile(path)
      if (result.ok && result.content !== undefined) setContent(result.content)
      else {
        setContent(null)
        setError(result.reason || 'Could not read this file.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <aside className="source-panel">
      <div className="panel-head">
        <div>
          <span className="panel-title">TypeScript sources</span>
          <span className="panel-subtitle">{tsFiles.length} files</span>
        </div>
        {!native && <span className="preview-chip">PREVIEW</span>}
      </div>

      <div className="source-search">
        <Search size={12} />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filter .ts / .tsx"
          spellCheck={false}
        />
      </div>

      <div className="source-tree">
        {tree.length === 0 && (
          <div className="empty-state compact">
            <FileCode2 size={18} />
            <span>No TypeScript files yet.</span>
            <small>Files appear here as the session touches them.</small>
          </div>
        )}
        {tree.map(([dir, entries]) => {
          const isOpen = openDirs[dir] ?? true
          return (
            <div className="source-group" key={dir}>
              <button
                className="source-dir"
                type="button"
                onClick={() => setOpenDirs(d => ({ ...d, [dir]: !isOpen }))}
              >
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <FolderClosed size={12} />
                <span>{dir}</span>
                <em>{entries.length}</em>
              </button>
              {isOpen &&
                entries.map(file => {
                  const name = file.path.slice(file.path.lastIndexOf('/') + 1)
                  return (
                    <button
                      key={file.path}
                      className={`source-file ${selected === file.path ? 'active' : ''}`}
                      type="button"
                      onClick={() => void open(file.path)}
                      title={file.path}
                    >
                      <FileCode2 size={12} />
                      <span>{name}</span>
                      {file.dirty && <i className="source-dirty" />}
                      {(file.additions || file.deletions) && (
                        <em className="source-diff">
                          +{file.additions ?? 0} −{file.deletions ?? 0}
                        </em>
                      )}
                    </button>
                  )
                })}
            </div>
          )
        })}
      </div>

      {selected && (
        <div className="source-viewer">
          <div className="source-viewer-head">
            <code>{selected}</code>
            {loading && <Loader2 size={11} className="spin" />}
          </div>
          {error ? (
            <p className="source-note">{error}</p>
          ) : content !== null ? (
            <>
              <pre>{content.split('\n').slice(0, 400).join('\n')}</pre>
              <button className="source-save" type="button" disabled title="Editing lands in phase 2">
                <Save size={11} /> Read-only preview
              </button>
            </>
          ) : (
            <p className="source-note">Select a file to load its contents.</p>
          )}
        </div>
      )}
    </aside>
  )
}
