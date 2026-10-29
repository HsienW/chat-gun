import { AgentId } from '@/types/agents';

/** The two product entries shown on the homepage and in the mode switcher. */
export type EntryId = 'gun_chat' | 'gun_shop';

/** Where the app currently is; `home` has no target assistant. */
export type EntryState = 'home' | EntryId;

export interface EntryDefinition {
  id: EntryId;
  name: string;
  subtitle: string;
  /** One-line introduction on the workspace welcome screen. */
  summary: string;
  /** Short points on the homepage card, one line each. */
  highlights: readonly string[];
  /** Only Gun Chat offers the explicit deep research toggle. */
  supportsDeepResearch: boolean;
}

export const HOMEPAGE_TITLE = 'Chat Gun AI Agent';
export const HOMEPAGE_GREETING = 'Where would you like to begin?';
export const HOMEPAGE_HINT = 'Try Chatting with It to Get an Answer';

/** Files in `public/` are served under the Vite base (`/app/`), not under `public/`. */
export const LOGO_SRC = `${import.meta.env.BASE_URL}logo-icon.svg`;

export const ENTRY_DEFINITIONS: readonly EntryDefinition[] = [
  {
    id: 'gun_chat',
    name: 'Gun Chat',
    subtitle: 'Generative AI Agent',
    summary: '日常問答、寫作與翻譯直接開聊；需要查資料時開啟深度研究，搜尋網路並整理出處，也能上傳圖片分析。',
    highlights: [
      '日常問答、寫作、翻譯與摘要',
      '深度研究：搜尋網路並整理出處',
      '深度研究可上傳圖片一起分析',
    ],
    supportsDeepResearch: true,
  },
  {
    id: 'gun_shop',
    name: 'Gun Shop',
    subtitle: 'Shop AI Assistant',
    summary: '查詢商品並依需求推薦，解答退換貨與配送政策並附上出處；取消訂單或申請退款前會先請你核准（示範用訂單）。',
    highlights: [
      '商品查詢與個人化推薦',
      '退換貨政策問答，附引用出處',
      '退款、取消訂單需你核准（模擬）',
    ],
    supportsDeepResearch: false,
  },
];

export function isEntryId(value: string): value is EntryId {
  return ENTRY_DEFINITIONS.some((entry) => entry.id === value);
}

export function getEntryDefinition(entry: EntryId): EntryDefinition {
  const definition = ENTRY_DEFINITIONS.find((item) => item.id === entry);
  if (!definition) {
    throw new Error(`Unknown entry: ${entry}`);
  }
  return definition;
}

/** The target assistant of an entry; the user's toggle is the only routing input. */
export function resolveEntryAssistant(entry: EntryId, deepResearchEnabled: boolean): AgentId {
  if (entry === 'gun_shop') return AgentId.SHOPPING_ASSISTANT;
  return deepResearchEnabled ? AgentId.DEEP_RESEARCHER : AgentId.CHATBOT;
}

/** Fails closed: the homepage or an unknown value has no target and falls back to no graph. */
export function resolveTargetAssistant(
  entry: string,
  deepResearchEnabled: boolean
): AgentId | null {
  return isEntryId(entry) ? resolveEntryAssistant(entry, deepResearchEnabled) : null;
}
