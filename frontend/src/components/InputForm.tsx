import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  Cpu,
  ImagePlus,
  Search,
  Send,
  SquarePen,
  StopCircle,
  X,
  Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { FRONTEND_ERROR_MESSAGES } from '@/lib/error-messages';
import {
  getImageUploadConfig,
  ImageUploadItem,
  preprocessImageFile,
  ProcessedImageAttachment,
  validateImageFile,
} from '@/lib/image-upload';
import { isValidModelId } from '@/lib/models';
import { AgentId } from '@/types/agents';
import { AVAILABLE_MODELS, DEFAULT_MODEL } from '@/types/models';

export type SubmitHandler = (
  inputValue: string,
  effort: string,
  model: string,
  attachments: ProcessedImageAttachment[]
) => void;

/** The explicit, user-controlled deep research switch of Gun Chat. */
export interface DeepResearchToggle {
  enabled: boolean;
  locked: boolean;
  onChange: (enabled: boolean) => void;
}

const DEEP_RESEARCH_LABELS = {
  label: '深度研究',
  lockedHint: '回覆進行中或等待澄清時無法切換深度研究',
} as const;

interface InputFormProps {
  onSubmit: SubmitHandler;
  onCancel: () => void;
  isLoading: boolean;
  hasHistory: boolean;
  /** The assistant the next message goes to, derived from the entry and the toggle. */
  targetAgentId: string;
  deepResearch?: DeepResearchToggle;
  onNewConversation: () => void;
  newConversationDisabled: boolean;
}

export const InputForm: React.FC<InputFormProps> = ({
  onSubmit,
  onCancel,
  isLoading,
  hasHistory,
  targetAgentId,
  deepResearch,
  onNewConversation,
  newConversationDisabled,
}) => {
  const [internalInputValue, setInternalInputValue] = useState('');
  const [effort, setEffort] = useState('medium');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [imageItems, setImageItems] = useState<ImageUploadItem[]>([]);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadConfigRef = useRef(getImageUploadConfig());
  const uploadConfig = uploadConfigRef.current;
  const imageItemsRef = useRef<ImageUploadItem[]>([]);
  const activeUploadCountRef = useRef(0);
  const unmountedRef = useRef(false);
  const supportsImageUpload = targetAgentId === AgentId.DEEP_RESEARCHER;
  const deepResearchHintId = useId();

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const patchImageItem = useCallback((id: string, patch: Partial<ImageUploadItem>) => {
    if (unmountedRef.current) return;

    const updatedItems = imageItemsRef.current.map((item) =>
      item.id === id ? { ...item, ...patch } : item
    );
    imageItemsRef.current = updatedItems;
    setImageItems(updatedItems);
  }, []);

  const drainUploadQueue = useCallback(() => {
    while (activeUploadCountRef.current < uploadConfig.maxConcurrent) {
      const nextItem = imageItemsRef.current.find((item) => item.status === 'queued');
      if (!nextItem) return;

      activeUploadCountRef.current += 1;
      patchImageItem(nextItem.id, { status: 'processing', error: undefined });

      void preprocessImageFile(nextItem.file, uploadConfig)
        .then((attachment) => {
          if (unmountedRef.current) return;
          patchImageItem(nextItem.id, { status: 'completed', attachment });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (unmountedRef.current) return;
          patchImageItem(nextItem.id, { status: 'failed', error: message });
          setPreflightError(`${nextItem.file.name}: ${message}`);
        })
        .finally(() => {
          activeUploadCountRef.current = Math.max(0, activeUploadCountRef.current - 1);
          if (unmountedRef.current) return;
          drainUploadQueue();
        });
    }
  }, [patchImageItem, uploadConfig]);

  useEffect(() => {
    imageItemsRef.current = imageItems;
    drainUploadQueue();
  }, [drainUploadQueue, imageItems]);

  const handleImageSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = '';

    if (!selectedFiles.length) return;

    const currentItems = imageItemsRef.current;
    const availableSlots = uploadConfig.maxFiles - currentItems.length;
    if (availableSlots <= 0) {
      setPreflightError(FRONTEND_ERROR_MESSAGES.imageUpload.tooManyImages(uploadConfig.maxFiles));
      return;
    }

    const acceptedFiles = selectedFiles.slice(0, availableSlots);
    if (selectedFiles.length > availableSlots) {
      setPreflightError(FRONTEND_ERROR_MESSAGES.imageUpload.remainingSlots(availableSlots));
    }

    const newItems: ImageUploadItem[] = acceptedFiles.map((file) => {
      const validationError = validateImageFile(file, uploadConfig);
      return {
        id: crypto.randomUUID(),
        file,
        status: validationError ? 'failed' : 'queued',
        error: validationError,
      };
    });

    const failedItems = newItems.filter((item) => item.status === 'failed');

    if (failedItems.length) {
      setPreflightError(
        failedItems
          .map(
            (item) =>
              `${item.file.name}: ${
                item.error ?? FRONTEND_ERROR_MESSAGES.imageUpload.invalidImage
              }`
          )
          .join('\n')
      );
    }

    const updatedItems = [...currentItems, ...newItems];
    imageItemsRef.current = updatedItems;
    setImageItems(updatedItems);
    drainUploadQueue();
  };

  const removeImageItem = (id: string) => {
    const updatedItems = imageItemsRef.current.filter((item) => item.id !== id);
    imageItemsRef.current = updatedItems;
    setImageItems(updatedItems);
  };

  const handleInternalSubmit = (event?: React.FormEvent) => {
    event?.preventDefault();
    const completedAttachments = imageItems
      .map((item) => item.attachment)
      .filter((attachment): attachment is ProcessedImageAttachment => Boolean(attachment));
    if (!internalInputValue.trim() && completedAttachments.length === 0) return;
    onSubmit(internalInputValue, effort, model, completedAttachments);
    setInternalInputValue('');
    imageItemsRef.current = [];
    setImageItems([]);
  };

  const handleModelChange = (value: string) => {
    if (isValidModelId(value)) {
      setModel(value);
    }
  };

  const handleInternalKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleInternalSubmit();
    }
  };

  const hasPendingUploads = imageItems.some(
    (item) => item.status === 'queued' || item.status === 'processing'
  );
  const hasFailedUploads = imageItems.some((item) => item.status === 'failed');
  const completedAttachmentCount = imageItems.filter((item) => item.status === 'completed').length;
  const canSubmitContent = internalInputValue.trim().length > 0 || completedAttachmentCount > 0;
  const isSubmitDisabled =
    !canSubmitContent || isLoading || hasPendingUploads || hasFailedUploads;
  const showEffortSelector = targetAgentId === AgentId.DEEP_RESEARCHER;

  const getModelIcon = (iconName: string, iconColor: string) => {
    switch (iconName) {
      case 'zap':
        return <Zap className={`h-4 w-4 mr-2 ${iconColor}`} />;
      case 'cpu':
        return <Cpu className={`h-4 w-4 mr-2 ${iconColor}`} />;
      default:
        return <Cpu className="h-4 w-4 mr-2 text-[#E7D9C1]" />;
    }
  };

  const controlClass =
    'flex flex-row gap-2 bg-card/90 border border-border text-[#E7D9C1] rounded-xl rounded-t-sm pl-2 pr-2 max-w-[100%] sm:max-w-[90%] shadow-sm';
  const selectContentClass =
    'bg-card border-border text-[#E7D9C1] cursor-pointer';
  const selectItemClass =
    'hover:bg-muted focus:bg-muted cursor-pointer';

  return (
    <form onSubmit={handleInternalSubmit} className="flex flex-col gap-2 p-3">
      {preflightError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-2xl border border-[#7A1E1E]/60 bg-[#211612] p-5 text-left shadow-2xl">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#E0A458]" />
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-[#F8F1E7]">
                  {FRONTEND_ERROR_MESSAGES.imageUpload.dialogTitle}
                </h2>
                <pre className="mt-3 max-h-60 whitespace-pre-wrap rounded-xl border border-[#5A4036] bg-[#160F0C] p-3 text-xs text-[#E7D9C1]">
                  {preflightError}
                </pre>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <Button
                type="button"
                className="rounded-xl bg-[#7A1E1E] text-[#F8F1E7] hover:bg-[#9F3434]"
                onClick={() => setPreflightError(null)}
              >
                {FRONTEND_ERROR_MESSAGES.imageUpload.close}
              </Button>
            </div>
          </div>
        </div>
      )}

      {supportsImageUpload && imageItems.length > 0 && (
        <div className="grid grid-cols-2 gap-2 px-2 sm:grid-cols-3">
          {imageItems.map((item) => (
            <div
              key={item.id}
              className="relative rounded-2xl border border-[#5A4036] bg-card/80 p-2 text-left"
            >
              <button
                type="button"
                className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-[#F8F1E7] hover:bg-muted"
                onClick={() => removeImageItem(item.id)}
                aria-label={FRONTEND_ERROR_MESSAGES.imageUpload.removeImageLabel(item.file.name)}
              >
                <X className="h-3 w-3" />
              </button>
              {item.attachment ? (
                <img
                  src={item.attachment.dataUrl}
                  alt={item.file.name}
                  className="h-24 w-full rounded-xl object-cover"
                />
              ) : (
                <div className="flex h-24 items-center justify-center rounded-xl bg-[#160F0C] text-xs text-[#E7D9C1]/70">
                  {FRONTEND_ERROR_MESSAGES.imageUpload.uploadingStatus[item.status]}
                </div>
              )}
              <div className="mt-2 truncate text-xs text-[#F8F1E7]">{item.file.name}</div>
              <div className="text-[11px] capitalize text-[#E7D9C1]/60">
                {FRONTEND_ERROR_MESSAGES.imageUpload.uploadingStatus[item.status]}
                {item.error ? `: ${item.error}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}

      <div
        className={`flex flex-row items-center gap-2 rounded-3xl rounded-bl-sm ${
          hasHistory ? 'rounded-br-sm' : ''
        } bg-card/95 border border-border px-4 py-3 text-[#F8F1E7] shadow-lg shadow-black/10`}
      >
        <Textarea
          value={internalInputValue}
          onChange={(event) => setInternalInputValue(event.target.value)}
          onKeyDown={handleInternalKeyDown}
          placeholder="輸入你的問題..."
          className="min-w-0 flex-1 resize-none border-0 bg-transparent py-2 text-[#F8F1E7] placeholder:text-[#E7D9C1]/45 focus:outline-none focus:ring-0 focus-visible:ring-0 shadow-none md:text-base leading-6 min-h-10 max-h-[200px]"
          rows={1}
        />
        {supportsImageUpload && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={handleImageSelection}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-[#E7D9C1] hover:text-white hover:bg-muted p-2 cursor-pointer rounded-full transition-all duration-200"
              disabled={isLoading || imageItems.length >= uploadConfig.maxFiles}
              onClick={() => fileInputRef.current?.click()}
              title={FRONTEND_ERROR_MESSAGES.imageUpload.uploadButtonTitle(uploadConfig.maxFiles)}
            >
              <ImagePlus className="h-5 w-5" />
            </Button>
          </>
        )}
        <div className="flex shrink-0 items-center">
          {isLoading ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-[#E7D9C1] hover:text-white hover:bg-muted p-2 cursor-pointer rounded-full transition-all duration-200"
              onClick={onCancel}
            >
              <StopCircle className="h-5 w-5" />
            </Button>
          ) : (
            <Button
              type="submit"
              variant="ghost"
              size="icon"
              className={`${
                isSubmitDisabled
                  ? 'text-[#E7D9C1]/35'
                  : 'text-[#E7D9C1] hover:text-white hover:bg-muted'
              } p-2 cursor-pointer rounded-full transition-all duration-200 text-base`}
              disabled={isSubmitDisabled}
            >
              <Send className="h-5 w-5" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-row flex-wrap gap-2">
          {deepResearch && (
            <button
              type="button"
              role="switch"
              aria-checked={deepResearch.enabled}
              aria-describedby={deepResearch.locked ? deepResearchHintId : undefined}
              disabled={deepResearch.locked}
              title={deepResearch.locked ? DEEP_RESEARCH_LABELS.lockedHint : undefined}
              onClick={() => deepResearch.onChange(!deepResearch.enabled)}
              className={`flex items-center gap-2 rounded-xl rounded-t-sm border px-3 py-2 text-sm shadow-sm transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${
                deepResearch.enabled
                  ? 'border-[#9F3434] bg-[#7A1E1E]/40 text-[#F8F1E7]'
                  : 'border-border bg-card/90 text-[#E7D9C1] hover:bg-muted'
              }`}
            >
              <Search className="h-4 w-4" aria-hidden="true" />
              {DEEP_RESEARCH_LABELS.label}
              {deepResearch.locked && (
                <span id={deepResearchHintId} className="sr-only">
                  {DEEP_RESEARCH_LABELS.lockedHint}
                </span>
              )}
            </button>
          )}

          {showEffortSelector && !hasHistory && (
            <div className={controlClass}>
              <div className="flex flex-row items-center text-sm">
                <Brain className="h-4 w-4 mr-2" />
                Effort
              </div>
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger className="w-[120px] bg-transparent border-none cursor-pointer">
                  <SelectValue placeholder="Effort" />
                </SelectTrigger>
                <SelectContent className={selectContentClass}>
                  <SelectItem value="low" className={selectItemClass}>
                    低
                  </SelectItem>
                  <SelectItem value="medium" className={selectItemClass}>
                    中
                  </SelectItem>
                  <SelectItem value="high" className={selectItemClass}>
                    高
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className={controlClass}>
            <div className="flex flex-row items-center text-sm ml-2">
              <Cpu className="h-4 w-4 mr-2" />
              Model
            </div>
            <Select value={model} onValueChange={handleModelChange}>
              <SelectTrigger className="w-[150px] bg-transparent border-none cursor-pointer">
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent className={selectContentClass}>
                {AVAILABLE_MODELS.map((modelInfo) => (
                  <SelectItem
                    key={modelInfo.id}
                    value={modelInfo.id}
                    className={selectItemClass}
                  >
                    <div className="flex items-center">
                      {getModelIcon(modelInfo.icon, modelInfo.iconColor)}
                      {modelInfo.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {hasHistory && (
          <Button
            className="bg-card border border-border text-[#E7D9C1] hover:bg-muted cursor-pointer rounded-xl rounded-t-sm"
            variant="default"
            type="button"
            disabled={newConversationDisabled}
            onClick={onNewConversation}
          >
            <SquarePen size={16} />
            新對話
          </Button>
        )}
      </div>
    </form>
  );
};
