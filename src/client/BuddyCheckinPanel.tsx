/**
 * The WorkBuddy daily check-in entry and details panel, rendered in the
 * session header's actions row.
 *
 * The component is deliberately self-contained: it owns its own fetch against
 * the plugin's same-origin routes, its own request sequencing, and its own
 * theme colours. Nothing is injected from the host except the slot it mounts
 * into, so a broken host seam degrades to "the entry is absent" rather than to
 * a crash inside the conversation header.
 *
 * Three behaviours are load-bearing and easy to get wrong:
 *
 * - **Late responses are dropped.** Every fetch is stamped with a request id
 *   and only the newest one may write to state; otherwise a slow first read
 *   can overwrite a fast second one with stale data.
 * - **The balance read is a write.** Opening the panel POSTs to the balance
 *   route, which first signs today if the process has been running across
 *   midnight and then refreshes every balance. That is why the trigger lives
 *   on the click rather than on the mount fetch: the mount fetch must stay a
 *   pure read so a remount cannot claim a day.
 * - **A notice is claimed, not repeated.** The status response carries a
 *   one-shot startup summary, and the host strips it as it hands it over, so a
 *   second window never re-toasts it.
 *
 * @module dsh-buddy-suite/client/checkin-panel
 */

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { BUDDY_CHECKIN_BALANCE_PATH, BUDDY_CHECKIN_PATH } from '../status-paths.ts'
import type { BuddyCheckinDocument, BuddyCheckinRow } from '../status-paths.ts'

/** The panel's request timeout; a hung route must not hang the header. */
const REQUEST_TIMEOUT_MS = 20_000

/** How long the startup summary stays on screen. */
const TOAST_MS = 6_000

/** Per-row height the scroll cap is sized against, in pixels. */
const ROW_HEIGHT_PX = 48

/** Rows visible before the list starts scrolling. */
const VISIBLE_ROWS = 2.5

/**
 * Colours follow the host theme tokens, with literal fallbacks for hosts that
 * do not expose them — the same convention the WorkBuddy cards use.
 */
const COLOR = {
  ok: 'var(--dsw-alias-state-success-primary,#22c55e)',
  warn: 'var(--dsw-alias-state-warn-primary,#eab308)',
  error: 'var(--dsw-alias-state-error-primary,#ef4444)',
  none: 'var(--dsw-alias-label-dimmed,#64748b)',
} as const

const BG_LAYER = 'var(--dsw-alias-bg-layer-1,#252525)'
const BORDER = 'var(--dsw-alias-border-l2,#4a4a4a)'
const LABEL_PRIMARY = 'var(--dsw-alias-label-primary,#f4f4f5)'
const LABEL_SECONDARY = 'var(--dsw-alias-label-secondary,#bdbdbd)'

/** The WorkBuddy mark, as a data URL so the bundle ships no binary asset. */
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAAAXNSR0IArs4c6QAAAHhlWElmTU0AKgAAAAgABAEaAAUAAAABAAAAPgEbAAUAAAABAAAARgEoAAMAAAABAAIAAIdpAAQAAAABAAAATgAAAAAAAACQAAAAAQAAAJAAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAACygAwAEAAAAAQAAACwAAAAALuNfAgAAAAlwSFlzAAAWJQAAFiUBSVIk8AAABhBJREFUWAntmFuoVkUYhq3MtDIrLQNT6QAVZZZRdgILregiiRCjDIWoCEKMThAkGAUWXRRdlB1uiiKjQjsIpWQaBWaZGNVFaimYWnksyw52eJ5/r1fG5e//773tSvYHj/PNzDffvDNrZq1/26tXj/XswIG3AwexpIOrZR1KeSN8ANvhn4p/KbtDfbx182yGuXAnDATtEFBLWzNQOxeeha/AhH9Bd0SWYxT4N6yCb+EPsM1yA6yGWXA6aNm4jlqLfx3wJuwCJ8xOlJN31U+OT8h3LVwM8yD506/4t2AUdMp8JE+Dif4ERSdZV0UmPuO3kWsCxEbjvA/GufM+Ree07tPtA23Nc+Qjc1B2OBN3t1Swgt6AQaB5P7QRsAIyX46eR3EStLW5RGwEE2Rnuiu0HLeSfB6F3qB5PnOpJuNvhYi23AQLoa15wTxH5WT742fRL5Pz8Gp2hZZvo6OpPwE7IHO5076Z2loG/B+lx8A8HrHx1czZ1aq6+01wEg3zwfiMc7F7WLPXhgP218zhZJlQwR9VSev5rbuItTAH3GV11eNoam4G7g9eVHcoR8Fb/wB0xo4k6GHYBmowT1vrjtjsZsZ6/tbAO3APnAKtzB0WbTBMhU/hd2hrmbQrZXbTy/odPA/jYAD4Li0FUW1pxvomuRgebRlZdXZVaMR+z3g/OJeAj7Zu5X3x8+9C+kFfOAzyXsbdvcAjrJSWx1C2lYLLdv16vHXjl8JjsBi2gIuwL/2KzcKOw78ILoVhsBN+g2XwLqwHx2nmbmtJXAqv+3ntKO5BGFlkdbLspjsZ33fwJPBcrwIvo3kznz9+FDwBjHVcxuJ2mGelbiZZDishO+TEnkcf3VFwInixPKuPgLtk8iwMtzHWhTn5WTARFDMcjEtu3IZ52a4Cf3h5VGaDc7S1L4i4DhTnF6g/KHIonAlj4W64CWzXXJACgm367vz98CUo0t3cBXlCWWD6FKj/NYyBTtlcos6uIvd6JFV7+agjMrHWh8A1sAQUoEDF5vHHT92YENGv0+aGtbUfiLiiivLIlIL0Y/oRaSku5HJ4G9ZBRERw6mUZ8WnL7vtUboO25grvqKIU0MzKRUS0f6H4WlsN2bm6GEUpaCMshlVgW+Ij2vLXqp+itRn8EgytwiKoHBXBtnlJ7oPPoLz5dbHZuTXE3QLDYRr4/m4mOOLpbm0GmuTqKqwuOHV3fyzMAT+hjlOUl6qZgAheQP8JoPnmmQk5t+W4LNi4luaETv4c5NC7o7H442hYCXWhCpNy8sRY+pfEORAbgfMNlDH6IXH7LLOytUTcUERFqE2jYSFkcRmTSVKW7fq2+1WbDn6+zel7+l74GexPXHLQ1NoMjJDX8I8twiN6Bm3GlTvpRNZ3wFbwh1BdQMT8RN8UiJ2BsxqS0zIkZp+lgUm8DX8q9C6ih+H7XwBl8sSvo/0uuAxehJzt9Je5F9I/HLTrYQuU/fqyh5VCyo7spJfiZMhFM8bdsE1Lu4kdswieAV9J7vIo8OuYftxGnOX58CSsgTHgXFrm1u+0YINjiiqTmPiYdNZKJ/Dt4Rhf/LPgIfDylqL1PcPjIZan4Fz6Wjako9asgbYEZ3WDaCsFezZ3Qmn2G38l5KJ6nl+BeRBLzjJf+iLO+fV9QnPSmTJBqVt6abx0Wamf6kyE2/hh4gXRsjhjFXg8TIRc1M3478EmaCaS5r3MPGrw19rt9d5mgpcR5Oq0FeAq/YLFfPd+nAplFuNR0PxET4b+VrC+HcU+/814A1yUc06D6fAj7GGZpGz0q+OLfTB8CF6iUjDVxjkdSZkvlhOJk/eDU6v6aZRTwDIxuA2rC91Aq5dwJjjvL+CClnFU97Y+NHlZDHwB6m8SJzbRrWBS43yMlh4R0fc15ZFIvSw9chljzOPg+c/TqC+OrtZ2Ht1LYAG4W6UpVvP1thwiuBRkWzsUPR9uhgGgtRXa7EgoaD18Dq7YifObAbdRN7E7uB0uBCc0rpzQumZbzEWtg6XwKsyAReAxdN4sErfz5sAsZCj+BUU9WYzRBsJsyKc8E9bL7L6vxKdgCJjDxaTE7bGeHTjwd+A/60vXqMxSlxIAAAAASUVORK5CYII='

/**
 * The icon filter that inverts the mark on dark hosts.
 *
 * The host ThemePresenter projects the theme — including a user's manual
 * choice — onto `body[data-ds-dark-theme]`, the same convention other plugins
 * follow. The mark is a dark line drawing, so it is inverted on dark themes
 * and left alone on light ones.
 */
const ICON_FILTER_CSS = '.buddy-checkin-icon{filter:invert(1)}body:not([data-ds-dark-theme]) .buddy-checkin-icon{filter:none}'

/** Inject the icon filter once per document. */
function useIconFilter(): void {
  useEffect(() => {
    if (document.getElementById('buddy-checkin-icon-filter')) return
    const style = document.createElement('style')
    style.id = 'buddy-checkin-icon-filter'
    style.textContent = ICON_FILTER_CSS
    document.head.appendChild(style)
  }, [])
}

/** Whether a parsed response really is a check-in document. */
function isCheckinDocument(value: unknown): value is BuddyCheckinDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const wrapped = value as Record<string, unknown>
  return typeof wrapped['day'] === 'string'
    && typeof wrapped['status'] === 'string'
    && Array.isArray(wrapped['results'])
}

/**
 * One account's outcome line.
 *
 * Written in Chinese, matching the panel's own chrome. This component is
 * deliberately self-contained (it owns its fetch and renders without the host's
 * locale service), so it carries its copy inline rather than through a locale
 * namespace — an earlier revision left these strings in English, which showed
 * as untranslated text in an otherwise Chinese panel.
 */
function outcome(row: BuddyCheckinRow): string {
  if (row.state === 'signed') {
    const time = new Date(row.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return `已签到 ${time}${row.credit === undefined ? '' : ` · +${row.credit} 积分`}`
  }
  if (row.state === 'already') return 'App 内今日已签到'
  // A stopped row is not going to change by pressing retry, so the line says
  // so instead of inviting one; the code decides which sentence is true.
  const retryHint = row.stopCode === 'RATE_LIMITED'
    ? '（上游限流，今日已停止重试）'
    : row.stopCode === 'UPSTREAM_PROTOCOL_CHANGED'
      ? '（上游接口已变更，今日已停止重试）'
      : ''
  return `失败：${row.error ?? '请稍后重试'}${retryHint}`
}

/** One account's balance line, including why it is unavailable when it is. */
function balanceLine(row: BuddyCheckinRow): string {
  if (row.balance === undefined) return '积分：暂不可用'
  return `剩余积分：${row.balance.toLocaleString()}`
    + (row.balanceError !== undefined
      ? ` · ${row.balanceError}`
      : row.balanceCheckedAt !== undefined
        ? ` · ${new Date(row.balanceCheckedAt).toLocaleTimeString()} 更新`
        : ' · 上次记录')
}

/** The header entry and its details panel. */
export function BuddyCheckinPanel(): React.ReactElement | null {
  useIconFilter()
  const [document, setDocument] = useState<BuddyCheckinDocument>()
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState<string>()
  const [retrying, setRetrying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [queryError, setQueryError] = useState<string>()
  const requestId = useRef(0)

  /**
   * Fetch one route, keeping only the newest response.
   *
   * `notify` marks the one read that may raise a toast: the startup summary
   * arrives on the mount read only, because the host claims it on delivery.
   */
  const refresh = async (notify: boolean, path: string, init?: RequestInit): Promise<void> => {
    const id = requestId.current + 1
    requestId.current = id
    setLoading(true)
    setQueryError(undefined)
    try {
      const response = await fetch(path, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const parsed: unknown = await response.json()
      if (!isCheckinDocument(parsed)) throw new Error('unexpected status shape')
      // A late response is dropped rather than rendered: the newest read wins.
      if (id !== requestId.current) return
      setDocument(parsed)
      if (notify && parsed.notice !== undefined) setToast(parsed.notice)
    } catch {
      if (id !== requestId.current) return
      setQueryError('查询失败，请重新打开面板重试；当前显示上次记录')
      setDocument(previous => previous ?? { day: '', checkedAt: 0, results: [], status: 'none' })
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }

  // The mount read is a pure GET: it must never claim a day or a notice that
  // another window already showed.
  useEffect(() => { void refresh(true, BUDDY_CHECKIN_PATH) }, [])

  useEffect(() => {
    if (toast === undefined) return
    const timer = window.setTimeout(() => setToast(undefined), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [toast])

  /** Opening the panel is the day-rollover trigger, so it POSTs the balance route. */
  const openPanel = (): void => {
    setOpen(true)
    void refresh(false, BUDDY_CHECKIN_BALANCE_PATH, { method: 'POST' })
  }

  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      await refresh(false, BUDDY_CHECKIN_PATH, { method: 'POST' })
    } finally {
      setRetrying(false)
    }
  }

  // Nothing to show when the machine has no CN account at all, or when the
  // document is still loading: an entry reading "(0)" would be noise.
  if (document === undefined || document.status === 'none' || document.results.length === 0) return null

  const failed = document.results.some(row => row.state === 'failed')
  const color = COLOR[document.status]

  return (
    <>
      {toast !== undefined && (
        <div style={{
          position: 'fixed',
          zIndex: 1001,
          right: 20,
          top: 18,
          padding: '8px 12px',
          borderRadius: 8,
          background: BG_LAYER,
          border: `1px solid ${color}`,
          color: LABEL_PRIMARY,
          boxShadow: '0 8px 24px #0008',
          fontSize: 13,
        }}
        >
          {toast}
        </div>
      )}
      <button
        type="button"
        onClick={openPanel}
        title="WorkBuddy 签到"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          border: 0,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        <img src={ICON} alt="WorkBuddy" className="buddy-checkin-icon" style={{ width: 16, height: 16 }} />
        <span>({document.results.length})</span>
        <i style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      </button>
      {open && (
        <div style={{
          position: 'fixed',
          zIndex: 1000,
          width: 310,
          right: 20,
          top: 72,
          background: BG_LAYER,
          border: `1px solid ${BORDER}`,
          borderRadius: 10,
          padding: 12,
          boxShadow: '0 18px 45px #0008',
          color: LABEL_PRIMARY,
          fontSize: 13,
        }}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="关闭"
            style={{
              float: 'right',
              background: 'transparent',
              border: 0,
              color: LABEL_SECONDARY,
              fontSize: 19,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            ×
          </button>
          <b style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
            <img src={ICON} alt="" className="buddy-checkin-icon" style={{ width: 16, height: 16 }} />
            WorkBuddy 签到
          </b>
          <div style={{ color: LABEL_SECONDARY, fontSize: 12, margin: '7px 0' }}>
            本次启动检查：
            {' '}
            {document.checkedAt === 0 ? '—' : new Date(document.checkedAt).toLocaleString()}
          </div>
          {loading && <div role="status">正在查询…</div>}
          {queryError !== undefined && <div role="alert">{queryError}</div>}
          {/* Accounts are capped at roughly 2.5 rows; the rest scroll, so the
              title and the retry button stay visible no matter how many
              accounts the machine holds. */}
          <div style={{ maxHeight: ROW_HEIGHT_PX * VISIBLE_ROWS, overflowY: 'auto' }}>
            {document.results.map(row => (
              <div key={row.uid} style={{ padding: '7px 0', borderTop: `1px solid ${BORDER}` }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.nickname ?? row.uid}
                  </b>
                  <span style={{
                    fontSize: 12,
                    color: row.state === 'failed' ? COLOR.error : LABEL_SECONDARY,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  >
                    {outcome(row)}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: LABEL_SECONDARY, marginTop: 3 }}>
                  {balanceLine(row)}
                </div>
              </div>
            ))}
          </div>
          {failed && (
            <button
              type="button"
              disabled={retrying}
              onClick={() => { void retry() }}
              style={{
                marginTop: 8,
                width: '100%',
                padding: '6px 8px',
                borderRadius: 6,
                border: `1px solid ${BORDER}`,
                background: 'transparent',
                color: 'inherit',
                cursor: retrying ? 'wait' : 'pointer',
                font: 'inherit',
                fontSize: 13,
              }}
            >
              {retrying ? '正在重试…' : '重试失败账号'}
            </button>
          )}
        </div>
      )}
    </>
  )
}
