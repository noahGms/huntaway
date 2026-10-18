import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy } from "lucide-react";
import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { HighlighterGeneric } from "shiki";

// One Shiki instance, languages loaded on demand, JS regex engine (no wasm).
let highlighter: Promise<HighlighterGeneric<string, string>> | null = null;
const THEME = "vitesse-dark";

function getHighlighter() {
  highlighter ??= (async () => {
    const [{ createHighlighter }, { createJavaScriptRegexEngine }] = await Promise.all([import("shiki"), import("shiki/engine/javascript")]);
    return createHighlighter({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine() }) as Promise<HighlighterGeneric<string, string>>;
  })();
  return highlighter;
}

const ALIASES: Record<string, string> = { sh: "bash", shell: "bash", zsh: "bash", console: "bash", ts: "typescript", js: "javascript", py: "python", rs: "rust", yml: "yaml" };

export async function highlight(code: string, lang: string | undefined): Promise<string | null> {
  if (!lang) return null;
  const name = ALIASES[lang] ?? lang;
  try {
    const h = await getHighlighter();
    if (!h.getLoadedLanguages().includes(name)) await h.loadLanguage(name as never);
    return h.codeToHtml(code, { lang: name, theme: THEME });
  } catch {
    return null;
  }
}

export function CodeBlock({ code, lang, maxHeight = 420 }: { code: string; lang?: string; maxHeight?: number }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    void highlight(code, lang).then((h) => alive && setHtml(h));
    return () => {
      alive = false;
    };
  }, [code, lang]);
  return (
    <div className="group relative overflow-hidden rounded-[10px] border border-border bg-[#121418]">
      {lang && <div className="border-b border-border px-3 py-1 font-mono text-[10.5px] text-faint">{lang}</div>}
      <button
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        className="absolute right-2 top-1.5 rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-surface-high hover:text-text group-hover:opacity-100"
        aria-label="Copy"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <div className="selectable overflow-auto px-3 py-2.5 font-mono text-[12.5px] leading-[1.55]" style={{ maxHeight }}>
        {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="whitespace-pre text-[#d4cfc6]">{code}</pre>}
      </div>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md selectable text-[13.5px] text-[#e3dfd8]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children }) {
            const match = /language-([\w+-]+)/.exec(className ?? "");
            const content = String(children ?? "");
            if (!match && !content.includes("\n")) return <code>{children}</code>;
            return <CodeBlock code={content.replace(/\n$/, "")} lang={match?.[1]} />;
          },
          pre({ children }) {
            return <>{children}</>;
          },
          a({ href, children }) {
            // The webview doesn't open new windows: links go to the system browser.
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (href && /^(https?|mailto):/i.test(href)) void openUrl(href).catch(() => {});
                }}
                title={href}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
