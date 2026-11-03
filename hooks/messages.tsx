import { atom, read, update } from 'claude-code'
import type { EngineInterface as Api, On, PluginOptions, RenderElement } from 'claude-code'

import type { SentImage, SentMessage } from '../types'

// Images inside the conversation: under each message the person sent with
// images, and under each reply block, Read result or MCP result that carries
// or names one.

export const sent = atom({ plugin: 'prompt-image-preview', key: 'sent' } as const, [])

const MAX_COLUMNS = 64
const MAX_ROWS = 24
const MIN_ROWS = 4
// How big a picture is drawn, as a share of the size that fills the room above.
const SCALE = 0.6
// The longest side of the PNG the terminal gets, in pixels; a second, smaller
// try when the first is over the 2 MiB an Image takes as bytes.
const PIXELS = [1024, 768]
const MAX_PNG_BYTES = 2 * 1024 * 1024
const IMAGE_PATH = /(?:!\[[^\]]*\]\(\s*<?)?((?:~|\/)[^\s()<>"'`]*?\.(?:png|jpe?g|gif|webp|heic|tiff?|bmp))(?=[\s)>"'`.,;:!?]|$)/gi

export type Picture = { path: string; width: number; height: number; png: string }

let canDraw = false
let mode = 'all'
let cacheRoot: Promise<string> | null = null
let rebuilt = false
const pictures = new Map<string, Promise<Picture | null>>()
const claimed = new Map<string, number>()

// The text a message row and a submission share: the prompt without its
// [Image #N] markers, spaces collapsed, so the row matches whether or not it
// still shows the markers.
export function messageKey(text: string): string {
  return text.replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim()
}

// Absolute or home-relative paths of image files a reply names, in order, once
// each; a Markdown image's target counts too. URLs are left alone.
export function imagePaths(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(IMAGE_PATH)) {
    const start = match.index ?? 0
    const path = match[1]
    if (!path) {
      continue
    }
    const before = text.slice(Math.max(0, start - 3), start)
    if (path.startsWith('//') || /:\/?$/.test(before) || /[\w.-]$/.test(text.slice(0, start))) {
      continue
    }
    if (!found.includes(path)) {
      found.push(path)
    }
  }
  return found
}

// The cells a picture takes in the conversation: as wide as fits, up to 64
// columns, and as tall as its proportions ask, a cell being about twice as
// tall as it is wide.
export function messageSizeFor(
  image: { width: number; height: number },
  viewportColumns: number | undefined,
): { columns: number; rows: number } {
  const room = Math.max(16, Math.min(MAX_COLUMNS, (viewportColumns ?? 80) - 4))
  if (!image.width || !image.height) {
    return { columns: Math.round(room * SCALE), rows: Math.round(MIN_ROWS * 2 * SCALE) }
  }
  const ratio = image.height / image.width
  let columns = Math.min(room, Math.round(image.width / 8) || room)
  let rows = Math.round((columns * ratio) / 2)
  if (rows > MAX_ROWS) {
    rows = MAX_ROWS
    columns = Math.max(8, Math.round((MAX_ROWS * 2) / ratio))
  }
  rows = Math.max(MIN_ROWS, rows)
  return { columns: Math.max(5, Math.round(columns * SCALE)), rows: Math.max(3, Math.round(rows * SCALE)) }
}

// Which sent message a row draws: the first with the same text that no other
// row holds yet, so two equal prompts pair in order.
export function matchSent(list: SentMessage[], requestId: string, text: string, held: Map<string, number>): number {
  const own = held.get(requestId)
  if (own !== undefined && list[own] && messageKey(list[own].text) === messageKey(text)) {
    return own
  }
  const taken = new Set([...held.entries()].filter(([id]) => id !== requestId).map(([, index]) => index))
  const key = messageKey(text)
  const index = list.findIndex((one, i) => !taken.has(i) && messageKey(one.text) === key)
  if (index !== -1) {
    held.set(requestId, index)
  }
  return index
}

// Base64 blocks of image content anywhere in a tool's output: an MCP result's
// `{ type: 'image', data }` blocks, or a Read result's `{ type: 'image', file:
// { base64 } }`.
export function imageBlocks(output: unknown, depth = 0): string[] {
  if (depth > 4 || output === null || typeof output !== 'object') {
    return []
  }
  if (Array.isArray(output)) {
    return output.flatMap(item => imageBlocks(item, depth + 1))
  }
  const record = output as Record<string, unknown>
  if (record.type === 'image') {
    const file = record.file as Record<string, unknown> | undefined
    const source = record.source as Record<string, unknown> | undefined
    const data = record.data ?? file?.base64 ?? source?.data
    return typeof data === 'string' && data.length > 0 ? [data] : []
  }
  return Object.values(record).flatMap(value => imageBlocks(value, depth + 1))
}

function hash(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

async function cacheDir($: Api): Promise<string> {
  if (!cacheRoot) {
    cacheRoot = (async () => {
      const home = await $.env.get('HOME')
      const dir = `${home}/Library/Caches/claude-prompt-image-preview/${await $.session.id()}/conversation`
      await $.process.run(['mkdir', '-p', dir])
      return dir
    })()
  }
  return cacheRoot
}

async function dimensions($: Api, path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path])
  const width = /pixelWidth:\s*(\d+)/.exec(stdout)
  const height = /pixelHeight:\s*(\d+)/.exec(stdout)
  return { width: width ? Number(width[1]) : 0, height: height ? Number(height[1]) : 0 }
}

async function writeBase64($: Api, base64: string, path: string): Promise<boolean> {
  const { exitCode } = await $.process.run(['base64', '-D', '-o', path], { stdin: base64 })
  return exitCode === 0
}

async function expandHome($: Api, path: string): Promise<string> {
  return path.startsWith('~/') ? `${await $.env.get('HOME')}${path.slice(1)}` : path
}

// The PNG the terminal draws for an image file: converted and scaled down into
// the cache, with the original's size. Null when the file is gone or no image.
function picture($: Api, original: string): Promise<Picture | null> {
  const cached = pictures.get(original)
  if (cached) {
    return cached
  }
  const made = (async (): Promise<Picture | null> => {
    const path = await expandHome($, original)
    if (!(await $.fs.exists(path))) {
      return null
    }
    const size = await dimensions($, path)
    if (!size.width || !size.height) {
      return null
    }
    const dir = await cacheDir($)
    for (const pixels of PIXELS) {
      const out = `${dir}/${hash(path)}.${pixels}.png`
      const { exitCode } = await $.process.run(['sips', '-s', 'format', 'png', '-Z', String(pixels), path, '--out', out])
      if (exitCode !== 0) {
        return null
      }
      const { base64 } = await $.fs.read(out, { as: 'bytes' })
      if ((base64.length * 3) / 4 <= MAX_PNG_BYTES) {
        return { path, width: size.width, height: size.height, png: base64 }
      }
    }
    return null
  })().catch(() => null)
  pictures.set(original, made)
  return made
}

// Saves base64 image bytes into the cache as a file, named by their content,
// and returns its path.
async function saveBytes($: Api, base64: string, extension = 'img'): Promise<string | null> {
  const dir = await cacheDir($)
  const path = `${dir}/${hash(base64)}-${base64.length}.${extension}`
  if (await $.fs.exists(path)) {
    return path
  }
  return (await writeBase64($, base64, path)) ? path : null
}

async function toSentImage($: Api, base64: string): Promise<SentImage | null> {
  const path = await saveBytes($, base64)
  if (!path) {
    return null
  }
  const size = await dimensions($, path)
  return size.width ? { path, ...size } : null
}

// Reads every image of the submission in flight, before it settles; the
// files are written afterwards.
async function readAttachments($: Api, ids: string[]): Promise<string[]> {
  const all: string[] = []
  for (const id of ids) {
    let offset: number | undefined
    let base64 = ''
    for (;;) {
      const slice = await $.prompt.media(offset === undefined ? { id } : { id, offset })
      if (slice.type !== 'image') {
        base64 = ''
        break
      }
      base64 += slice.base64
      if (slice.next === undefined) {
        break
      }
      offset = slice.next
    }
    if (base64) {
      all.push(base64)
    }
  }
  return all
}

async function remember($: Api, text: string, bytes: string[]) {
  const images = (await Promise.all(bytes.map(one => toSentImage($, one)))).filter(
    (one): one is SentImage => one !== null,
  )
  if (images.length > 0) {
    await update($, sent, list => [...list, { text, images }])
  }
}

// After --resume the state is the session's but the files may be gone, or the
// session predates this version: rebuild the sent images from the messages.
async function rebuild($: Api) {
  if (rebuilt) {
    return
  }
  rebuilt = true
  const messages = await $.session.messages({ as: 'api' })
  if (!Array.isArray(messages)) {
    return
  }
  const found: SentMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }
    const images = message.content.filter(block => block.type === 'image')
    if (images.length === 0) {
      continue
    }
    const texts = message.content
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
    const text = texts.find(one => /\[Image #\d+\]/.test(one)) ?? texts[0] ?? ''
    const saved: SentImage[] = []
    for (const block of images) {
      const data = (block.source as { data?: unknown } | undefined)?.data
      const image = typeof data === 'string' ? await toSentImage($, data) : null
      if (image) {
        saved.push(image)
      }
    }
    if (saved.length > 0) {
      found.push({ text, images: saved })
    }
  }
  if (found.length > 0) {
    claimed.clear()
    await update($, sent, () => found)
  }
}

export async function openPath($: Api, path: string) {
  await $.process.run(['open', path])
}

type RenderEvent = Parameters<Api['ui']['resolve']>[0] & {
  surface: string
  viewport?: { columns: number }
  props: { onScreen?: unknown }
}

function strip($: Api, e: RenderEvent, shown: Picture[]): RenderElement {
  const { Box, Button } = $.ui.resolve(e)
  const terminal = e.surface === 'terminal' ? $.ui.resolve(e) : null
  const offScreen = e.props.onScreen === null
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1} paddingLeft={2}>
      {shown.map((image, i) => {
        const { columns, rows } = messageSizeFor(image, e.viewport?.columns)
        const label = `Image ${image.width}x${image.height}`
        if (canDraw && terminal && 'Image' in terminal && 'Client' in terminal) {
          const { Image, Client } = terminal
          return (
            <Box key={`pic${i}`} position="relative" width={columns} height={rows}>
              {offScreen ? null : (
                <Image key={`img${i}`} source={{ png: image.png }} columns={columns} rows={rows} alt={label} />
              )}
              <Box position="absolute" top={0} left={0} width={columns} height={rows}>
                <Client key={`click${i}`} module="./click.tsx" props={{ path: image.path }} width={columns} height={rows} />
              </Box>
            </Box>
          )
        }
        return <Button key={`open${i}`} plain dimColor label={label} onPress={() => void openPath($, image.path)} />
      })}
    </Box>
  )
}

async function withPictures($: Api, e: RenderEvent, row: RenderElement, files: string[]): Promise<RenderElement> {
  const shown = (await Promise.all(files.map(file => picture($, file)))).filter(
    (one): one is Picture => one !== null,
  )
  if (shown.length === 0) {
    return row
  }
  const { Box } = $.ui.resolve(e)
  return (
    <Box flexDirection="column" rowGap={1}>
      {row}
      {strip($, e, shown)}
    </Box>
  )
}

// Called by register.tsx's own prompt.submit hook before the submission goes
// on: the images' bytes can only be read while it is in flight.
export async function readSubmitted($: Api, attachments: readonly { type: string; id?: string }[] | undefined): Promise<string[]> {
  if (mode === 'off') {
    return []
  }
  const ids = (attachments ?? []).filter(one => one.type === 'image' && one.id).map(one => one.id as string)
  return ids.length > 0 ? readAttachments($, ids).catch(() => []) : []
}

// Called once the submission settled, with the text the model received.
export function rememberSubmitted($: Api, text: string, bytes: string[]) {
  if (bytes.length > 0) {
    void remember($, text, bytes).catch(() => undefined)
  }
}

export function registerMessages(on: On, options: PluginOptions, drawsImages: () => boolean) {
  mode = typeof options.messageImages === 'string' ? options.messageImages : 'all'
  if (mode === 'off') {
    return
  }

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const row = await next(e)
    canDraw = drawsImages()
    const list = await read($, sent)
    const index = matchSent(list, e.requestId, e.props.text, claimed)
    const message = index === -1 ? undefined : list[index]
    const first = message?.images[0]
    // After --resume the stored paths may be gone with the old session's cache.
    if (!message || !first || !(await $.fs.exists(first.path))) {
      if (/\[Image #\d+\]/.test(e.props.text) && !rebuilt) {
        void rebuild($).catch(() => undefined)
      }
      return row
    }
    return withPictures($, e, row, message.images.map(one => one.path))
  })

  if (mode !== 'all') {
    return
  }

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const row = await next(e)
    canDraw = drawsImages()
    const files = imagePaths(e.props.text)
    return files.length > 0 ? withPictures($, e, row, files) : row
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const row = await next(e)
    canDraw = drawsImages()
    if (e.props.isErrored) {
      return row
    }
    const blocks = imageBlocks(e.props.output)
    if (blocks.length === 0) {
      return row
    }
    const files = (await Promise.all(blocks.map(one => saveBytes($, one)))).filter(
      (one): one is string => one !== null,
    )
    return withPictures($, e, row, files)
  })
}
