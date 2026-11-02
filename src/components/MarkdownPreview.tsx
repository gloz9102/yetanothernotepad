import {
  memo,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { documentApi } from '../lib/api'
import { useEditorStatusStore } from '../stores/editorStatusStore'
import type { LineRange } from '../types'

interface MarkdownPreviewProps {
  documentId: string
  content: string
  onError?: (error: unknown) => void
  /** Links preview blocks and editor lines both ways when provided. */
  onSourceLinesSelect?: (range: LineRange | null) => void
}

interface LocalImageProps {
  documentId: string
  src?: string
  alt?: string
}

function isRemoteUrl(value: string) {
  return /^(?:https?:)?\/\//i.test(value)
}

function LocalImage({ documentId, src, alt }: LocalImageProps) {
  const { t } = useTranslation()
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDataUrl(null)
    setFailed(false)
    if (!src || isRemoteUrl(src) || /^(?:data|javascript):/i.test(src)) {
      return
    }

    let relativePath: string
    try {
      relativePath = decodeURI(src)
    } catch {
      setFailed(true)
      return
    }

    void documentApi
      .readLocalAsset(documentId, relativePath)
      .then((asset) => {
        if (!cancelled) setDataUrl(asset.dataUrl)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [documentId, src])

  if (!src || isRemoteUrl(src) || /^(?:data|javascript):/i.test(src)) {
    return <span className="image-placeholder">{t('remoteImageBlocked')}</span>
  }
  if (failed) {
    return <span className="image-placeholder">{t('localImageError')}</span>
  }
  if (!dataUrl) {
    return <span className="image-placeholder">{alt ?? '…'}</span>
  }
  return <img src={dataUrl} alt={alt ?? ''} />
}

function safeUrlTransform(url: string, key: string) {
  if (key === 'src') {
    return isRemoteUrl(url) || /^(?:data|javascript):/i.test(url)
      ? ''
      : defaultUrlTransform(url)
  }
  if (/^(?:https?:|mailto:|#)/i.test(url)) return url
  return ''
}

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    h1: [...(defaultSchema.attributes?.h1 ?? []), 'id'],
    h2: [...(defaultSchema.attributes?.h2 ?? []), 'id'],
    h3: [...(defaultSchema.attributes?.h3 ?? []), 'id'],
    h4: [...(defaultSchema.attributes?.h4 ?? []), 'id'],
    h5: [...(defaultSchema.attributes?.h5 ?? []), 'id'],
    h6: [...(defaultSchema.attributes?.h6 ?? []), 'id'],
  },
}

interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  position?: { start: { line: number }; end: { line: number } }
  children?: HastNode[]
}

const SOURCE_BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'tr',
  'hr',
  'li',
])

// Tags the innermost rendered blocks with their source line range. Loose list
// items are skipped because their paragraphs are tagged, and a tight item
// stops before its nested list so the parent does not cover child lines.
function tagSourceLines(node: HastNode) {
  for (const child of node.children ?? []) tagSourceLines(child)
  if (node.type !== 'element' || !SOURCE_BLOCK_TAGS.has(node.tagName ?? '')) {
    return
  }
  if (!node.position || !node.properties) return
  const first = node.position.start.line
  let last = node.position.end.line
  if (node.tagName === 'li') {
    const children = node.children ?? []
    if (children.some((child) => child.tagName === 'p')) return
    const nested = children.find(
      (child) => child.tagName === 'ul' || child.tagName === 'ol',
    )
    if (nested?.position) last = nested.position.start.line - 1
  }
  node.properties.dataSourceStart = first
  node.properties.dataSourceEnd = Math.max(first, last)
}

function rehypeSourceLines() {
  return tagSourceLines
}

const SOURCE_BLOCK_SELECTOR = '[data-source-start]'

function sourceRange(element: Element): LineRange {
  const block = element as HTMLElement
  return {
    first: Number(block.dataset.sourceStart),
    last: Number(block.dataset.sourceEnd),
  }
}

// Source lines of the preview blocks touched by the current DOM selection.
function selectedSourceLines(article: HTMLElement): LineRange | null {
  const selection = article.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const common = range.commonAncestorContainer
  if (!article.contains(common)) return null
  // Blocks that merely wrap the selection are skipped in favour of the
  // innermost block containing it.
  let blocks = [...article.querySelectorAll(SOURCE_BLOCK_SELECTOR)].filter(
    (block) => range.intersectsNode(block) && !block.contains(common),
  )
  if (blocks.length === 0) {
    const element = common instanceof Element ? common : common.parentElement
    const block = element?.closest(SOURCE_BLOCK_SELECTOR)
    blocks = block && article.contains(block) ? [block] : []
  }
  if (blocks.length === 0) return null
  const ranges = blocks.map(sourceRange)
  return {
    first: Math.min(...ranges.map((item) => item.first)),
    last: Math.max(...ranges.map((item) => item.last)),
  }
}

// Kept separate from the preview so cursor moves do not re-render the
// Markdown tree.
function SourceLineHighlighter({
  documentId,
  content,
  articleRef,
}: {
  documentId: string
  content: string
  articleRef: RefObject<HTMLElement | null>
}) {
  const ranges = useEditorStatusStore(
    (state) => state.byDocumentId[documentId]?.selectedLines,
  )
  useEffect(() => {
    const blocks = [
      ...(articleRef.current?.querySelectorAll(SOURCE_BLOCK_SELECTOR) ?? []),
    ]
    for (const block of blocks) {
      const { first, last } = sourceRange(block)
      block.classList.toggle(
        'source-linked',
        ranges?.some((range) => range.first <= last && range.last >= first) ??
          false,
      )
    }
    return () => {
      for (const block of blocks) block.classList.remove('source-linked')
    }
  }, [articleRef, content, ranges])
  return null
}

function MarkdownPreviewComponent({
  documentId,
  content,
  onError,
  onSourceLinesSelect,
}: MarkdownPreviewProps) {
  const { t } = useTranslation()
  const articleRef = useRef<HTMLElement>(null)
  const deferredContent = useDeferredValue(content)

  const handleLink = (event: MouseEvent<HTMLAnchorElement>, href?: string) => {
    event.preventDefault()
    if (href && /^(?:https?:|mailto:)/i.test(href)) {
      void Promise.resolve(openUrl(href)).catch((error: unknown) =>
        onError?.(error),
      )
    } else if (href?.startsWith('#')) {
      let id: string
      try {
        id = decodeURIComponent(href.slice(1))
      } catch {
        return
      }
      const target =
        document.getElementById(id) ??
        document.getElementById(`user-content-${id}`)
      if (target && articleRef.current?.contains(target)) {
        target.scrollIntoView({ block: 'start' })
      }
    }
  }

  if (!deferredContent.trim()) {
    return <div className="preview-empty">{t('previewEmpty')}</div>
  }

  return (
    <article
      className="markdown-preview"
      data-testid="markdown-preview"
      ref={articleRef}
      onMouseUp={
        onSourceLinesSelect &&
        (() => {
          if (articleRef.current) {
            onSourceLinesSelect(selectedSourceLines(articleRef.current))
          }
        })
      }
    >
      {onSourceLinesSelect && (
        <SourceLineHighlighter
          documentId={documentId}
          content={deferredContent}
          articleRef={articleRef}
        />
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeSlug,
          [rehypeSanitize, sanitizeSchema],
          rehypeSourceLines,
        ]}
        skipHtml
        urlTransform={safeUrlTransform}
        components={{
          a: ({ href, children }) => (
            <a href={href} onClick={(event) => handleLink(event, href)}>
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <LocalImage documentId={documentId} src={src} alt={alt} />
          ),
        }}
      >
        {deferredContent}
      </ReactMarkdown>
    </article>
  )
}

export const MarkdownPreview = memo(MarkdownPreviewComponent)
