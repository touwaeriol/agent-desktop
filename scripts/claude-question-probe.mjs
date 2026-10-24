/**
 * Manual regression probe for Claude Code's native question tool (`AskUserQuestion`).
 *
 * Drives the real `ClaudeCodeEngine` (official Claude Agent SDK + the installed `claude` CLI),
 * prints the questions the desktop would show, answers them, and checks that Claude continues with
 * the answer. Not part of `npm test`: it needs a logged-in Claude Code CLI, network and one real
 * model turn.
 *
 *   node scripts/claude-question-probe.mjs
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import esbuild from 'esbuild'

const repo = path.resolve(import.meta.dirname, '..')
// The SDK is a workspace dependency, so the bundle has to sit inside the repo to resolve it.
const out = path.join(repo, 'apps/desktop', '.claude-probe-' + process.pid + '.cjs')
esbuild.buildSync({
  entryPoints: [path.join(repo, 'apps/desktop/src/main/agent/claude-engine.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external'
})
const { ClaudeCodeEngine } = createRequire(import.meta.url)(out)
rmSync(out, { force: true })

const binary = path.join(
  process.env.APPDATA ?? '',
  'npm',
  'node_modules',
  '@anthropic-ai',
  'claude-code',
  'bin',
  process.platform === 'win32' ? 'claude.exe' : 'claude'
)
const cwd = process.env.PROBE_CWD ?? mkdtempSync(path.join(tmpdir(), 'prophey-claude-cwd-'))
writeFileSync(path.join(cwd, 'README.md'), '# probe\nA scratch directory for the Claude question probe.\n')

const asked = []
const engine = new ClaudeCodeEngine({
  binary,
  onStatus(status) {
    if (status.model) console.log('[probe] model', status.model.name ?? status.model.id)
  },
  onEvent() {},
  onSettled() {
    console.log('[probe] settled')
  },
  async ask(questions, tool) {
    asked.push({ questions, tool })
    console.log('[probe] question from', tool, JSON.stringify(questions, null, 1))
    return {
      cancelled: false,
      answers: questions.map((question) => ({
        question: question.question,
        selected: question.options?.[1]?.label ? [question.options[1].label] : [],
        other: question.options?.length ? '' : 'probe answer'
      }))
    }
  }
})

const timer = setTimeout(() => {
  engine.stop()
  console.log('[probe] TIMEOUT; asks:', asked.length)
  process.exit(2)
}, 240_000)

try {
  await engine.start(cwd)
  console.log('[probe] session', engine.state().sessionFile ?? '(new)')
  const result = await engine.prompt(
    '在开始之前，先用 AskUserQuestion 工具向我提问（不要自己假设）：' +
      '1）输出用中文还是英文？2）回答要多详细？每个问题给两个选项。'
  )
  if (!result.ok) throw new Error(result.error ?? 'prompt rejected')
  await engine.waitForSettle(180_000)
  clearTimeout(timer)
  const askUserQuestion = asked.filter((entry) => entry.tool === 'AskUserQuestion')
  const answer = (await engine.lastAssistantText()) ?? ''
  console.log('[probe] asks:', asked.length, '| AskUserQuestion:', askUserQuestion.length, '| settled:', !engine.busy())
  console.log('[probe] model said:', answer.slice(0, 300) || '(nothing)')
  process.exit(askUserQuestion.length > 0 && !engine.busy() ? 0 : 1)
} catch (error) {
  clearTimeout(timer)
  console.log('[probe] FAILED', String(error))
  console.log(engine.stderrTail?.()?.slice(-800) ?? '')
  process.exit(1)
}
