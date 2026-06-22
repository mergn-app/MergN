import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export type RightTab = "chat" | "files" | "versions" | "node";

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 rounded-xl px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-background-subtle text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function RightPanel({
  active,
  onTab,
  chat,
  files,
  versions,
  node,
}: {
  active: RightTab;
  onTab: (tab: RightTab) => void;
  chat: ReactNode;
  files: ReactNode;
  versions: ReactNode;
  node: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex w-[400px] shrink-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-muted/40">
      <div className="flex shrink-0 gap-1 p-1">
        <TabButton active={active === "chat"} onClick={() => onTab("chat")}>
          {t("panel.chat")}
        </TabButton>
        <TabButton active={active === "files"} onClick={() => onTab("files")}>
          {t("panel.files")}
        </TabButton>
        <TabButton active={active === "versions"} onClick={() => onTab("versions")}>
          {t("panel.versions")}
        </TabButton>
        <TabButton active={active === "node"} onClick={() => onTab("node")}>
          {t("panel.node")}
        </TabButton>
      </div>
      <div className={cn("min-h-0 flex-1", active === "chat" ? "flex" : "hidden")}>
        {chat}
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-hidden",
          active === "files" ? "flex" : "hidden",
        )}
      >
        {files}
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-hidden",
          active === "versions" ? "flex" : "hidden",
        )}
      >
        {versions}
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-hidden",
          active === "node" ? "block" : "hidden",
        )}
      >
        {node}
      </div>
    </div>
  );
}
