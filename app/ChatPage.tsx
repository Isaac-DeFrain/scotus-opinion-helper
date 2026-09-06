"use client";

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import Image from "next/image";
import { v4 as uuidv4 } from "uuid";

import { ChatMarkdown } from "./ChatMarkdown";
import { StatsBreakdown } from "./history/StatsBreakdown";
import { ThemeToggle } from "./ThemeToggle";
import styles from "./page.module.css";
import {
  formatSourceDisplayName,
  sourceListKey,
  type Source,
} from "@/src/chat/sources";
import { formatCost, formatDuration, type QueryStats } from "@/src/queryCost";
import { splitStreamContentAndStats } from "@/src/utils";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  stats?: QueryStats;
  variant?: "default" | "error";
};

type ChatPageProps = {
  userId: string;
  onChatComplete?: () => void;
  onStreamingChange?: (isStreaming: boolean) => void;
  onInputValueChange?: (value: string) => void;
  onInputFocusChange?: (focused: boolean) => void;
};

function appendErrorMessage(
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  content: string,
) {
  setMessages((prev) => [
    ...prev,
    {
      id: uuidv4(),
      role: "assistant",
      content,
      variant: "error",
    },
  ]);
}

export function ChatPage({
  userId,
  onChatComplete,
  onStreamingChange,
  onInputValueChange,
  onInputFocusChange,
}: ChatPageProps) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  useEffect(() => {
    onInputValueChange?.(input);
  }, [input, onInputValueChange]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleChatSubmit = async (
    event: React.SubmitEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (!input.trim() || isStreaming) return;

    const userInput = input;
    setInput("");

    const userMessage: ChatMessage = {
      id: uuidv4(),
      role: "user",
      content: userInput,
    };

    setMessages((prev) => [...prev, userMessage]);
    setIsStreaming(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: userInput, userId }),
      });

      if (!response.ok) {
        let errorText =
          response.statusText.trim() || `Request failed (${response.status}).`;
        try {
          const data = (await response.json()) as { error?: unknown };
          if (typeof data.error === "string" && data.error.trim()) {
            errorText = data.error.trim();
          }
        } catch {
          /* response body was not JSON */
        }
        console.error("Error from chat API:", errorText);
        appendErrorMessage(setMessages, errorText);
        onChatComplete?.();
        return;
      }

      const assistantMessageId = uuidv4();

      setMessages((prev) => [
        ...prev,
        { id: assistantMessageId, role: "assistant", content: "" },
      ]);

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      let assistantResponse = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          assistantResponse += decoder.decode(value, { stream: true });
          const { content } = splitStreamContentAndStats(assistantResponse);

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId ? { ...msg, content } : msg,
            ),
          );
        }
      }

      assistantResponse += decoder.decode();
      const { content, stats, sources } =
        splitStreamContentAndStats(assistantResponse);

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? {
                ...msg,
                content,
                stats,
                sources,
              }
            : msg,
        ),
      );
      onChatComplete?.();
    } catch (error) {
      console.error("Error in chat:", error);
      const message =
        error instanceof Error
          ? error.message
          : "Something went wrong. Please try again.";
      appendErrorMessage(setMessages, message);
      onChatComplete?.();
    } finally {
      setIsStreaming(false);
      inputRef.current?.focus();
    }
  };

  return (
    <>
      <div className={styles.pageHeader}>
        <h1 className={styles.title}>
          <Image
            src="/icon.png"
            alt=""
            width={36}
            height={36}
            className={styles.titleIcon}
          />
          U.S. Supreme Court Helper
        </h1>
        <ThemeToggle />
      </div>

      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>
          Ask questions about U.S. Supreme Court opinions, rulings, cases, or
          related legal topics.
        </h2>

        <div className={styles.messages}>
          {messages.length === 0 && (
            <div className={styles.welcome}>
              <p className={styles.welcomeText}>
                Ask questions about uploaded U.S. Supreme Court opinions.
              </p>
            </div>
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              className={[
                styles.message,
                message.role === "user"
                  ? styles.user
                  : message.variant === "error"
                    ? styles.messageError
                    : styles.assistant,
              ].join(" ")}
            >
              <div className={styles.messageHeaderRow}>
                <p className={styles.messageHeader}>
                  {message.role === "user"
                    ? "You"
                    : message.variant === "error"
                      ? "Error"
                      : "SCOTUS Helper"}
                </p>
                {message.role === "assistant" &&
                  message.variant !== "error" &&
                  message.stats && (
                    <>
                      <span
                        className={styles.messageMetaDivider}
                        aria-hidden="true"
                      >
                        ·
                      </span>
                      <div className={styles.messageMeta}>
                        <StatsBreakdown
                          label="Response time by step"
                          summary={formatDuration(message.stats.durationMs)}
                          metric="duration"
                          breakdown={message.stats.breakdown}
                        />
                        <span aria-hidden="true"> · </span>
                        <StatsBreakdown
                          label="Estimated API cost by step"
                          summary={formatCost(message.stats.costUsd)}
                          metric="cost"
                          breakdown={message.stats.breakdown}
                        />
                      </div>
                    </>
                  )}
              </div>
              {message.role === "assistant" && message.variant !== "error" ? (
                <ChatMarkdown
                  content={message.content}
                  className={styles.markdownBody}
                />
              ) : (
                <p className={styles.messageBody}>{message.content}</p>
              )}
              {message.sources && message.sources.length > 0 && (
                <div className={styles.sources}>
                  {message.sources.map((s) => (
                    <a
                      key={sourceListKey(s)}
                      href={s.pdfUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.sourceLink}
                    >
                      {formatSourceDisplayName(s, message.sources!)}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}

          {isStreaming && !messages[messages.length - 1]?.content && (
            <div className={[styles.message, styles.assistant].join(" ")}>
              <div className={styles.messageHeaderRow}>
                <p className={styles.messageHeader}>SCOTUS Helper</p>
              </div>
              <p className={styles.messageBody}>Thinking...</p>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleChatSubmit} className={styles.form}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => onInputFocusChange?.(true)}
            onBlur={() => onInputFocusChange?.(false)}
            placeholder="Ask a question about SCOTUS opinions..."
            className={styles.input}
            disabled={isStreaming}
          />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className={[styles.button, styles.sendButton].join(" ")}
          >
            {isStreaming ? "Thinking..." : "Ask"}
          </button>
        </form>
      </div>
    </>
  );
}
