import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const components: Components = {
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-1.5 ml-4 list-disc space-y-1 marker:text-muted-foreground/60">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 ml-4 list-decimal space-y-1 marker:text-muted-foreground/60">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-[#8fb3ff] underline underline-offset-2 hover:text-[#a9c4ff]"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  h1: ({ children }) => (
    <h1 className="mb-1.5 mt-3 text-[15px] font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2.5 text-sm font-medium first:mt-0">{children}</h3>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border/60" />,
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code className="font-mono text-[12px] leading-relaxed text-foreground/90">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-[#a9c4ff] ring-1 ring-border/60">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-xl border border-border/60 bg-background-subtle p-3">
      {children}
    </pre>
  ),
};

export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 text-[14px] leading-relaxed wrap-anywhere",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
