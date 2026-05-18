import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'

const WALLET1 = 'AWK785JofvzZX6meFM6a9gTvLuGXSwt5pUuKVMswC2aS'
const WALLET2 = 'M9xLFEM3q7EhF61aWj5PRvft77KbpW4M6q8j5cDHeA7'
const PLAYERS = {
  [WALLET1]: { name: 'Drew', subtitle: 'Pro Perps Trader' },
  [WALLET2]: { name: 'Vibhu', subtitle: 'Mid Level Manager' },
}
const COMPETITION_START = 1779062142 // wallet 2 deposit tx blockTime May 17 2026
const COMPETITION_END = COMPETITION_START + 7 * 86400
const STARTING_BALANCE = 10000
const PHOENIX_API = 'https://perp-api.phoenix.trade'
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com'
const REFRESH_INTERVAL = 30000

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

async function solanaRPC(method, params) {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await res.json()
  return json.result
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

async function fetchWalletEvents(wallet) {
  const sigs = await solanaRPC('getSignaturesForAddress', [wallet, { limit: 25 }])
  if (!sigs) return []

  const recent = sigs
    .filter(s => s.blockTime && s.blockTime >= COMPETITION_START && !s.err)
    .slice(0, 12)

  const txResults = await Promise.allSettled(
    recent.map(s =>
      solanaRPC('getTransaction', [
        s.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ])
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

function PositionRow({ pos, lotSizes }) {
  const lots = Number(pos.basePositionLots)
  const isLong = lots > 0
  const size = calcSize(lots, lotSizes[pos.symbol] ?? 0)
  const sizeStr = size < 1 ? size.toFixed(4) : size.toFixed(2)
  const price = Number(pos.entryPriceUsd)
  const priceStr = price >= 1000
    ? price.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : price.toLocaleString('en-US', { maximumFractionDigits: 3 })

  return (
    <div className={`position-row ${isLong ? 'long' : 'short'}`}>
      <span className="pos-dir">{isLong ? 'LONG' : 'SHORT'}</span>
      <span className="pos-symbol">{pos.symbol}</span>
      <span className="pos-size">{sizeStr}</span>
      <span className="pos-price">@ ${priceStr}</span>
    </div>
  )
}

function PlayerCard({ walletAddr, leaderData, traderState, lotSizes, isWinning }) {
  const accountValue = leaderData ? Number(leaderData.currentAccountValue.ui) : null
  const score = accountValue !== null ? accountValue - STARTING_BALANCE : null
  const roi = leaderData?.roiLifetime ?? 0
  const positions = traderState?.snapshot?.subaccounts?.[0]?.positions || []

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
            />
          ))
      }
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

function EventFeed({ events }) {
  return (
    <div className="event-feed">
      <div className="feed-header">MATCH EVENTS</div>
      {events.length === 0 ? (
        <div className="no-events">No events yet since competition start</div>
      ) : (
        <div className="feed-list">
          {events.map(ev => (
            <div key={ev.sig} className={`feed-item ${ev.wallet === WALLET1 ? 'p1' : 'p2'}`}>
              <span className="ev-time">{fmtTime(ev.time)}</span>
              <span className={`ev-type ev-${ev.type.replace(' ', '-').toLowerCase()}`}>
                {EVENT_ICON[ev.type] || '•'} {ev.type}
              </span>
              <span className="ev-player">{PLAYERS[ev.wallet].name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [leaderboard, setLeaderboard] = useState({ w1: null, w2: null })
  const [state1, setState1] = useState(null)
  const [state2, setState2] = useState(null)
  const [lotSizes, setLotSizes] = useState({})
  const [events, setEvents] = useState([])
  const [lastRefresh, setLastRefresh] = useState(null)
  const [loading, setLoading] = useState(true)
  const [countdown, setCountdown] = useState(fmtCountdown(COMPETITION_END))
  const fetchingRef = useRef(false)

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

      if (lb.status === 'fulfilled') setLeaderboard(lb.value)
      if (s1.status === 'fulfilled') setState1(s1.value)
      if (s2.status === 'fulfilled') setState2(s2.value)

      const allEvents = [
        ...(ev1.status === 'fulfilled' ? ev1.value : []),
        ...(ev2.status === 'fulfilled' ? ev2.value : []),
      ].sort((a, b) => b.time - a.time)
      setEvents(allEvents)
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
          isWinning={p1Winning}
        />
        <PlayerCard
          walletAddr={WALLET2}
          leaderData={leaderboard.w2}
          traderState={state2}
          lotSizes={lotSizes}
          isWinning={p2Winning}
        />
      </div>

      <EventFeed events={events} />
    </div>
  )
}
