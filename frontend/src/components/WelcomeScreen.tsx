import { InputForm, type DeepResearchToggle, type SubmitHandler } from './InputForm';
import { LOGO_SRC, type EntryDefinition } from '@/lib/entries';

interface WelcomeScreenProps {
  entry: EntryDefinition;
  handleSubmit: SubmitHandler;
  onCancel: () => void;
  isLoading: boolean;
  targetAgentId: string;
  deepResearch?: DeepResearchToggle;
  onNewConversation: () => void;
  newConversationDisabled: boolean;
}

/** The empty state of an entry workspace, before the first message. */
export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  entry,
  handleSubmit,
  onCancel,
  isLoading,
  targetAgentId,
  deepResearch,
  onNewConversation,
  newConversationDisabled,
}) => (
  <div className="flex flex-col items-center justify-center text-center px-4 flex-1 mb-16 w-full max-w-3xl mx-auto gap-4">
    <div className="flex flex-col items-center gap-6">
      <img
        src={LOGO_SRC}
        alt="Chat Logo"
        className="h-28 w-28 rounded-2xl border border-[#E7D9C1]/20 object-cover shadow-xl shadow-[#7A1E1E]/20"
      />
      <div>
        <h1 className="text-5xl md:text-6xl font-semibold text-[#F8F1E7] mb-3">
          {entry.name}
        </h1>
        <p className="text-xl md:text-2xl text-[#E7D9C1]/80">{entry.subtitle}</p>
        <p className="mt-3 text-sm text-[#E7D9C1]/60">{entry.summary}</p>
      </div>
    </div>
    <div className="w-full mt-4">
      <InputForm
        onSubmit={handleSubmit}
        isLoading={isLoading}
        onCancel={onCancel}
        hasHistory={false}
        targetAgentId={targetAgentId}
        deepResearch={deepResearch}
        onNewConversation={onNewConversation}
        newConversationDisabled={newConversationDisabled}
      />
    </div>
  </div>
);
