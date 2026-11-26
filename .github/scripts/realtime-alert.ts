import process from 'node:process'

const marker = '<!-- predicthq:production-realtime-monitor -->'
const issuePrefix = 'Production realtime check failed'
const { GITHUB_REPOSITORY: repo, GITHUB_REPOSITORY_OWNER: owner, GITHUB_SERVER_URL: server, GITHUB_RUN_ID: runId } = process.env
if (!repo || !owner || !server || !runId)
  throw new Error('Missing GitHub Actions run context')

const phaseLabels = new Map([
  ['dns', 'DNS lookup'],
  ['tcp', 'TCP connection'],
  ['tls', 'TLS handshake'],
  ['request', 'HTTP request setup'],
  ['first-byte', 'response first byte'],
  ['response-body', 'response body'],
])

interface ProbeResult {
  http: { ok: boolean, timeoutPhase?: string | null, status?: number, protocol?: string, exitCode?: number }
  websocket: { ok: boolean, error?: string | null, subscribedMs?: number | null }
}

interface Issue {
  number: number
  title: string
  body: string | null
  user: { login: string } | null
}

function gh(args: string[], body?: string): string {
  const result = Bun.spawnSync(['gh', ...args], { stdin: body === undefined ? undefined : Buffer.from(body) })
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || `gh exited ${result.exitCode}`)
  return result.stdout.toString().trim()
}

const failures: string[] = []
const result: ProbeResult | null = await Bun.file('realtime-check.json').json().catch(() => null)
if (result?.http && result.websocket) {
  const { http, websocket } = result
  if (!http.ok) {
    const timeout = phaseLabels.get(http.timeoutPhase ?? '')
    if (timeout)
      failures.push(`HTTP timeout during ${timeout}`)
    else if (http.exitCode === 6)
      failures.push('HTTP failed to resolve DNS')
    else if (http.exitCode === 7)
      failures.push('HTTP failed to connect over TCP')
    else if (http.exitCode === 35 || http.exitCode === 60)
      failures.push('HTTP TLS handshake or certificate verification failed')
    else if (http.exitCode === 0)
      failures.push(`Expected HTTP/2 200, received HTTP/${http.protocol} ${http.status}`)
    else
      failures.push(`HTTP probe failed${http.exitCode === undefined ? '' : ` (curl exit ${http.exitCode})`}`)
  }
  if (!websocket.ok) {
    const error = websocket.error ?? 'WebSocket probe failed'
    // Network errors are still shown in the report. Keep issue titles bounded and single-line.
    const summary = error.replaceAll(/\s+/g, ' ').slice(0, 100)
    failures.push(websocket.subscribedMs != null && !summary.startsWith('WebSocket odds update missing')
      ? `WebSocket update missing (${summary})`
      : summary)
  }
}
else {
  failures.push('The production probe did not produce a report')
}

for (const failure of failures)
  console.error(`::error title=Realtime check failed::${failure.replaceAll('%', '%25')}`)

const issuesApi = `repos/${repo}/issues`
const pages: Issue[][] = JSON.parse(gh(['api', '--paginate', '--slurp', `${issuesApi}?state=open&per_page=100`]))
const issue = pages.flat().find(item => item.user?.login === 'github-actions[bot]'
  && item.title.startsWith(issuePrefix) && item.body?.startsWith(marker))

if (failures.length > 0) {
  const title = `${issuePrefix} — ${failures.join(' and ')}`.slice(0, 240)
  const runUrl = `${server}/${repo}/actions/runs/${runId}`
  const body = [
    marker,
    'The public check for `realtime.predicthq.org` failed.',
    '',
    ...failures.map(failure => `- ${failure}`),
    '',
    `[Open the failed run for phase timings and the JSON report](${runUrl}).`,
  ].join('\n')
  const method = issue ? 'PATCH' : 'POST'
  const endpoint = issue ? `${issuesApi}/${issue.number}` : issuesApi
  const data = issue ? { title, body } : { title, body, assignees: [owner] }
  console.log(gh(['api', '--method', method, endpoint, '--input', '-', '--jq', '.html_url'], JSON.stringify(data)))
}
else if (issue) {
  const data = { state: 'closed', state_reason: 'completed' }
  console.log(gh(['api', '--method', 'PATCH', `${issuesApi}/${issue.number}`, '--input', '-', '--jq', '.html_url'], JSON.stringify(data)))
}
else {
  console.log('Production realtime check passed. No open monitor incident.')
}
