import { useShallow } from 'zustand/react/shallow'
import type { DocumentClose } from '../hooks/useDocumentClose'
import { orderedDocuments, useDocumentStore } from '../stores/documentStore'
import { TabStrip } from './TabStrip'

interface DocumentTabsProps {
  onClose: DocumentClose['requestTabClose']
  onCloseMany: DocumentClose['requestCloseMany']
}

export function DocumentTabs({ onClose, onCloseMany }: DocumentTabsProps) {
  const documents = useDocumentStore(useShallow(orderedDocuments))
  const activeId = useDocumentStore((state) => state.activeId)
  const setActive = useDocumentStore((state) => state.setActive)
  return (
    <TabStrip
      documents={documents}
      activeId={activeId}
      onActivate={setActive}
      onClose={onClose}
      onCloseMany={onCloseMany}
    />
  )
}
