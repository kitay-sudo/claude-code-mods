// One shared block above the prompt for cache-timer, server-panel, spend-meter
// and quick-steps, laid out in lines: the session's state first (the cache on
// the left, the spend on the right), the server below it, then what comes
// next (suggestions). Whichever plugin draws first builds the block around what
// lies beneath; each of the others adds its segment to its line, and segments
// keep a fixed order by their keys. The same file is copied into each plugin.

import type { RenderElement, RenderNode } from 'claude-code'

export type Line = 'status' | 'server' | 'next'

const BAND = 'status-band'
const LINES: readonly Line[] = ['status', 'server', 'next']

// The status line puts its last segment (the spend) at the right edge; the
// server and the suggestions each keep a blank row above them.
const LINE_PROPS: Record<Line, Record<string, unknown>> = {
  status: { justifyContent: 'space-between' },
  server: { marginTop: 1 },
  next: { marginTop: 1 },
}

type Tree = { type?: unknown; props?: { key?: unknown }; children?: unknown[] }
type BoxTag = (props: never) => RenderNode | null | undefined

function keyOf(node: unknown): string {
  const key = (node as Tree | null)?.props?.key
  return typeof key === 'string' ? key : ''
}

function lineOf(node: unknown): Line | undefined {
  return LINES.find(line => keyOf(node) === `line-${line}`)
}

/** What lies beneath with this plugin's segment added to its line of the shared block. */
export function joinRow(below: RenderElement, segment: RenderElement, Box: BoxTag, line: Line): RenderElement {
  const band = below as unknown as Tree
  const isBand = band.type === 'Box' && keyOf(band) === BAND && Array.isArray(band.children)
  const children = isBand ? (band.children ?? []) : [below]
  const beneath = children.filter(child => lineOf(child) === undefined)
  const segments: Record<Line, unknown[]> = { status: [], server: [], next: [] }
  for (const child of children) {
    const at = lineOf(child)
    if (at !== undefined) segments[at].push(...((child as Tree).children ?? []))
  }
  segments[line] = [...segments[line], segment].sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
  const rows = LINES.filter(one => segments[one].length > 0).map(one =>
    h(Box, { key: `line-${one}`, flexWrap: 'wrap', columnGap: 4, ...LINE_PROPS[one] }, ...segments[one]),
  )
  return h(Box, { key: BAND, flexDirection: 'column' }, ...beneath, ...rows) as RenderElement
}
