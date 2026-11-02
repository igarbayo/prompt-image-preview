import type { ClientModule } from 'claude-code'

type Badge = { radius: number; inset: number }
type Props = { n: number; columns?: number; rows?: number; badge?: Badge }

// The region is the picture (columns by rows) with a transparent margin of one
// column on its right and one row above it. x and y count from the region's
// top left corner, so the picture's top edge is at y = 1.

// Whether a click lands on the close badge, centred on the picture's top edge
// `inset` columns in from its right edge. A cell is about twice as tall as it
// is wide, so a row counts as two columns.
export function isCloseHit(x: number, y: number, columns: number, badge: Badge): boolean {
  const cx = columns - badge.inset
  const cy = 1
  return Math.hypot(x - cx, (y - cy) * 2) <= badge.radius + 0.5
}

export function isOnPicture(x: number, y: number, columns: number): boolean {
  return x < columns && y >= 1
}

const Click: ClientModule<Props> = (props, surface) => {
  surface.onPointer(event => {
    if (event.type !== 'up' || event.button !== 'left') {
      return
    }
    const x = event.fine?.x ?? event.x + 0.5
    const y = event.fine?.y ?? event.y + 0.5
    if (props.badge && props.columns && isCloseHit(x, y, props.columns, props.badge)) {
      surface.post({ n: props.n, action: 'remove' })
    } else if (!props.columns || isOnPicture(x, y, props.columns)) {
      surface.post({ n: props.n, action: 'open' })
    }
  })
  return surface.elements.Box({})
}

export default Click
