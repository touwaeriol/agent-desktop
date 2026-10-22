/**
 * `ask_user_question` — asks the Agent Desktop user one or more questions and waits for the answer.
 *
 * The tool itself has no timeout: the bridge holds the request until the user answers, the run is
 * aborted, or the app closes. Cancellation arrives through the MCP `notifications/cancelled` signal.
 */

const MAX_OPTIONS = 8
const MAX_QUESTIONS = 6

export const askUserQuestion = {
  name: 'ask_user_question',
  title: 'Ask the user a question',
  description:
    'Ask the user one or more questions in the Agent Desktop app and wait for the answer. ' +
    'Each question supports single choice, multiple choice (multiSelect: true), and free-form input ' +
    'the user can type themselves. Questions are shown one at a time, in order. ' +
    'Use this when you need a decision, a preference, or missing information before continuing.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        description: 'Questions to ask, answered in order.',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The full question text shown to the user.'
            },
            header: {
              type: 'string',
              description: 'Short label (a few words) shown above the question.'
            },
            multiSelect: {
              type: 'boolean',
              description: 'Allow selecting more than one option. Defaults to false.'
            },
            options: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_OPTIONS,
              description: 'Choices offered to the user. The user can always type their own answer.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Short choice text.' },
                  description: { type: 'string', description: 'Optional explanation of the choice.' }
                },
                required: ['label'],
                additionalProperties: false
              }
            }
          },
          required: ['question'],
          additionalProperties: false
        }
      }
    },
    required: ['questions'],
    additionalProperties: false
  },

  async call(args, context) {
    const questions = normalizeQuestions(args)
    if (questions.length === 0) {
      return {
        content: [{ type: 'text', text: 'ask_user_question 需要至少一个问题。' }],
        isError: true
      }
    }
    let result
    try {
      result = await context.post('/ask', { tool: askUserQuestion.name, questions }, context.signal)
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `无法在桌面端提问：${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      }
    }
    if (!result || result.cancelled) {
      return {
        content: [
          {
            type: 'text',
            text: `用户取消了这次提问，没有提供答案${result?.reason ? `（${result.reason}）` : ''}。请据此决定下一步，不要假设答案。`
          }
        ]
      }
    }
    const answers = Array.isArray(result.answers) ? result.answers : []
    return {
      content: [
        {
          type: 'text',
          text: `用户已回答 ${answers.filter((answer) => !answer.skipped).length}/${answers.length} 个问题：\n${formatAnswers(answers)}`
        }
      ]
    }
  }
}

function normalizeQuestions(args) {
  const raw = Array.isArray(args?.questions)
    ? args.questions
    : typeof args?.question === 'string'
      ? [{ question: args.question, options: args.options, multiSelect: args.multiSelect }]
      : []
  const questions = []
  for (const entry of raw.slice(0, MAX_QUESTIONS)) {
    if (!entry || typeof entry.question !== 'string' || !entry.question.trim()) continue
    const options = Array.isArray(entry.options)
      ? entry.options
          .filter((option) => option && typeof option.label === 'string' && option.label.trim())
          .slice(0, MAX_OPTIONS)
          .map((option) => ({
            label: option.label.trim(),
            ...(typeof option.description === 'string' && option.description.trim()
              ? { description: option.description.trim() }
              : {})
          }))
      : []
    questions.push({
      question: entry.question.trim(),
      ...(typeof entry.header === 'string' && entry.header.trim()
        ? { header: entry.header.trim() }
        : {}),
      ...(entry.multiSelect === true ? { multiSelect: true } : {}),
      ...(options.length > 0 ? { options } : {})
    })
  }
  return questions
}

function formatAnswers(answers) {
  const lines = []
  answers.forEach((answer, index) => {
    const tag = answer.header ? `[${answer.header}] ` : ''
    lines.push(`${index + 1}. ${tag}${answer.question}`)
    if (answer.skipped) {
      lines.push('   → （用户跳过）')
      return
    }
    if (Array.isArray(answer.selected) && answer.selected.length > 0) {
      lines.push(`   → ${answer.selected.join('、')}`)
    }
    if (answer.other) lines.push(`   补充：${answer.other}`)
    if ((!answer.selected || answer.selected.length === 0) && !answer.other) {
      lines.push('   → （用户未填写）')
    }
  })
  return lines.join('\n')
}
