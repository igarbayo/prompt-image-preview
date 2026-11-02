import { atom, read, update } from 'claude-code'
import type { EngineInterface as Api, Register } from 'claude-code'

import type { CapturedImage } from '../types'

const images = atom({ plugin: 'prompt-image-preview', key: 'images' } as const, [])

const PLACEHOLDER = /\[Image #(\d+)\]/g
const COLUMNS = 18
const MAX_ROWS = 7
// The close badge sits on the thumbnail's top edge, half over the picture and
// half over a transparent margin of one column on the right and one row on top.
// Its radius, and how far its centre stands in from the right edge, in columns.
// click.tsx hit-tests the same shape.
const BADGE_GEOMETRY = { radius: 1.25, inset: 0.6 }
const IMAGE_TERMINALS = ['ghostty', 'kitty', 'WezTerm']

const CAPTURE = `
function run(argv) {
  ObjC.import('AppKit')
  const pb = $.NSPasteboard.generalPasteboard
  let data = pb.dataForType('public.png')
  if (data.isNil()) {
    const tiff = pb.dataForType('public.tiff')
    if (tiff.isNil()) return 'none'
    data = $.NSBitmapImageRep.imageRepWithData(tiff)
      .representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}))
  }
  data.writeToFileAtomically(argv[0], true)
  const rep = $.NSBitmapImageRep.imageRepWithData(data)
  return rep.pixelsWide + 'x' + rep.pixelsHigh
}
`

const BADGE = `
function run(argv) {
  ObjC.import('AppKit')
  const [path, columns, rows, radius, inset] = [argv[0], ...argv.slice(1).map(Number)]
  const src = $.NSBitmapImageRep.imageRepWithData($.NSData.dataWithContentsOfFile(path))
  if (src.isNil()) return 'none'
  const w = Number(src.pixelsWide)
  const h = Number(src.pixelsHigh)
  const col = w / columns
  const row = h / rows
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, Math.round(w + col), Math.round(h + row), 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0)
  $.NSGraphicsContext.saveGraphicsState
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep))
  src.drawInRect($.NSMakeRect(0, 0, w, h))
  const rx = radius * col
  const ry = (radius / 2) * row
  const cx = w - inset * col
  const cy = h
  $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0, 0, 0, 0.85).setFill
  $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(cx - rx, cy - ry, 2 * rx, 2 * ry)).fill
  const x = $.NSBezierPath.bezierPath
  x.moveToPoint($.NSMakePoint(cx - rx * 0.42, cy - ry * 0.42))
  x.lineToPoint($.NSMakePoint(cx + rx * 0.42, cy + ry * 0.42))
  x.moveToPoint($.NSMakePoint(cx - rx * 0.42, cy + ry * 0.42))
  x.lineToPoint($.NSMakePoint(cx + rx * 0.42, cy - ry * 0.42))
  x.setLineWidth(Math.max(1.5, Math.min(rx, ry) * 0.22))
  x.setLineCapStyle($.NSLineCapStyleRound)
  $.NSColor.whiteColor.setStroke
  x.stroke
  $.NSGraphicsContext.restoreGraphicsState
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(path, true)
  return 'ok'
}
`

let canDrawImages = false
let bandRequestId: string | null = null
let frame = 0
let lastRefresh = 0
const thumbnails = new Map<string, [string, string]>()
const pending = new Set<number>()

export function placeholders(text: string): number[] {
  return [...text.matchAll(PLACEHOLDER)].map(match => Number(match[1]))
}

export function withoutPlaceholder(text: string, cursor: number, n: number): { text: string; cursor: number } {
  const token = `[Image #${n}]`
  let start = text.indexOf(token)
  if (start === -1) {
    return { text, cursor }
  }
  let end = start + token.length
  if (text[end] === ' ') {
    end += 1
  } else if (start > 0 && text[start - 1] === ' ') {
    start -= 1
  }
  const removed = end - start
  const moved = cursor >= end ? cursor - removed : cursor > start ? start : cursor
  return { text: text.slice(0, start) + text.slice(end), cursor: moved }
}

export function rowsFor(image: CapturedImage): number {
  if (!image.width || !image.height) {
    return 3
  }
  return Math.min(MAX_ROWS, Math.max(2, Math.round((COLUMNS * image.height) / image.width / 2)))
}

async function cacheDir($: Api): Promise<string> {
  const home = await $.env.get('HOME')
  return `${home}/Library/Caches/claude-prompt-image-preview/${$.session.id()}`
}

async function thumbnail($: Api, path: string, size: number, rows: number): Promise<string | null> {
  const out = `${path}.${size}.png`
  const { exitCode } = await $.process.run(['sips', '-Z', String(size), path, '--out', out])
  if (exitCode !== 0) {
    return null
  }
  await $.process.run([
    'osascript', '-l', 'JavaScript', '-e', BADGE, out,
    String(COLUMNS), String(rows), String(BADGE_GEOMETRY.radius), String(BADGE_GEOMETRY.inset),
  ])
  const { base64 } = await $.fs.read(out, { as: 'bytes' })
  return base64
}

async function variantsFor($: Api, path: string): Promise<[string, string] | undefined> {
  const cached = thumbnails.get(path)
  if (cached) {
    return cached
  }
  try {
    const even = await $.fs.read(`${path}.256.png`, { as: 'bytes' })
    const odd = await $.fs.read(`${path}.255.png`, { as: 'bytes' })
    const loaded: [string, string] = [even.base64, odd.base64]
    thumbnails.set(path, loaded)
    return loaded
  } catch {
    return undefined
  }
}

async function capture($: Api, n: number): Promise<CapturedImage> {
  const dir = await cacheDir($)
  const path = `${dir}/${n}.png`
  await $.process.run(['mkdir', '-p', dir])
  const { exitCode, stdout } = await $.process.run(['osascript', '-l', 'JavaScript', '-e', CAPTURE, path])
  const size = /^(\d+)x(\d+)/.exec(stdout.trim())
  if (exitCode !== 0 || !size) {
    return { n, path: null, width: 0, height: 0 }
  }
  const image = { n, path, width: Number(size[1]), height: Number(size[2]) }
  const rows = rowsFor(image)
  const even = await thumbnail($, path, 256, rows)
  const odd = await thumbnail($, path, 255, rows)
  if (even && odd) {
    thumbnails.set(path, [even, odd])
  }
  return image
}

async function sync($: Api, text: string) {
  const present = placeholders(text)
  await update($, images, list => list.filter(image => present.includes(image.n)))
  const known = (await read($, images)).map(image => image.n)
  for (const n of present) {
    if (known.includes(n) || pending.has(n)) {
      continue
    }
    pending.add(n)
    try {
      const image = await capture($, n)
      await update($, images, list =>
        [...list.filter(one => one.n !== n), image].sort((a, b) => a.n - b.n),
      )
    } finally {
      pending.delete(n)
    }
  }
}

async function open($: Api, n: number) {
  const image = (await read($, images)).find(one => one.n === n)
  if (image?.path) {
    await $.process.run(['open', image.path])
  }
}

async function remove($: Api, n: number) {
  const box = await $.prompt.read()
  const next = withoutPlaceholder(box.text, box.cursor, n)
  if (next.text !== box.text) {
    const { isFilled } = await $.prompt.fill({ text: next.text, mode: 'replace', cursor: next.cursor })
    if (!isFilled) {
      return
    }
  }
  await update($, images, list => list.filter(one => one.n !== n))
}

async function refresh($: Api) {
  if (!canDrawImages || bandRequestId === null) {
    return
  }
  frame += 1
  for (const image of await read($, images)) {
    const variants = image.path ? await variantsFor($, image.path) : undefined
    if (!variants) {
      continue
    }
    await $.ui.blit({
      requestId: bandRequestId,
      key: `img${image.n}`,
      source: { png: frame % 2 === 0 ? variants[0] : variants[1] },
    })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const forced = await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')
    const terminal = await $.env.get('TERM_PROGRAM')
    canDrawImages = Boolean(forced && forced !== '0') || IMAGE_TERMINALS.includes(terminal ?? '')
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const result = await next(e)
    void $.prompt
      .read()
      .then(({ text }) => sync($, text))
      .catch(() => undefined)
    const now = await $.clock.now()
    if (now - lastRefresh > 1000) {
      lastRefresh = now
      void refresh($).catch(() => undefined)
    }
    return result
  })

  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    void sync($, e.text).catch(() => undefined)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    await update($, images, () => []).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    await $.process.run(['rm', '-rf', await cacheDir($)])
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    const data = e.data as { n?: unknown; action?: unknown }
    if (e.module.endsWith('click.tsx') && typeof data?.n === 'number') {
      await (data.action === 'remove' ? remove($, data.n) : open($, data.n))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, images)
    if (e.props.hasSurvey || list.length === 0) {
      bandRequestId = null
      return next(e)
    }
    bandRequestId = e.requestId
    for (const image of list) {
      if (image.path) {
        await variantsFor($, image.path)
      }
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const terminal = e.surface === 'terminal' ? $.ui.resolve(e) : null
    const drawsImages = canDrawImages && terminal !== null

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {list.map(image => {
          const variants = image.path ? thumbnails.get(image.path) : undefined
          if (drawsImages && terminal && variants) {
            const rows = rowsFor(image)
            const { Client, Image } = terminal
            return (
              <Box key={`item${image.n}`} flexDirection="column">
                <Box position="relative" width={COLUMNS + 1} height={rows + 1}>
                  <Image
                    key={`img${image.n}`}
                    source={{ png: frame % 2 === 0 ? variants[0] : variants[1] }}
                    columns={COLUMNS + 1}
                    rows={rows + 1}
                    alt={`Image #${image.n}`}
                  />
                  <Box position="absolute" top={0} left={0} width={COLUMNS + 1} height={rows + 1}>
                    <Client
                      key={`click${image.n}`}
                      module="./click.tsx"
                      props={{ n: image.n, columns: COLUMNS, rows, badge: BADGE_GEOMETRY }}
                      width={COLUMNS + 1}
                      height={rows + 1}
                    />
                  </Box>
                </Box>
                <Text dimColor>#{image.n}</Text>
              </Box>
            )
          }
          return (
            <Box key={`item${image.n}`} flexDirection="row" columnGap={1}>
              {image.path ? (
                <Button
                  key={`open${image.n}`}
                  plain
                  dimColor
                  label={`Image #${image.n} ${image.width}x${image.height}`}
                  onPress={() => void open($, image.n)}
                />
              ) : (
                <Text key={`missing${image.n}`} dimColor>
                  Image #{image.n} (not captured)
                </Text>
              )}
              <Button key={`remove${image.n}`} plain dimColor label="✕" onPress={() => void remove($, image.n)} />
            </Box>
          )
        })}
      </Box>
    )
  })
}
