import {
  AssistAnswerMode,
  AssistCompositionPolicy,
  AssistIntentClass
} from '../../shared/contracts'

export type InterviewQuestionFlavor =
  | 'personal_daily'
  | 'candidate_specific'
  | 'technical_general'
  | 'mixed'

const PERSONAL_DAILY_MARKERS = [
  /\b(how (?:was|is|has) your day|how your day went|how did your day go)\b/i,
  /\b(how do you spend your day|walk me through your day|describe your day)\b/i,
  /\b(typical day|a day in your life|daily routine|workday)\b/i,
  /\b(gunun nasil gecti|gunun nasil geciyor|bir gunun nasil gecer)\b/i
]

const PERSONAL_MARKERS = [
  /\b(tell me about yourself|walk me through your|your background|your experience)\b/i,
  /\btell me about your\b/i,
  /\b(in your experience|you worked on|you built|you led|you shipped)\b/i,
  /\b(my project|my experience|my role|our project)\b/i,
  /\b(resume|cv|linkedin|github)\b/i
]

const GENERAL_MARKERS = [
  /\b(what is|what are|explain|define|difference between|compare)\b/i,
  /\b(how does|how do|why does|when should)\b/i,
  /\b(nlp|transformer|bert|llm|embedding|tokenization)\b/i,
  /\b(system design|microservice|kubernetes|database|latency|throughput)\b/i,
  /\b(algorithm|complexity|big o|thread|concurrency|cache)\b/i
]

function score(text: string, patterns: RegExp[]): number {
  let hits = 0
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      hits += 1
    }
  }
  return hits
}

export function classifyInterviewQuestionFlavor(rawText: string): InterviewQuestionFlavor {
  const text = String(rawText || '').trim()
  if (!text) {
    return 'mixed'
  }

  const dailyHits = score(text, PERSONAL_DAILY_MARKERS)
  const personalHits = score(text, PERSONAL_MARKERS)
  const generalHits = score(text, GENERAL_MARKERS)

  if (dailyHits > 0) {
    return 'personal_daily'
  }

  if (personalHits > 0 && generalHits > 0) {
    return 'mixed'
  }

  if (generalHits > 0 && personalHits === 0) {
    return 'technical_general'
  }

  if (personalHits > 0) {
    return 'candidate_specific'
  }

  // Default interview questions are usually mixed when no clear marker exists.
  return 'mixed'
}

export function classifyAssistIntent(rawText: string): AssistIntentClass {
  const flavor = classifyInterviewQuestionFlavor(rawText)
  if (flavor === 'personal_daily') {
    return 'candidate_specific'
  }
  return flavor
}

export function isPersonalDailyQuestion(rawText: string): boolean {
  return classifyInterviewQuestionFlavor(rawText) === 'personal_daily'
}

export function resolveAssistAnswerMode(
  intentClass: AssistIntentClass,
  compositionPolicy: AssistCompositionPolicy
): AssistAnswerMode {
  if (compositionPolicy === 'profile_only') {
    return 'profile_only'
  }
  if (compositionPolicy === 'general_then_profile') {
    return 'general_first'
  }

  if (intentClass === 'candidate_specific') {
    return 'profile_first'
  }
  if (intentClass === 'technical_general') {
    return 'general_first'
  }
  return 'balanced'
}
