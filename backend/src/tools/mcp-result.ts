export function stringifyMcpResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result ?? "");
  }

  const record = result as {
    content?: unknown;
    structuredContent?: unknown;
    toolResult?: unknown;
    isError?: boolean;
  };

  if (record.structuredContent !== undefined) {
    if (
      record.structuredContent &&
      typeof record.structuredContent === "object" &&
      "content" in record.structuredContent &&
      typeof record.structuredContent.content === "string"
    ) {
      return record.structuredContent.content;
    }

    return JSON.stringify(record.structuredContent, null, 2);
  }

  if (record.toolResult !== undefined) {
    return typeof record.toolResult === "string"
      ? record.toolResult
      : JSON.stringify(record.toolResult, null, 2);
  }

  if (Array.isArray(record.content)) {
    return record.content
      .map((block) => {
        if (!block || typeof block !== "object") {
          return String(block ?? "");
        }

        const contentBlock = block as {
          type?: string;
          text?: string;
          resource?: { text?: string; uri?: string; blob?: string };
          mimeType?: string;
        };

        if (contentBlock.type === "text") {
          return contentBlock.text ?? "";
        }

        if (contentBlock.type === "resource") {
          return (
            contentBlock.resource?.text ??
            contentBlock.resource?.uri ??
            contentBlock.resource?.blob ??
            JSON.stringify(contentBlock)
          );
        }

        return JSON.stringify(contentBlock);
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }

  return JSON.stringify(result, null, 2);
}
