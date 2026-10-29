import { atom, read, update } from 'claude-code'
import type { EngineInterface as Api, Register } from 'claude-code'

import type { CapturedImage } from '../types'

const images = atom({ plugin: 'prompt-image-preview', key: 'images' } as const, [])

const PLACEHOLDER = /\[Image #(\d+)\]/g
const COLUMNS = 18
const MAX_ROWS = 7
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

let canDrawImages = false
let bandRequestId: string | null = null
let frame = 0
let lastRefresh = 0
const thumbnails = new Map<string, [string, string]>()
const pending = new Set<number>()

export function placeholders(text: string): number[] {
  return [...text.matchAll(PLACEHOLDER)].map(match => Number(match[1]))
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

async function thumbnail($: Api, path: string, size: number): Promise<string | null> {
  const out = `${path}.${size}.png`
  const { exitCode } = await $.process.run(['sips', '-Z', String(size), path, '--out', out])
  if (exitCode !== 0) {
    return null
  }
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
  const even = await thumbnail($, path, 256)
  const odd = await thumbnail($, path, 255)
  if (even && odd) {
    thumbnails.set(path, [even, odd])
  }
  return { n, path, width: Number(size[1]), height: Number(size[2]) }
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
    const data = e.data as { n?: unknown }
    if (e.module.endsWith('click.tsx') && typeof data?.n === 'number') {
      await open($, data.n)
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
                <Box position="relative" width={COLUMNS} height={rows}>
                  <Image
                    key={`img${image.n}`}
                    source={{ png: frame % 2 === 0 ? variants[0] : variants[1] }}
                    columns={COLUMNS}
                    rows={rows}
                    alt={`Image #${image.n}`}
                  />
                  <Box position="absolute" top={0} left={0} width={COLUMNS} height={rows}>
                    <Client key={`click${image.n}`} module="./click.tsx" props={{ n: image.n }} width={COLUMNS} height={rows} />
                  </Box>
                </Box>
                <Text dimColor>#{image.n}</Text>
              </Box>
            )
          }
          return image.path ? (
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
          )
        })}
      </Box>
    )
  })
}
