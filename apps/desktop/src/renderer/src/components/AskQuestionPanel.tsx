import { useEffect, useMemo, useRef, useState } from 'react'
import type { AskAnswer, AskQuestion, AskRequest } from '@shared/types'
import { CheckIcon, CloseIcon, QuestionIcon } from './Icons'

interface Draft {
  selected: string[]
  other: string
  skipped: boolean
}

function emptyDraft(): Draft {
  return { selected: [], other: '', skipped: false }
}

function draftAnswered(draft: Draft): boolean {
  return draft.skipped || draft.selected.length > 0 || draft.other.trim().length > 0
}

function draftSummary(draft: Draft, secret = false): string {
  if (draft.skipped) return '已跳过'
  if (secret) return draftAnswered(draft) ? '已填写' : ''
  const parts = [...draft.selected]
  if (draft.other.trim()) parts.push(draft.other.trim())
  return parts.join('、')
}

function toAnswer(question: AskQuestion, draft: Draft): AskAnswer {
  return {
    question: question.question,
    ...(question.header ? { header: question.header } : {}),
    selected: draft.skipped ? [] : draft.selected,
    ...(draft.other.trim() && !draft.skipped ? { other: draft.other.trim() } : {}),
    ...(draft.skipped ? { skipped: true } : {})
  }
}

export function AskQuestionPanel({
  request,
  queued = 0,
  onSubmit,
  onCancel
}: {
  request: AskRequest
  queued?: number
  onSubmit: (answers: AskAnswer[]) => void
  onCancel: () => void
}): React.JSX.Element {
  const questions = request.questions
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => emptyDraft()))
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const current = questions[index]
  const draft = drafts[index] ?? emptyDraft()
  const last = index === questions.length - 1

  useEffect(() => {
    setIndex(0)
    setDrafts(questions.map(() => emptyDraft()))
  }, [request.id, questions])

  useEffect(() => {
    const active = document.activeElement as HTMLTextAreaElement | null
    const composing = Boolean(active?.closest('.composer') && active.value?.trim())
    if (!composing) inputRef.current?.focus()
  }, [index, request.id])

  const updateDraft = (update: (draft: Draft) => Draft): void => {
    setDrafts((prev) => {
      const copy = prev.slice()
      copy[index] = update(copy[index] ?? emptyDraft())
      return copy
    })
  }

  const toggleOption = (label: string): void => {
    updateDraft((entry) => {
      if (current.multiSelect) {
        return {
          ...entry,
          selected: entry.selected.includes(label)
            ? entry.selected.filter((value) => value !== label)
            : [...entry.selected, label],
          skipped: false
        }
      }
      return { ...entry, selected: [label], other: '', skipped: false }
    })
  }

  const typeAnswer = (value: string): void => {
    updateDraft((entry) => ({
      ...entry,
      other: value,
      skipped: false,
      ...(current.multiSelect ? {} : { selected: [] })
    }))
  }

  const submit = (): void => {
    onSubmit(questions.map((question, position) => toAnswer(question, drafts[position] ?? emptyDraft())))
  }

  const advance = (): void => {
    if (last) submit()
    else setIndex(index + 1)
  }

  const skip = (): void => {
    const skippedDraft: Draft = { selected: [], other: '', skipped: true }
    if (last) {
      onSubmit(
        questions.map((question, position) =>
          toAnswer(question, position === index ? skippedDraft : (drafts[position] ?? emptyDraft()))
        )
      )
      return
    }
    setDrafts((prev) => {
      const copy = prev.slice()
      copy[index] = skippedDraft
      return copy
    })
    setIndex(index + 1)
  }

  const answeredCount = useMemo(
    () => drafts.filter((entry) => draftAnswered(entry)).length,
    [drafts]
  )

  const canContinue = draftAnswered(draft)

  return (
    <div className="ask-panel" ref={rootRef} role="dialog" aria-label="Agent 提问">
      <header className="ask-panel-head">
        <span className="ask-icon">
          <QuestionIcon size={13} />
        </span>
        <div className="ask-panel-title">
          <strong>需要你的确认</strong>
          <span>
            {index + 1} / {questions.length}
            {questions.length > 1 ? ` · 已填 ${answeredCount}` : ''}
            {queued > 0 ? ` · 还有 ${queued} 个排队` : ''}
            {request.tool ? ` · ${request.tool}` : ''}
          </span>
        </div>
        {questions.length > 1 && (
          <div className="ask-steps">
            {questions.map((question, position) => (
              <button
                key={`${question.question}-${position}`}
                className={`ask-step ${position === index ? 'active' : ''} ${
                  draftAnswered(drafts[position] ?? emptyDraft()) ? 'answered' : ''
                }`}
                onClick={() => setIndex(position)}
                title={draftSummary(drafts[position] ?? emptyDraft(), question.secret) || question.question}
              >
                {position + 1}
              </button>
            ))}
          </div>
        )}
        <button className="icon-btn" onClick={onCancel} title="取消这次提问 (Esc)">
          <CloseIcon size={12} />
        </button>
      </header>

      <div className="ask-panel-body">
        <div className="ask-question-row">
          {current.header && <span className="ask-tag">{current.header}</span>}
          <span className="ask-question">{current.question}</span>
          {current.multiSelect && <span className="ask-multi">可多选</span>}
          {current.secret && <span className="ask-multi">不会回显</span>}
        </div>

        {(current.options?.length ?? 0) > 0 && (
          <div className="ask-options">
            {current.options!.map((option) => {
              const active = draft.selected.includes(option.label)
              return (
                <button
                  key={option.label}
                  className={`ask-option ${active ? 'active' : ''}`}
                  onClick={() => toggleOption(option.label)}
                  title={option.description}
                >
                  <span className={`ask-check ${current.multiSelect ? 'square' : 'round'}`}>
                    {active && <CheckIcon size={9} />}
                  </span>
                  <span className="ask-option-main">
                    <span className="ask-option-label">{option.label}</span>
                    {option.description && (
                      <span className="ask-option-desc">{option.description}</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <footer className="ask-panel-foot">
        <div className={`ask-input-row ${draft.other.trim() ? 'filled' : ''}`}>
          <span className="ask-input-icon">
            <CheckIcon size={10} />
          </span>
          <input
            ref={inputRef}
            value={draft.other}
            type={current.secret ? 'password' : 'text'}
            placeholder={current.options?.length ? '或直接输入答案' : '输入你的答案'}
            spellCheck={!current.secret}
            onChange={(event) => typeAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                if (canContinue) advance()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                onCancel()
              }
            }}
          />
        </div>
        <div className="ask-foot-actions">
          <button className="ghost ask-mini" onClick={skip} title="跳过这个问题">
            跳过
          </button>
          {index > 0 && (
            <button className="ghost ask-mini" onClick={() => setIndex(index - 1)}>
              上一步
            </button>
          )}
          <button className="primary ask-mini" onClick={advance} disabled={!canContinue}>
            {last ? '提交' : '下一步'}
          </button>
        </div>
      </footer>
    </div>
  )
}
