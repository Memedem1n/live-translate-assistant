import { describe, expect, it } from 'vitest'
import {
  classifyAssistIntent,
  classifyInterviewQuestionFlavor,
  resolveAssistAnswerMode
} from './assistIntent'

describe('classifyAssistIntent', () => {
  it('detects technical general questions', () => {
    const intent = classifyAssistIntent('Explain transformer models and tokenization in NLP.')
    expect(intent).toBe('technical_general')
  })

  it('detects candidate specific questions', () => {
    const intent = classifyAssistIntent('Tell me about your experience building real-time systems.')
    expect(intent).toBe('candidate_specific')
  })

  it('treats technical-weighted mixed questions as technical_general', () => {
    const intent = classifyAssistIntent('In your experience, how does Kubernetes improve reliability?')
    expect(intent).toBe('technical_general')
  })

  it('maps personal daily prompts to candidate-specific intent', () => {
    const intent = classifyAssistIntent('I wonder how your day went as a software engineer.')
    expect(intent).toBe('candidate_specific')
  })

  it('treats direct experience questions as candidate specific', () => {
    const intent = classifyAssistIntent('Have you used Kafka in production before?')
    expect(intent).toBe('candidate_specific')
  })

  it('treats familiarity questions as candidate specific', () => {
    const intent = classifyAssistIntent('Are you familiar with Terraform?')
    expect(intent).toBe('candidate_specific')
  })
})

describe('classifyInterviewQuestionFlavor', () => {
  it('detects personal daily prompts', () => {
    const flavor = classifyInterviewQuestionFlavor('Walk me through your typical day at work.')
    expect(flavor).toBe('personal_daily')
  })
})

describe('resolveAssistAnswerMode', () => {
  it('enforces profile_only policy', () => {
    expect(resolveAssistAnswerMode('technical_general', 'profile_only')).toBe('profile_only')
  })

  it('maps auto policy using intent', () => {
    expect(resolveAssistAnswerMode('candidate_specific', 'auto')).toBe('profile_first')
    expect(resolveAssistAnswerMode('technical_general', 'auto')).toBe('general_first')
    expect(resolveAssistAnswerMode('mixed', 'auto')).toBe('balanced')
  })
})
