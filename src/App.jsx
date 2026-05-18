import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'

const WALLET1 = 'AWK785JofvzZX6meFM6a9gTvLuGXSwt5pUuKVMswC2aS'
const WALLET2 = 'M9xLFEM3q7EhF61aWj5PRvft77KbpW4M6q8j5cDHeA7'
const PLAYERS = {
  [WALLET1]: { name: 'Drew', subtitle: 'Pro Perps Trader' },
  [WALLET2]: { name: 'Vibhu', subtitle: 'Mid Level Manager' },
}
const COMPETITION_START = 1779062142
const COMPETITION_END = COMPETITION_START + 7 * 86400
const STARTING_BALANCE = 10000
const PHOENIX_API = 'https://perp-api.phoenix.trade'
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com'
const REFRESH_INTERVAL = 30000
const TRACKED_SYMBOLS = ['HYPE', 'SOL']

// ── Formatters ────────────────────────────────────────────────────────────────

function shortWallet(w) {
  return `${w.slice(0, 4)}...${w.slice(-4)}`
}

function fmtUSD(n) {
  const abs = Math.abs(n)
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (n < 0 ? '-' : '+') + '$' + str
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function fmtCountdown(endTs) {
  const remaining = endTs - Math.floor(Date.now() / 1000)
  if (remaining <= 0) return 'MATCH OVER'
  const d = Math.floor(remaining / 86400)
  const h = Math.floor((remaining % 86400) / 3600)
  const m = Math.floor((remaining % 3600) / 60)
  const s = remaining % 60
  if (d > 0) return `${d}d ${h}h ${m}m remaining`
  if (h > 0) return `${h}h ${m}m ${s}s remaining`
  return `${m}m ${s}s remaining`
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function parseEventType(logs) {
  if (!logs) return null
  for (const log of logs) {
    if (log.includes('Place Market Order')) return 'Market Order'
    if (log.includes('Place limit order') || log.includes('Place Limit Order')) return 'Limit Order'
    if (log.includes('Cancel')) return 'Cancel'
    if (log.includes('DepositFunds')) return 'Deposit'
    if (log.includes('WithdrawFunds') || log.includes('Withdraw')) return 'Withdraw'
  }
  return null
}

function calcSize(lots, baseLotsDecimals) {
  return Math.abs(Number(lots)) * Math.pow(10, -(baseLotsDecimals ?? 0))
}

function calcUnrealizedPnl(pos, markPrice, bld) {
  const lots = Number(pos.basePositionLots)
  const isLong = lots > 0
  const size = calcSize(lots, bld)
  const entry = Number(pos.entryPriceUsd)
  const diff = markPrice - entry
  const pnl = isLong ? diff * size : -diff * size
  const notional = entry * size
  const pnlPct = notional > 0 ? pnl / notional : 0
  return { pnl, pnlPct, notional, size, isLong, entry }
}

function getPositions(traderState) {
  return traderState?.snapshot?.subaccounts?.[0]?.positions || []
}

// Detect HYPE/SOL opens and closes between polls
function detectTrackedChanges(wallet, prev, curr) {
  if (!prev) return []
  const now = Math.floor(Date.now() / 1000)
  const prevMap = Object.fromEntries(prev.map(p => [p.symbol, p]))
  const currMap = Object.fromEntries(curr.map(p => [p.symbol, p]))
  const events = []

  for (const sym of TRACKED_SYMBOLS) {
    const was = prevMap[sym]
    const is = currMap[sym]
    if (!was && is) {
      const lots = Number(is.basePositionLots)
      events.push({
        sig: `syn-${wallet}-${sym}-open-${now}`,
        time: now,
        type: `${sym} ${lots > 0 ? 'LONG' : 'SHORT'} Opened`,
        subtype: 'tracked-open',
        symbol: sym,
        direction: lots > 0 ? 'LONG' : 'SHORT',
        entryPrice: is.entryPriceUsd,
        wallet,
        synthetic: true,
      })
    } else if (was && !is) {
      events.push({
        sig: `syn-${wallet}-${sym}-close-${now}`,
        time: now,
        type: `${sym} Position Closed`,
        subtype: 'tracked-close',
        symbol: sym,
        wallet,
        synthetic: true,
      })
    }
  }
  return events
}

// ── API fetchers ──────────────────────────────────────────────────────────────

async function solanaRPC(method, params) {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await res.json()).result
}

async function fetchLeaderboard() {
  const res = await fetch(`${PHOENIX_API}/v1/exchange/leaderboard`)
  const data = await res.json()
  const entries = data.entries || []
  return {
    w1: entries.find(e => e.userPubkey === WALLET1),
    w2: entries.find(e => e.userPubkey === WALLET2),
  }
}

async function fetchTraderState(wallet) {
  const res = await fetch(`${PHOENIX_API}/v1/trader/state/${wallet}`)
  return res.json()
}

async function fetchMarketLotSizes() {
  const res = await fetch(`${PHOENIX_API}/v1/view/markets`)
  const data = await res.json()
  const map = {}
  for (const m of data.markets || []) {
    const bld = m.units?.baseLotsDecimals ?? m.baseLotsDecimals
    if (bld !== undefined) map[m.symbol] = bld
  }
  return map
}

async function fetchMarkPrices(symbols) {
  const results = await Promise.allSettled(
    symbols.map(async sym => {
      const res = await fetch(`${PHOENIX_API}/v1/market/${sym}/stats`)
      const data = await res.json()
      const price = data.stats?.[0]?.mark_price
      return { sym, price }
    })
  )
  const prices = {}
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.price != null) {
      prices[r.value.sym] = r.value.price
    }
  }
  return prices
}

async function fetchWalletEvents(wallet) {
  const sigs = await solanaRPC('getSignaturesForAddress', [wallet, { limit: 25 }])
  if (!sigs) return []
  const recent = sigs
    .filter(s => s.blockTime && s.blockTime >= COMPETITION_START && !s.err)
    .slice(0, 12)
  const txResults = await Promise.allSettled(
    recent.map(s =>
      solanaRPC('getTransaction', [s.signature, {
        encoding: 'jsonParsed', maxSupportedTransactionVersion: 0,
      }])
    )
  )
  const events = []
  recent.forEach((s, i) => {
    const r = txResults[i]
    if (r.status !== 'fulfilled' || !r.value) return
    const logs = r.value.meta?.logMessages || []
    const type = parseEventType(logs)
    if (type) events.push({ sig: s.signature, time: s.blockTime, type, wallet })
  })
  return events
}

// ── Components ────────────────────────────────────────────────────────────────

function ScoreDisplay({ value, roi }) {
  const pos = value >= 0
  return (
    <div className="score-display">
      <div className={`score-pnl ${pos ? 'positive' : 'negative'}`}>{fmtUSD(value)}</div>
      <div className={`score-roi ${pos ? 'positive' : 'negative'}`}>
        {(pos ? '+' : '') + (roi * 100).toFixed(2)}% ROI
      </div>
    </div>
  )
}

function PositionRow({ pos, lotSizes, markPrices }) {
  const lots = Number(pos.basePositionLots)
  const isLong = lots > 0
  const bld = lotSizes[pos.symbol] ?? 0
  const size = calcSize(lots, bld)
  const sizeStr = size < 1 ? size.toFixed(4) : size.toFixed(2)
  const entry = Number(pos.entryPriceUsd)
  const priceStr = entry >= 1000
    ? entry.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : entry.toLocaleString('en-US', { maximumFractionDigits: 3 })
  const markPrice = markPrices[pos.symbol]
  const upnl = markPrice ? calcUnrealizedPnl(pos, markPrice, bld) : null

  return (
    <div className={`position-row ${isLong ? 'long' : 'short'}`}>
      <span className="pos-dir">{isLong ? 'LONG' : 'SHORT'}</span>
      <span className="pos-symbol">{pos.symbol}</span>
      <span className="pos-size">{sizeStr}</span>
      <span className="pos-price">@ ${priceStr}</span>
      {upnl && (
        <span className={`pos-upnl ${upnl.pnl >= 0 ? 'positive' : 'negative'}`}>
          {fmtUSD(upnl.pnl)}
        </span>
      )}
    </div>
  )
}

function PlayerCard({ walletAddr, leaderData, traderState, lotSizes, markPrices, isWinning }) {
  const accountValue = leaderData ? Number(leaderData.currentAccountValue.ui) : null
  const score = accountValue !== null ? accountValue - STARTING_BALANCE : null
  const roi = leaderData?.roiLifetime ?? 0
  const positions = getPositions(traderState)

  return (
    <div className={`player-card${isWinning ? ' winning' : ''}`}>
      {isWinning && <div className="winning-badge">LEADING</div>}
      <div className="player-name">{PLAYERS[walletAddr].name}</div>
      <div className="player-subtitle">{PLAYERS[walletAddr].subtitle}</div>
      <div className="player-wallet">{shortWallet(walletAddr)}</div>
      <div className="player-account-val">
        {accountValue !== null
          ? '$' + accountValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : '—'
        }
      </div>
      <div className="player-account-label">Account Value</div>
      {score !== null && <ScoreDisplay value={score} roi={roi} />}
      <div className="positions-label">Open Positions</div>
      {positions.length === 0
        ? <div className="no-positions">Flat — no open positions</div>
        : positions.map(p => (
            <PositionRow
              key={p.symbol + p.positionSequenceNumber}
              pos={p}
              lotSizes={lotSizes}
              markPrices={markPrices}
            />
          ))
      }
    </div>
  )
}

function BestWorstTrades({ state1, state2, markPrices, lotSizes }) {
  const all = []
  for (const [wallet, state] of [[WALLET1, state1], [WALLET2, state2]]) {
    for (const pos of getPositions(state)) {
      const mark = markPrices[pos.symbol]
      if (!mark) continue
      const bld = lotSizes[pos.symbol] ?? 0
      const { pnl, pnlPct } = calcUnrealizedPnl(pos, mark, bld)
      const lots = Number(pos.basePositionLots)
      all.push({ pos, wallet, pnl, pnlPct, isLong: lots > 0 })
    }
  }

  if (all.length < 2) return null

  const sorted = [...all].sort((a, b) => b.pnlPct - a.pnlPct)
  const best = sorted[0]
  const worst = sorted[sorted.length - 1]
  if (best === worst) return null

  return (
    <div className="best-worst">
      <div className="bw-item">
        <div className="bw-tag best-tag">Best Position</div>
        <div className="bw-player">{PLAYERS[best.wallet].name}</div>
        <div className="bw-pos">{best.isLong ? 'LONG' : 'SHORT'} {best.pos.symbol}</div>
        <div className="bw-pnl positive">
          {fmtUSD(best.pnl)}{' '}
          <span className="bw-pct">({best.pnlPct >= 0 ? '+' : ''}{(best.pnlPct * 100).toFixed(2)}%)</span>
        </div>
      </div>
      <div className="bw-divider" />
      <div className="bw-item">
        <div className="bw-tag worst-tag">Worst Position</div>
        <div className="bw-player">{PLAYERS[worst.wallet].name}</div>
        <div className="bw-pos">{worst.isLong ? 'LONG' : 'SHORT'} {worst.pos.symbol}</div>
        <div className="bw-pnl negative">
          {fmtUSD(worst.pnl)}{' '}
          <span className="bw-pct">({worst.pnlPct >= 0 ? '+' : ''}{(worst.pnlPct * 100).toFixed(2)}%)</span>
        </div>
      </div>
    </div>
  )
}

const EVENT_ICON = {
  'Market Order': '⚡',
  'Limit Order': '⬡',
  'Cancel': '✕',
  'Deposit': '▼',
  'Withdraw': '▲',
}

function EventFeed({ events, state1, state2, markPrices, lotSizes }) {
  // Show currently active HYPE/SOL positions as a "live" banner at the top
  const activeTracked = []
  for (const [wallet, state] of [[WALLET1, state1], [WALLET2, state2]]) {
    for (const pos of getPositions(state)) {
      if (!TRACKED_SYMBOLS.includes(pos.symbol)) continue
      const lots = Number(pos.basePositionLots)
      const mark = markPrices[pos.symbol]
      const bld = lotSizes[pos.symbol] ?? 0
      const upnl = mark ? calcUnrealizedPnl(pos, mark, bld) : null
      activeTracked.push({ wallet, pos, isLong: lots > 0, upnl })
    }
  }

  return (
    <div className="event-feed">
      <div className="feed-header">MATCH EVENTS</div>

      {activeTracked.length > 0 && (
        <div className="active-tracked">
          {activeTracked.map(({ wallet, pos, isLong, upnl }) => (
            <div key={wallet + pos.symbol} className={`active-tracked-item ${wallet === WALLET1 ? 'p1' : 'p2'}`}>
              <span className="at-live">LIVE</span>
              <span className="at-player">{PLAYERS[wallet].name}</span>
              <span className={`at-dir ${isLong ? 'long' : 'short'}`}>{isLong ? 'LONG' : 'SHORT'}</span>
              <span className="at-symbol">{pos.symbol}</span>
              {upnl && (
                <span className={`at-upnl ${upnl.pnl >= 0 ? 'positive' : 'negative'}`}>
                  {fmtUSD(upnl.pnl)} ({upnl.pnlPct >= 0 ? '+' : ''}{(upnl.pnlPct * 100).toFixed(2)}%)
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {events.length === 0 ? (
        <div className="no-events">No events yet since competition start</div>
      ) : (
        <div className="feed-list">
          {events.map(ev => {
            const isTracked = ev.synthetic && (ev.subtype === 'tracked-open' || ev.subtype === 'tracked-close')
            return (
              <div
                key={ev.sig}
                className={`feed-item ${ev.wallet === WALLET1 ? 'p1' : 'p2'}${isTracked ? ' tracked-event' : ''}`}
              >
                <span className="ev-time">{fmtTime(ev.time)}</span>
                <span className={`ev-type ${isTracked ? `ev-tracked ev-${ev.subtype}` : `ev-${ev.type.replace(' ', '-').toLowerCase()}`}`}>
                  {isTracked
                    ? (ev.subtype === 'tracked-open' ? '🔥' : '✓') + ' ' + ev.type
                    : (EVENT_ICON[ev.type] || '•') + ' ' + ev.type
                  }
                </span>
                {ev.entryPrice && (
                  <span className="ev-entry">@ ${Number(ev.entryPrice).toLocaleString()}</span>
                )}
                <span className="ev-player">{PLAYERS[ev.wallet].name}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [leaderboard, setLeaderboard] = useState({ w1: null, w2: null })
  const [state1, setState1] = useState(null)
  const [state2, setState2] = useState(null)
  const [lotSizes, setLotSizes] = useState({})
  const [markPrices, setMarkPrices] = useState({})
  const [chainEvents, setChainEvents] = useState([])
  const [synthEvents, setSynthEvents] = useState([])
  const [lastRefresh, setLastRefresh] = useState(null)
  const [loading, setLoading] = useState(true)
  const [countdown, setCountdown] = useState(fmtCountdown(COMPETITION_END))
  const fetchingRef = useRef(false)
  const prevPositions = useRef({ [WALLET1]: null, [WALLET2]: null })
  const isFirstLoad = useRef(true)

  const refresh = useCallback(async () => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    try {
      const [lb, s1, s2, ev1, ev2] = await Promise.allSettled([
        fetchLeaderboard(),
        fetchTraderState(WALLET1),
        fetchTraderState(WALLET2),
        fetchWalletEvents(WALLET1),
        fetchWalletEvents(WALLET2),
      ])

      const newState1 = s1.status === 'fulfilled' ? s1.value : null
      const newState2 = s2.status === 'fulfilled' ? s2.value : null

      // Collect all unique symbols for mark price fetching
      const symbols = new Set()
      for (const state of [newState1, newState2]) {
        for (const pos of getPositions(state)) symbols.add(pos.symbol)
      }
      const prices = await fetchMarkPrices([...symbols])
      setMarkPrices(prices)

      if (lb.status === 'fulfilled') setLeaderboard(lb.value)
      if (newState1) setState1(newState1)
      if (newState2) setState2(newState2)

      // Detect HYPE/SOL position changes (skip first load to avoid false "open" events)
      if (!isFirstLoad.current) {
        const curr1 = getPositions(newState1)
        const curr2 = getPositions(newState2)
        const newSynth = [
          ...detectTrackedChanges(WALLET1, prevPositions.current[WALLET1], curr1),
          ...detectTrackedChanges(WALLET2, prevPositions.current[WALLET2], curr2),
        ]
        if (newSynth.length > 0) {
          setSynthEvents(prev => [...newSynth, ...prev])
        }
      }
      isFirstLoad.current = false

      // Store current positions for next comparison
      if (newState1) prevPositions.current[WALLET1] = getPositions(newState1)
      if (newState2) prevPositions.current[WALLET2] = getPositions(newState2)

      const allChain = [
        ...(ev1.status === 'fulfilled' ? ev1.value : []),
        ...(ev2.status === 'fulfilled' ? ev2.value : []),
      ].sort((a, b) => b.time - a.time)
      setChainEvents(allChain)

      setLastRefresh(new Date())
    } finally {
      fetchingRef.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMarketLotSizes().then(setLotSizes).catch(() => {})
    refresh()
    const id = setInterval(refresh, REFRESH_INTERVAL)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    const id = setInterval(() => setCountdown(fmtCountdown(COMPETITION_END)), 1000)
    return () => clearInterval(id)
  }, [])

  // Merge chain + synthetic events, newest first
  const allEvents = [...synthEvents, ...chainEvents].sort((a, b) => b.time - a.time)

  const score1 = leaderboard.w1 ? Number(leaderboard.w1.currentAccountValue.ui) - STARTING_BALANCE : null
  const score2 = leaderboard.w2 ? Number(leaderboard.w2.currentAccountValue.ui) - STARTING_BALANCE : null
  const p1Winning = score1 !== null && score2 !== null && score1 > score2
  const p2Winning = score1 !== null && score2 !== null && score2 > score1

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <span className="live-dot" />
          <span className="header-title">PHOENIX PERPS BATTLE</span>
        </div>
        <div className="header-right">
          <span className="countdown">{countdown}</span>
          <button className="refresh-btn" onClick={refresh} disabled={loading}>
            {loading ? '...' : 'Refresh'}
          </button>
        </div>
      </header>

      <div className="last-updated">
        {lastRefresh ? `Last updated: ${lastRefresh.toLocaleTimeString()} • auto-refreshes every 30s` : 'Loading data...'}
      </div>

      <div className="scoreboard">
        <div className="sb-player">
          <div className="sb-name">{PLAYERS[WALLET1].name}</div>
          <div className={`sb-score ${score1 !== null && score1 >= 0 ? 'positive' : 'negative'}`}>
            {score1 !== null ? fmtUSD(score1) : '—'}
          </div>
        </div>
        <div className="sb-vs">VS</div>
        <div className="sb-player">
          <div className="sb-name">{PLAYERS[WALLET2].name}</div>
          <div className={`sb-score ${score2 !== null && score2 >= 0 ? 'positive' : 'negative'}`}>
            {score2 !== null ? fmtUSD(score2) : '—'}
          </div>
        </div>
      </div>

      <div className="players-grid">
        <PlayerCard
          walletAddr={WALLET1}
          leaderData={leaderboard.w1}
          traderState={state1}
          lotSizes={lotSizes}
          markPrices={markPrices}
          isWinning={p1Winning}
        />
        <PlayerCard
          walletAddr={WALLET2}
          leaderData={leaderboard.w2}
          traderState={state2}
          lotSizes={lotSizes}
          markPrices={markPrices}
          isWinning={p2Winning}
        />
      </div>

      <BestWorstTrades
        state1={state1}
        state2={state2}
        markPrices={markPrices}
        lotSizes={lotSizes}
      />

      <EventFeed
        events={allEvents}
        state1={state1}
        state2={state2}
        markPrices={markPrices}
        lotSizes={lotSizes}
      />
    </div>
  )
}
