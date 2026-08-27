// Electron's <webview> tag, present because the window enables webviewTag.
// Only the attributes the exhibit views set are typed; the live element also
// carries Electron.WebviewTag's methods, of which reload() is the one used.
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        readonly src?: string
      }
    }
  }
}
