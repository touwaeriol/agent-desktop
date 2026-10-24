/**
 * Manual regression probe for Codex's native question tool (`request_user_input`).
 *
 * It drives the real `CodexEngine` against the installed `codex app-server`, prints the questions
 * the desktop would show, answers them, and checks that Codex continues with the answer. Not part
 * of `npm test`: it needs a logged-in Codex CLI, network (the app's system proxy is inherited from
 * the current environment) and one real model turn.
 *
 *   node scripts/codex-question-probe.mjs
 *   CODEX_HOME=... PROBE_CWD=... node scripts/codex-question-probe.mjs
 *
 * Background: `request_user_input` is experimental in codex-cli 0.163 and needs *both* overrides
 *   -c tools.experimental_request_user_input.enabled=true
 *   -c features.default_mode_request_user_input=true
 * Without the second one the tool is offered to the model but fails with
 * `request_user_input is unavailable in Default mode` (seen in codex_core::tools::router).
 * The request itself arrives as `item/tool/requestUserInput` even though the client declares
 * `capabilities.experimentalApi = false`.
 */
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import esbuild from 'esbuild'

const repo = path.resolve(import.meta.dirname, '..')
const out = path.join(mkdtempSync(path.join(tmpdir(), 'prophey-codex-probe-')), 'codex-engine.cjs')
esbuild.buildSync({
  entryPoints: [path.join(repo, 'apps/desktop/src/main/agent/codex-engine.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external'
})
const { CodexEngine } = createRequire(import.meta.url)(out)

const codexScript = path.join(
  process.env.APPDATA ?? '',
  'npm',
  'node_modules',
  '@openai',
  'codex',
  'bin',
  'codex.js'
)
const cwd = process.env.PROBE_CWD ?? mkdtempSync(path.join(tmpdir(), 'prophey-codex-cwd-'))
writeFileSync(path.join(cwd, 'README.md'), '# probe\nA scratch directory for the Codex question probe.\n')

const asked = []
let assistant = ''
const engine = new CodexEngine({
  binary: process.execPath,
  script: codexScript,
  questions: () => true,
  onStatus(status) {
    if (status.model) console.log('[probe] model', status.model.id)
  },
  onEvent(event) {
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') return
    const text = (event.message.content ?? [])
      .map((block) => block?.text ?? '')
      .join('')
      .trim()
    if (text) assistant = text
  },
  onSettled() {
    console.log('[probe] settled')
  },
  async ask(questions, tool) {
    asked.push({ questions, tool })
    console.log('[probe] question from', tool, JSON.stringify(questions, null, 1))
    // Prefer the second option of every question so the answer is visibly different from option 0.
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
  console.log('[probe] thread', engine.state().sessionFile)
  const result = await engine.prompt(
    '在开始之前，先用 request_user_input 工具向我提问（不要自己假设）：' +
      '1）输出用中文还是英文？2）回答要多详细？每个问题给两个选项。'
  )
  if (!result.ok) throw new Error(result.error ?? 'prompt rejected')
  await engine.waitForSettle(180_000)
  clearTimeout(timer)
  console.log('[probe] asks:', asked.length, '| settled:', !engine.busy())
  console.log('[probe] model said:', assistant.slice(0, 300) || '(nothing)')
  process.exit(asked.length > 0 && !engine.busy() ? 0 : 1)
} catch (error) {
  clearTimeout(timer)
  console.log('[probe] FAILED', String(error))
  console.log(engine.stderrTail?.()?.slice(-800) ?? '')
  process.exit(1)
}
