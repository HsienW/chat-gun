import { describe, expect, it } from 'vitest';

import { AgentId } from '@/types/agents';
import {
  ENTRY_DEFINITIONS,
  getEntryDefinition,
  isEntryId,
  resolveTargetAssistant,
} from './entries';

describe('resolveTargetAssistant', () => {
  it('sends Gun Chat to chatbot while deep research is off', () => {
    expect(resolveTargetAssistant('gun_chat', false)).toBe(AgentId.CHATBOT);
  });

  it('sends Gun Chat to deep_researcher while deep research is on', () => {
    expect(resolveTargetAssistant('gun_chat', true)).toBe(AgentId.DEEP_RESEARCHER);
  });

  it('sends Gun Shop to shopping_assistant whatever the toggle says', () => {
    expect(resolveTargetAssistant('gun_shop', false)).toBe(AgentId.SHOPPING_ASSISTANT);
    expect(resolveTargetAssistant('gun_shop', true)).toBe(AgentId.SHOPPING_ASSISTANT);
  });

  it('has no target on the homepage or for an unknown value', () => {
    expect(resolveTargetAssistant('home', false)).toBeNull();
    expect(resolveTargetAssistant('home', true)).toBeNull();
    expect(resolveTargetAssistant('math_agent', false)).toBeNull();
    expect(resolveTargetAssistant('', true)).toBeNull();
  });

  it('never resolves to a graph that is not exposed in the UI', () => {
    const targets = new Set(
      ['home', ...ENTRY_DEFINITIONS.map((entry) => entry.id), 'unknown'].flatMap((entry) =>
        [false, true].map((deepResearch) => resolveTargetAssistant(entry, deepResearch))
      )
    );
    expect(targets).toEqual(
      new Set([AgentId.CHATBOT, AgentId.DEEP_RESEARCHER, AgentId.SHOPPING_ASSISTANT, null])
    );
  });
});

describe('entry definitions', () => {
  it('defines the two entries with their subtitles', () => {
    expect(ENTRY_DEFINITIONS.map(({ name, subtitle }) => [name, subtitle])).toEqual([
      ['Gun Chat', 'Generative AI Agent'],
      ['Gun Shop', 'Shop AI Assistant'],
    ]);
    expect(getEntryDefinition('gun_chat').supportsDeepResearch).toBe(true);
    expect(getEntryDefinition('gun_shop').supportsDeepResearch).toBe(false);
  });

  it('gives every entry two or three short highlights for the homepage card', () => {
    for (const entry of ENTRY_DEFINITIONS) {
      expect(entry.highlights.length).toBeGreaterThanOrEqual(2);
      expect(entry.highlights.length).toBeLessThanOrEqual(3);
      // Short enough to stay on one line in a card.
      for (const highlight of entry.highlights) {
        expect(highlight.length).toBeLessThanOrEqual(16);
      }
    }
  });

  it('gives every entry a one-line introduction of at least 30 characters', () => {
    for (const entry of ENTRY_DEFINITIONS) {
      expect(entry.summary.length).toBeGreaterThanOrEqual(30);
    }
  });

  it('recognises only known entry ids', () => {
    expect(isEntryId('gun_chat')).toBe(true);
    expect(isEntryId('gun_shop')).toBe(true);
    expect(isEntryId('home')).toBe(false);
    expect(isEntryId('chatbot')).toBe(false);
  });
});
