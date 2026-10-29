import type { ClientModule } from 'claude-code'

const Click: ClientModule<{ n: number }> = (props, surface) => {
  surface.onPointer(event => {
    if (event.type === 'up' && event.button === 'left') {
      surface.post({ n: props.n })
    }
  })
  return surface.elements.Box({})
}

export default Click
