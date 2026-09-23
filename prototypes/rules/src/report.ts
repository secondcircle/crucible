// The survey report: a dark HTML page in Crucible's palette, for the context panel.

import type { Evaluated } from './evaluate.ts'
import type { Label, Verdict } from './labels.ts'

export interface Row {
  label: Label
  result?: Evaluated
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const violation = (v: Verdict) => v !== 'kept'

/** Probability that a random violation scores higher than a random kept comment. 0.5 is chance. */
export function auc(pos: number[], neg: number[]): number {
  if (pos.length === 0 || neg.length === 0) return NaN
  let wins = 0
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0
  return wins / (pos.length * neg.length)
}

function bars(values: number[], color: string): string {
  const buckets = new Array(10).fill(0)
  for (const v of values) buckets[Math.min(9, Math.floor(v * 10))]++
  const max = Math.max(1, ...buckets)
  return `<div class="hist">${buckets
    .map((b, i) => `<div title="${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}: ${b}" style="height:${(b / max) * 100}%;background:${color}"></div>`)
    .join('')}</div>`
}

export function surveyHtml(opts: {
  rule: string
  repo: string
  rows: Row[]
  questions: string[]
  spent: number
  calls: number
  hits: number
  latencies: number[]
  sampleRequest?: unknown
  judged: boolean
}): string {
  const { rows, questions } = opts
  const count = (v: Verdict) => rows.filter((r) => r.label.verdict === v).length
  const judgedRows = rows.filter((r) => r.result?.answers)

  const perQuestion = questions.map((q) => {
    const val = (r: Row) => (r.result!.answers![q] as { noul: number }).noul
    const pos = judgedRows.filter((r) => violation(r.label.verdict)).map(val)
    const neg = judgedRows.filter((r) => !violation(r.label.verdict)).map(val)
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
    return { q, pos, neg, auc: auc(pos, neg), meanPos: mean(pos), meanNeg: mean(neg) }
  })

  const actions = ['note', 'escalate', 'pass', 'unjudged'] as const
  const verdicts: Verdict[] = ['removed', 'rewritten', 'kept']
  const cell = (v: Verdict, a: string) => rows.filter((r) => r.label.verdict === v && (r.result?.action ?? 'unjudged') === a).length

  const disagreements = judgedRows.filter(
    (r) => (violation(r.label.verdict) && r.result!.action === 'pass') || (!violation(r.label.verdict) && r.result!.action === 'note'),
  )

  const sorted = [...opts.latencies].sort((a, b) => a - b)
  const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!.toFixed(0) : '–')

  const tp = cell('removed', 'note') + cell('rewritten', 'note')
  const fp = cell('kept', 'note')
  const fn = cell('removed', 'pass') + cell('rewritten', 'pass')
  const tn = cell('kept', 'pass')

  const answerCells = (r: Row) =>
    questions.map((q) => `<td class="num">${r.result?.answers ? (r.result.answers[q] as { noul: number }).noul.toFixed(2) : '–'}</td>`).join('')

  const table = (list: Row[]) => `
    <table>
      <tr><th>police said</th><th>rule said</th><th>comment</th>${questions.map((q) => `<th>${esc(q)}</th>`).join('')}<th>where</th></tr>
      ${list
        .map(
          (r) => `<tr>
        <td class="v-${r.label.verdict}">${r.label.verdict}</td>
        <td class="a-${r.result?.action ?? 'unjudged'}">${r.result?.action ?? 'unjudged'}</td>
        <td class="comment">${esc(r.label.text)}</td>
        ${answerCells(r)}
        <td class="where">${esc(r.label.path)}:${r.label.line}<br><span class="dim">${esc(r.label.police)}</span></td>
      </tr>`,
        )
        .join('')}
    </table>`

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(opts.rule)} survey</title><style>
  body{background:#191419;color:#e8dfe2;font:14px/1.5 -apple-system,'Segoe UI',system-ui,sans-serif;margin:0;padding:28px 32px;max-width:1200px}
  h1,h2{color:#e07a4f;font-weight:600} h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:32px 0 10px}
  .dim{color:#9b8a94} code,pre,.comment,.where{font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px}
  pre{background:#120e12;border:1px solid #3a2e38;border-radius:8px;padding:12px;overflow:auto;white-space:pre-wrap}
  .cards{display:flex;gap:12px;flex-wrap:wrap} .card{background:#241c23;border:1px solid #3a2e38;border-radius:8px;padding:12px 16px;min-width:130px}
  .card b{display:block;font-size:22px;color:#e8dfe2} .card span{color:#9b8a94;font-size:12px}
  table{border-collapse:collapse;width:100%;margin-top:6px} th,td{border-bottom:1px solid #3a2e38;padding:6px 8px;text-align:left;vertical-align:top}
  th{color:#9b8a94;font-weight:500;font-size:12px} td.num{text-align:right;font-variant-numeric:tabular-nums}
  .v-removed,.v-rewritten{color:#d96a5a} .v-kept{color:#7fb069} .a-note{color:#d96a5a} .a-pass{color:#7fb069} .a-escalate{color:#d9a441} .a-unjudged{color:#9b8a94}
  .comment{max-width:520px;white-space:pre-wrap} .where{white-space:nowrap}
  .hist{display:flex;align-items:flex-end;gap:2px;height:48px;width:220px;background:#120e12;border:1px solid #3a2e38;border-radius:6px;padding:4px}
  .hist div{flex:1;border-radius:2px 2px 0 0;min-height:1px}
  .q{display:grid;grid-template-columns:140px 240px 240px 1fr;gap:12px;align-items:center;margin:8px 0}
  </style></head><body>
  <h1>${esc(opts.rule)}: rule vs. the comment police</h1>
  <div class="dim">${esc(opts.repo)} · labels mined from every "comment police" commit · ${opts.judged ? 'judged by Jev' : 'extract-only: no judge calls'}</div>

  <h2>Labels</h2>
  <div class="cards">
    <div class="card"><b>${rows.length}</b><span>comments with a police verdict</span></div>
    <div class="card"><b>${count('removed')}</b><span>removed by the police</span></div>
    <div class="card"><b>${count('rewritten')}</b><span>rewritten by the police</span></div>
    <div class="card"><b>${count('kept')}</b><span>added by the branch, kept</span></div>
    ${opts.judged ? `
    <div class="card"><b>${opts.calls}</b><span>Jev calls (${opts.hits} cached)</span></div>
    <div class="card"><b>$${opts.spent.toFixed(4)}</b><span>spent this run</span></div>
    <div class="card"><b>${pct(0.5)} / ${pct(0.95)} ms</b><span>latency p50 / p95</span></div>` : ''}
  </div>

  ${
    opts.judged
      ? `
  <h2>How well each question separates violations from kept comments</h2>
  <div class="dim">AUC: the chance a random police-rejected comment scores higher than a random kept one. 0.5 is a coin flip, 1.0 is perfect. For <code>explainsWhy</code> lower is the right direction, so read it as 1 − AUC.</div>
  ${perQuestion
    .map(
      (p) => `<div class="q"><code>${esc(p.q)}</code>
      <div>${bars(p.pos, '#d96a5a')}<span class="dim">rejected · mean ${p.meanPos.toFixed(2)}</span></div>
      <div>${bars(p.neg, '#7fb069')}<span class="dim">kept · mean ${p.meanNeg.toFixed(2)}</span></div>
      <div>AUC <b>${p.auc.toFixed(3)}</b></div></div>`,
    )
    .join('')}

  <h2>What the rule would have done</h2>
  <table>
    <tr><th>police said</th>${actions.map((a) => `<th class="a-${a}">${a}</th>`).join('')}</tr>
    ${verdicts.map((v) => `<tr><td class="v-${v}">${v}</td>${actions.map((a) => `<td class="num">${cell(v, a)}</td>`).join('')}</tr>`).join('')}
  </table>
  <p class="dim">Treating note as "reject": precision ${(tp / Math.max(1, tp + fp)).toFixed(2)}, recall ${(tp / Math.max(1, tp + fn)).toFixed(2)}; kept comments passed ${(tn / Math.max(1, count('kept'))).toFixed(2)}. Escalations go to review and count as neither.</p>

  <h2>Disagreements (${disagreements.length})</h2>
  <div class="dim">The police rejected it and the rule passed it, or the police kept it and the rule would have noted it.</div>
  ${table(disagreements)}`
      : ''
  }

  <h2>Labelled comments${rows.length > 400 ? ` (first 400 of ${rows.length}; all of them are in the JSON beside this report)` : ''}</h2>
  ${table(rows.slice(0, 400))}

  ${opts.sampleRequest ? `<h2>One request exactly as sent</h2><pre>${esc(JSON.stringify(opts.sampleRequest, null, 2))}</pre>` : ''}
  </body></html>`
}
