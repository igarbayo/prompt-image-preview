export type CapturedImage = {
  n: number
  path: string | null
  width: number
  height: number
}

// One image of a sent message, saved as a PNG in the session's cache folder.
export type SentImage = {
  path: string
  width: number
  height: number
}

// A message the person sent with images: its text, as submitted, and the
// images the model received with it, in order.
export type SentMessage = {
  text: string
  images: SentImage[]
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-image-preview': { images: CapturedImage[]; sent: SentMessage[] }
  }
}
