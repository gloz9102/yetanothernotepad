import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type SelectionRange,
} from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { LineRange } from '../types'

// Line numbers covered by a selection range. A selection ending at the start
// of a line does not cover that line.
export function selectedLines(
  state: EditorState,
  range: SelectionRange,
): LineRange {
  const first = state.doc.lineAt(range.from).number
  const end = state.doc.lineAt(range.to)
  const last =
    end.number > first && end.from === range.to ? end.number - 1 : end.number
  return { first, last }
}

// Source lines picked in the split preview, highlighted in the editor until
// the editor selection or document changes.
export const setLinkedLines = StateEffect.define<LineRange | null>()

const linkedLineDecoration = Decoration.line({ class: 'cm-linkedLine' })

function linkedLineDecorations(state: EditorState, range: LineRange) {
  const builder = new RangeSetBuilder<Decoration>()
  const last = Math.min(range.last, state.doc.lines)
  for (let line = Math.max(range.first, 1); line <= last; line++) {
    const from = state.doc.line(line).from
    builder.add(from, from, linkedLineDecoration)
  }
  return builder.finish()
}

export const linkedLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setLinkedLines)) {
        return effect.value
          ? linkedLineDecorations(transaction.state, effect.value)
          : Decoration.none
      }
    }
    if (transaction.docChanged || transaction.selection) return Decoration.none
    return decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})
