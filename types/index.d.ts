export type CapturedImage = {
  n: number
  path: string | null
  width: number
  height: number
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-image-preview': { images: CapturedImage[] }
  }
}
