import { useEffect } from 'react'
import { useMode } from '../../contexts/ModeContext'

// Badge config per display mode
const BADGE: Record<string, { letter: string; fill: string }> = {
  server:         { letter: 'S', fill: '#4f46e5' }, // indigo — production server
  client:         { letter: 'C', fill: '#16a34a' }, // green  — client mode
  'dev-standalone': { letter: 'D', fill: '#d97706' }, // amber  — local dev
}

function buildFaviconSvg(letter: string, fill: string): string {
  // Lightning bolt lives in 0 0 48 46. We extend the viewBox to 0 0 80 78 so the
  // badge (bottom-right) has room without clipping. The bolt position is unchanged.
  const badge = `
  <circle cx="58" cy="56" r="22" fill="${fill}" stroke="#0f0f0f" stroke-width="2"/>
  <text x="58" y="65" text-anchor="middle" dominant-baseline="auto"
        font-family="Arial,Helvetica,sans-serif" font-size="28" font-weight="bold" fill="white">${letter}</text>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="78" fill="none" viewBox="0 0 80 78"><path fill="#863bff" d="M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z" style="fill:#863bff;fill-opacity:1"/>${badge}</svg>`
}

export function FaviconUpdater() {
  const { displayMode, loading } = useMode()

  useEffect(() => {
    if (loading || !displayMode) return

    const badge = BADGE[displayMode]
    if (!badge) return

    const svg = buildFaviconSvg(badge.letter, badge.fill)
    const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      link.type = 'image/svg+xml'
      document.head.appendChild(link)
    }
    link.href = dataUrl
  }, [displayMode, loading])

  return null
}
