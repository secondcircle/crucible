import type { Question, Questions, SystemOneResult } from '@typesafe-ai/sdk'
import type { JudgeRequest, SystemOneCall } from './judge.ts'

// The fake flavor's judge: it answers every question without leaving the
// machine, so a fake launch walks the whole path a firing takes and bills
// nothing. A choice goes to its first option, which a rule author lists as
// the one the rule exists to catch.

const LEAD = 0.86

function answer(question: Question): unknown {
  if (question.type === 'noul') return { type: 'noul', noul: LEAD }
  if (question.type === 'choice') {
    const options = Object.keys(question.criteria)
    const rest = options.length > 1 ? (1 - LEAD) / (options.length - 1) : 0
    return {
      type: 'choice',
      choice: options[0],
      confidence: LEAD,
      probabilities: Object.fromEntries(options.map((option, i) => [option, i === 0 ? LEAD : rest]))
    }
  }
  const levels = question.criteria.length
  return {
    type: 'score',
    score: levels - 1,
    confidence: LEAD,
    legend: Object.fromEntries(question.criteria.map((text, i) => [i, text])),
    probabilities: Object.fromEntries(question.criteria.map((_, i) => [i, i === levels - 1 ? LEAD : (1 - LEAD) / (levels - 1)]))
  }
}

export const cannedCall: SystemOneCall = async (request: JudgeRequest) => {
  const tokens = Math.ceil(JSON.stringify(request.state).length / 4 + JSON.stringify(request.questions).length / 4)
  return {
    model: request.model,
    answers: Object.fromEntries(Object.entries(request.questions).map(([name, question]) => [name, answer(question)])),
    usage: { input_tokens: tokens, output_tokens: 0 }
  } as SystemOneResult<Questions>
}
