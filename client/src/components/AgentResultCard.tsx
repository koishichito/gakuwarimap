import {
  ExternalLink,
  MapPin,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  Tag,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface AgentResult {
  place_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;
  website?: string;
  types?: string[];
  has_gakuwari: boolean;
  discount_info: string;
  source_url: string;
  confidence: "high" | "medium" | "low";
}

interface AgentResultCardProps {
  result: AgentResult;
  onClick?: () => void;
  isSelected?: boolean;
}

export function getAgentResultStatus(
  result: Pick<AgentResult, "has_gakuwari" | "confidence">
) {
  if (result.has_gakuwari) {
    return { label: "学割あり", tone: "positive" as const };
  }

  if (result.confidence === "low") {
    return { label: "未確認", tone: "unknown" as const };
  }

  return { label: "学割なし", tone: "negative" as const };
}

function ConfidenceBadge({
  confidence,
}: {
  confidence: "high" | "medium" | "low";
}) {
  const config = {
    high: {
      icon: ShieldCheck,
      label: "確信度: 高",
      className: "bg-memphis-mint text-foreground border-foreground",
    },
    medium: {
      icon: ShieldQuestion,
      label: "確信度: 中",
      className: "bg-memphis-yellow text-foreground border-foreground",
    },
    low: {
      icon: ShieldAlert,
      label: "確信度: 低",
      className: "bg-memphis-coral/30 text-foreground border-foreground",
    },
  };
  const { icon: Icon, label, className } = config[confidence];

  return (
    <Badge className={cn("border-2 px-2 py-0.5 text-xs gap-1", className)}>
      <Icon size={12} />
      {label}
    </Badge>
  );
}

export function AgentResultCard({
  result,
  onClick,
  isSelected,
}: AgentResultCardProps) {
  const status = getAgentResultStatus(result);

  return (
    <div
      onClick={onClick}
      className={cn(
        "memphis-card overflow-hidden rounded-xl bg-card transition-all cursor-pointer",
        isSelected && "ring-2 ring-primary ring-offset-2"
      )}
    >
      <div className="p-3 sm:p-4">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-1 text-base font-bold leading-tight">
              {result.name}
            </h3>
            <p className="mt-0.5 flex items-center gap-1 line-clamp-1 text-xs text-muted-foreground">
              <MapPin size={12} className="shrink-0" />
              {result.address}
            </p>
          </div>

          {status.tone === "positive" ? (
            <Badge className="memphis-btn shrink-0 border-foreground bg-memphis-yellow px-2 py-0.5 text-xs text-foreground">
              <Tag size={12} className="mr-1" />
              {status.label}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 border-2 px-2 py-0.5 text-xs",
                status.tone === "unknown"
                  ? "border-foreground/40 bg-memphis-lilac/20 text-foreground"
                  : "text-muted-foreground"
              )}
            >
              {status.label}
            </Badge>
          )}
        </div>

        {result.has_gakuwari && result.discount_info && (
          <div className="mb-2 rounded-lg border-2 border-foreground/10 bg-memphis-yellow/20 p-2.5">
            <div className="flex items-start gap-2">
              <Sparkles size={14} className="mt-0.5 shrink-0 text-primary" />
              <p className="text-sm font-medium leading-snug text-foreground/90">
                {result.discount_info}
              </p>
            </div>
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <ConfidenceBadge confidence={result.confidence} />

          <div className="flex items-center gap-2">
            {result.rating && (
              <span className="text-xs text-muted-foreground">
                ★ {result.rating.toFixed(1)}
              </span>
            )}

            {result.source_url && (
              <a
                href={result.source_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="flex items-center gap-0.5 text-xs text-primary hover:underline"
              >
                <ExternalLink size={10} />
                出典
              </a>
            )}

            {result.website && (
              <a
                href={result.website}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="flex items-center gap-0.5 text-xs text-primary hover:underline"
              >
                <ExternalLink size={10} />
                公式
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
