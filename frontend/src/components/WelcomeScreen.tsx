import { InputForm } from './InputForm';
import type { ProcessedImageAttachment } from '@/lib/image-upload';

interface WelcomeScreenProps {
  handleSubmit: (
    submittedInputValue: string,
    effort: string,
    model: string,
    agentId: string,
    attachments: ProcessedImageAttachment[]
  ) => void;
  onCancel: () => void;
  isLoading: boolean;
  selectedAgent: string;
  onAgentChange: (agentId: string) => void;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  handleSubmit,
  onCancel,
  isLoading,
  selectedAgent,
  onAgentChange,
}) => (
  <div className="flex flex-col items-center justify-center text-center px-4 flex-1 mb-16 w-full max-w-3xl mx-auto gap-4">
    <div className="flex flex-col items-center gap-6">
      <img
        src="public/logo-icon.svg"
        alt="Chat Logo"
        className="h-28 w-28 rounded-2xl border border-[#E7D9C1]/20 object-cover shadow-xl shadow-[#7A1E1E]/20"
      />
      <div>
        <h1 className="text-5xl md:text-6xl font-semibold text-[#F8F1E7] mb-3">
          ChatGun AI Agent
        </h1>
        <p className="text-xl md:text-2xl text-[#E7D9C1]/80">
          Where would you like to begin?
        </p>
      </div>
    </div>
    <div className="w-full mt-4">
      <InputForm
        onSubmit={handleSubmit}
        isLoading={isLoading}
        onCancel={onCancel}
        hasHistory={false}
        selectedAgent={selectedAgent}
        onAgentChange={onAgentChange}
      />
    </div>
    <p className="text-xs text-[#E7D9C1]/50">
      Try Chatting with It to Get an Answer
    </p>
  </div>
);
