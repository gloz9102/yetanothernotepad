import { useRef, useState } from 'react'
import { DocumentTasks } from '../lib/documentTasks'

/** Shared gates and queue for native events, saves, recovery, and exit. */
export function useDocumentRuntime() {
  const [tasks] = useState(() => new DocumentTasks())
  const processingRef = useRef(false)
  const closingRef = useRef(false)
  const exitPromptRef = useRef(false)
  const [runtime] = useState(() => ({
    tasks,
    processingRef,
    closingRef,
    exitPromptRef,
  }))
  return runtime
}

export type DocumentRuntime = ReturnType<typeof useDocumentRuntime>
