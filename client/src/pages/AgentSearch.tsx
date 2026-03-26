import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  Cloud,
  Cpu,
  Filter,
  Loader2,
  MapPin,
  Navigation,
  Search,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { AgentResultCard, getAgentResultStatus, type AgentResult } from "@/components/AgentResultCard";
import { MemphisBackground } from "@/components/MemphisDecorations";
import { MapView } from "@/components/Map";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";

const DEFAULT_AGENT_LOCATION = { lat: 35.6595, lng: 139.7005 };
const WAITING_CAT_SPRITE_URL = "/waiting-cat.png";
const WAITING_CAT_FRAME_COUNT = 4;
const WAITING_CAT_FRAME_MS = 2000;
const WAITING_TIP_ROTATE_MS = 3200;
const MIN_WAITING_OVERLAY_MS = 5000;
const WAITING_CAT_FALLBACK_SPRITE_URL = "/cat-sprite.png";
const WAITING_CAT_DISPLAY_SIZE = 320;
const WAITING_CAT_FRAME_SIZE = 1024;
const WAITING_CAT_SPRITE_BASE_WIDTH = 2048;
const WAITING_CAT_SPRITE_BASE_HEIGHT = 2048;
const WAITING_CAT_FRAME_COORDINATES = [
  { x: 0, y: 0 },
  { x: WAITING_CAT_FRAME_SIZE, y: 0 },
  { x: 0, y: WAITING_CAT_FRAME_SIZE },
  { x: WAITING_CAT_FRAME_SIZE, y: WAITING_CAT_FRAME_SIZE },
] as const;
const WAITING_TIPS = [
  "僕はクーぽんにゃん！",
  "学割を便利に使って学生生活を楽しむにゃん！",
  "間違いがあったら、修正フォームで送って欲しいにゃん！",
] as const;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildInfoWindowContent(result: AgentResult) {
  const status = getAgentResultStatus(result);
  const description = result.has_gakuwari
    ? result.discount_info || status.label
    : status.tone === "unknown"
      ? "学割情報は未確認です"
      : "学割は確認できませんでした";
  const backgroundColor =
    status.tone === "positive"
      ? "#fef3c7"
      : status.tone === "unknown"
        ? "#ede9fe"
        : "#f3f4f6";

  return `
    <div style="font-family:'Noto Sans JP',sans-serif;padding:8px;max-width:240px;">
      <strong style="display:block;font-size:14px;margin-bottom:6px;">
        ${escapeHtml(result.name)}
      </strong>
      <div style="margin:6px 0;padding:6px 8px;background:${backgroundColor};border-radius:8px;font-size:12px;">
        ${escapeHtml(description)}
      </div>
      ${
        result.rating
          ? `<p style="font-size:11px;color:#4b5563;margin:4px 0;">評価 ${result.rating.toFixed(1)}</p>`
          : ""
      }
      <p style="font-size:11px;color:#6b7280;margin-top:4px;">
        ${escapeHtml(result.address)}
      </p>
    </div>
  `;
}

export default function AgentSearch() {
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(
    DEFAULT_AGENT_LOCATION
  );
  const [keyword, setKeyword] = useState("");
  const [radius, setRadius] = useState(500);
  const [results, setResults] = useState<AgentResult[]>([]);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [filterGakuwariOnly, setFilterGakuwariOnly] = useState(false);
  const [llmProvider, setLlmProvider] = useState<"gemini" | "ollama">("gemini");
  const [isWaitingOverlayVisible, setIsWaitingOverlayVisible] = useState(false);
  const [waitingFrame, setWaitingFrame] = useState(0);
  const [waitingSpriteUrl, setWaitingSpriteUrl] = useState(WAITING_CAT_SPRITE_URL);
  const [waitingSpriteWidth, setWaitingSpriteWidth] = useState(WAITING_CAT_SPRITE_BASE_WIDTH);
  const [waitingSpriteHeight, setWaitingSpriteHeight] = useState(WAITING_CAT_SPRITE_BASE_HEIGHT);
  const [waitingTip, setWaitingTip] = useState<string>(
    WAITING_TIPS[Math.floor(Math.random() * WAITING_TIPS.length)]
  );
  const waitingOverlayStartedAtRef = useRef<number | null>(null);
  const waitingOverlayTimeoutRef = useRef<number | null>(null);

  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);

  const agentSearch = trpc.agent.searchGakuwari.useMutation({
    onSuccess: (data) => {
      setResults(data.results);
      setSelectedPlaceId(null);
      setHasSearched(true);

      const gakuwariCount = data.results.filter((result) => result.has_gakuwari).length;

      if (gakuwariCount > 0) {
        toast.success(`${data.results.length}件中 ${gakuwariCount}件で学割を確認しました。`);
        return;
      }

      if (data.results.length > 0) {
        toast.info(
          `指定範囲内の${data.results.length}件を深掘りしましたが、学割は確認できませんでした。`
        );
        return;
      }

      toast.info("指定範囲内に候補店舗が見つかりませんでした。");
    },
    onError: (error) => {
      toast.error(`検索に失敗しました: ${error.message}`);
    },
  });

  const getLocation = useCallback(() => {
    if (!navigator.geolocation) {
      toast.error("このブラウザは位置情報に対応していません。");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };

        setUserLocation(location);

        if (mapRef.current) {
          mapRef.current.setCenter(location);
          mapRef.current.setZoom(15);
        }

        toast.success("現在地を取得しました。");
      },
      () => {
        setUserLocation(DEFAULT_AGENT_LOCATION);
        toast.error("位置情報の取得に失敗しました。ブラウザの設定をご確認ください。");
      }
    );
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) {
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      },
      () => {
        setUserLocation(DEFAULT_AGENT_LOCATION);
      }
    );
  }, []);

  const handleSearch = () => {
    if (!userLocation) {
      toast.error("まず現在地を取得してください。");
      return;
    }

    if (waitingOverlayTimeoutRef.current != null) {
      window.clearTimeout(waitingOverlayTimeoutRef.current);
      waitingOverlayTimeoutRef.current = null;
    }

    waitingOverlayStartedAtRef.current = Date.now();
    setIsWaitingOverlayVisible(true);

    agentSearch.mutate({
      lat: userLocation.lat,
      lng: userLocation.lng,
      radius,
      keyword: keyword.trim() || undefined,
      llmProvider,
    });
  };

  const handleMapReady = useCallback((map: google.maps.Map) => {
    mapRef.current = map;
    infoWindowRef.current = new google.maps.InfoWindow();

    map.addListener("click", (event: google.maps.MapMouseEvent) => {
      if (!event.latLng) {
        return;
      }

      const location = {
        lat: event.latLng.lat(),
        lng: event.latLng.lng(),
      };

      setUserLocation(location);
      toast.info("地図上の位置を検索の中心に設定しました。");
    });
  }, []);

  useEffect(() => {
    if (!mapRef.current) {
      return;
    }

    markersRef.current.forEach((marker) => {
      marker.map = null;
    });
    markersRef.current = [];

    const displayResults = filterGakuwariOnly
      ? results.filter((result) => result.has_gakuwari)
      : results;

    if (displayResults.length === 0) {
      return;
    }

    const bounds = new google.maps.LatLngBounds();

    displayResults.forEach((result) => {
      const status = getAgentResultStatus(result);
      const pin = document.createElement("div");
      const backgroundColor =
        status.tone === "positive"
          ? "#fde047"
          : status.tone === "unknown"
            ? "#ddd6fe"
            : "#e5e7eb";

      pin.style.cssText = `
        width: 36px;
        height: 36px;
        border-radius: 999px;
        background: ${backgroundColor};
        border: 2px solid #1a1a1a;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 2px 2px 0px #1a1a1a;
      `;
      pin.textContent =
        status.tone === "positive" ? "学" : status.tone === "unknown" ? "?" : "店";

      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: mapRef.current!,
        position: { lat: result.lat, lng: result.lng },
        title: result.name,
        content: pin,
      });

      marker.addListener("click", () => {
        setSelectedPlaceId(result.place_id);

        if (infoWindowRef.current && mapRef.current) {
          infoWindowRef.current.setContent(buildInfoWindowContent(result));
          infoWindowRef.current.open({
            anchor: marker,
            map: mapRef.current,
          });
        }
      });

      markersRef.current.push(marker);
      bounds.extend({ lat: result.lat, lng: result.lng });
    });

    if (userLocation) {
      bounds.extend(userLocation);
    }

    mapRef.current.fitBounds(bounds, {
      top: 50,
      right: 50,
      bottom: 50,
      left: 50,
    });
  }, [filterGakuwariOnly, results, userLocation]);

  useEffect(() => {
    if (!mapRef.current || !userLocation) {
      return;
    }

    const pin = document.createElement("div");
    pin.style.cssText = `
      width: 16px;
      height: 16px;
      border-radius: 999px;
      background: #3b82f6;
      border: 3px solid #ffffff;
      box-shadow: 0 0 8px rgba(59, 130, 246, 0.5);
    `;

    const marker = new google.maps.marker.AdvancedMarkerElement({
      map: mapRef.current,
      position: userLocation,
      title: "現在地",
      content: pin,
    });

    return () => {
      marker.map = null;
    };
  }, [userLocation]);

  useEffect(() => {
    let cancelled = false;
    const image = new Image();

    image.onload = () => {
      if (cancelled) {
        return;
      }

      setWaitingSpriteUrl(WAITING_CAT_SPRITE_URL);
      setWaitingSpriteWidth(image.naturalWidth || WAITING_CAT_SPRITE_BASE_WIDTH);
      setWaitingSpriteHeight(image.naturalHeight || WAITING_CAT_SPRITE_BASE_HEIGHT);
    };

    image.onerror = () => {
      if (cancelled) {
        return;
      }

      setWaitingSpriteUrl(WAITING_CAT_FALLBACK_SPRITE_URL);
      setWaitingSpriteWidth(WAITING_CAT_SPRITE_BASE_WIDTH);
      setWaitingSpriteHeight(WAITING_CAT_SPRITE_BASE_HEIGHT);
    };

    image.src = WAITING_CAT_SPRITE_URL;

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isWaitingOverlayVisible) {
      return;
    }

    setWaitingFrame(0);
    setWaitingTip(WAITING_TIPS[Math.floor(Math.random() * WAITING_TIPS.length)]);

    const frameIntervalId = window.setInterval(() => {
      setWaitingFrame((prev) => (prev + 1) % WAITING_CAT_FRAME_COUNT);
    }, WAITING_CAT_FRAME_MS);

    const tipIntervalId = window.setInterval(() => {
      setWaitingTip((prevTip) => {
        if (WAITING_TIPS.length <= 1) {
          return prevTip;
        }

        const candidates = WAITING_TIPS.filter((tip) => tip !== prevTip);
        return candidates[Math.floor(Math.random() * candidates.length)] ?? prevTip;
      });
    }, WAITING_TIP_ROTATE_MS);

    return () => {
      window.clearInterval(frameIntervalId);
      window.clearInterval(tipIntervalId);
    };
  }, [isWaitingOverlayVisible]);

  useEffect(() => {
    if (!isWaitingOverlayVisible || agentSearch.isPending) {
      return;
    }

    const startedAt = waitingOverlayStartedAtRef.current ?? Date.now();
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, MIN_WAITING_OVERLAY_MS - elapsed);

    waitingOverlayTimeoutRef.current = window.setTimeout(() => {
      setIsWaitingOverlayVisible(false);
      waitingOverlayTimeoutRef.current = null;
      waitingOverlayStartedAtRef.current = null;
    }, remaining);

    return () => {
      if (waitingOverlayTimeoutRef.current != null) {
        window.clearTimeout(waitingOverlayTimeoutRef.current);
        waitingOverlayTimeoutRef.current = null;
      }
    };
  }, [agentSearch.isPending, isWaitingOverlayVisible]);

  useEffect(() => {
    return () => {
      if (waitingOverlayTimeoutRef.current != null) {
        window.clearTimeout(waitingOverlayTimeoutRef.current);
      }
    };
  }, []);

  const displayResults = filterGakuwariOnly
    ? results.filter((result) => result.has_gakuwari)
    : results;
  const gakuwariCount = results.filter((result) => result.has_gakuwari).length;
  const waitingFrameCoordinate =
    WAITING_CAT_FRAME_COORDINATES[waitingFrame] ?? WAITING_CAT_FRAME_COORDINATES[0];
  const waitingFrameXPercent =
    waitingSpriteWidth > WAITING_CAT_FRAME_SIZE
      ? (waitingFrameCoordinate.x / (waitingSpriteWidth - WAITING_CAT_FRAME_SIZE)) * 100
      : 0;
  const waitingFrameYPercent =
    waitingSpriteHeight > WAITING_CAT_FRAME_SIZE
      ? (waitingFrameCoordinate.y / (waitingSpriteHeight - WAITING_CAT_FRAME_SIZE)) * 100
      : 0;
  const waitingBackgroundWidthPercent =
    (waitingSpriteWidth / WAITING_CAT_FRAME_SIZE) * 100;
  const waitingBackgroundHeightPercent =
    (waitingSpriteHeight / WAITING_CAT_FRAME_SIZE) * 100;

  return (
    <div className="min-h-screen pb-20 md:pb-0">
      <section className="relative overflow-hidden py-6 sm:py-10">
        <MemphisBackground count={15} />
        <div className="container relative z-10">
          <div className="mx-auto max-w-2xl text-center">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border-2 border-foreground bg-memphis-lilac/30 px-4 py-1.5 shadow-[2px_2px_0px_oklch(0.15_0.01_0)]">
              <Bot size={14} />
              <span className="text-xs font-bold uppercase tracking-wider">
                AI Agent Search
              </span>
            </div>
            <h1
              className="mb-3 text-3xl font-black uppercase tracking-tight leading-[1.1] sm:text-4xl"
              style={{ textShadow: "3px 3px 0px oklch(0.82 0.12 290 / 0.5)" }}
            >
              学割スポット探索
            </h1>
            <p className="mx-auto mb-4 max-w-md text-sm font-medium text-muted-foreground sm:text-base">
              指定半径の中だけを広く集めて深く調べる、高精度な学割検索モードです。
            </p>
          </div>
        </div>
      </section>

      <section className="py-4">
        <div className="container">
          <div className="memphis-card rounded-xl bg-card p-4 sm:p-6">
            <div className="mb-4 flex items-center gap-3">
              <Button
                onClick={getLocation}
                variant="outline"
                className="memphis-btn shrink-0 bg-memphis-mint/30"
              >
                <Navigation size={16} className="mr-1.5" />
                現在地を取得
              </Button>

              {userLocation ? (
                <p className="text-sm text-muted-foreground">
                  <MapPin size={14} className="mr-1 inline" />
                  {userLocation.lat.toFixed(4)}, {userLocation.lng.toFixed(4)}
                  <span className="ml-1 text-xs">(地図クリックでも変更できます)</span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">位置情報を取得してください</p>
              )}
            </div>

            <div className="mb-4 flex flex-col gap-3 sm:flex-row">
              <div className="relative flex-1">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                  size={16}
                />
                <Input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="キーワード任意: カラオケ、美術館、ラーメン..."
                  className="h-11 rounded-lg border-2 border-foreground/20 pl-9"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleSearch();
                    }
                  }}
                />
              </div>

              <Button
                onClick={() => setShowFilters((current) => !current)}
                variant="outline"
                size="sm"
                className="memphis-btn sm:h-11"
              >
                <Filter size={14} className="mr-1" />
                詳細設定
              </Button>
            </div>

            {showFilters && (
              <div className="mb-4 space-y-4 rounded-lg border-2 border-foreground/10 bg-muted/50 p-4">
                <div>
                  <label className="mb-2 block text-sm font-semibold">
                    検索半径: {radius}m
                  </label>
                  <Slider
                    value={[radius]}
                    onValueChange={([value]) => setRadius(value)}
                    min={100}
                    max={5000}
                    step={100}
                    className="w-full"
                  />
                  <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                    <span>100m</span>
                    <span>5,000m</span>
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold">AIモード</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setLlmProvider("gemini")}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg border-2 px-3 py-2 text-sm font-medium transition-colors",
                        llmProvider === "gemini"
                          ? "border-foreground bg-memphis-yellow shadow-[2px_2px_0px_oklch(0.15_0.01_0)]"
                          : "border-foreground/20 bg-background hover:border-foreground/50"
                      )}
                    >
                      <Cloud size={14} />
                      Gemini（高速・推奨）
                    </button>
                    <button
                      type="button"
                      onClick={() => setLlmProvider("ollama")}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg border-2 px-3 py-2 text-sm font-medium transition-colors",
                        llmProvider === "ollama"
                          ? "border-foreground bg-memphis-mint shadow-[2px_2px_0px_oklch(0.15_0.01_0)]"
                          : "border-foreground/20 bg-background hover:border-foreground/50"
                      )}
                    >
                      <Cpu size={14} />
                      Ollama（ローカルLLM）
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {llmProvider === "gemini"
                      ? "Google Gemini APIを使用。高速で安定しています。"
                      : "Ollamaサーバーを使用。OLLAMA_AGENT_URL の設定が必要です。"}
                  </p>
                </div>

                <p className="text-xs text-muted-foreground">
                  半径は自動で広げず、指定範囲内だけを深掘りして調査します。
                </p>
              </div>
            )}

            <Button
              onClick={handleSearch}
              disabled={!userLocation || agentSearch.isPending || isWaitingOverlayVisible}
              className="memphis-btn h-12 w-full rounded-xl bg-primary text-base font-bold text-primary-foreground"
            >
              {agentSearch.isPending || isWaitingOverlayVisible ? (
                <>
                  <Loader2 size={18} className="mr-2 animate-spin" />
                  AI が調査中...
                </>
              ) : (
                <>
                  <Sparkles size={18} className="mr-2" />
                  AI Agent で学割を検索
                </>
              )}
            </Button>
          </div>
        </div>
      </section>

      <section className="py-4">
        <div className="container">
          <div className="overflow-hidden rounded-xl border-2 border-foreground shadow-[4px_4px_0px_oklch(0.15_0.01_0)]">
            <MapView
              className="h-[300px] sm:h-[400px]"
              initialCenter={userLocation ?? DEFAULT_AGENT_LOCATION}
              initialZoom={userLocation ? 15 : 13}
              onMapReady={handleMapReady}
            />
          </div>
        </div>
      </section>

      {isWaitingOverlayVisible && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/75 px-4 backdrop-blur-sm">
          <div className="memphis-card w-full max-w-2xl rounded-2xl border-2 border-foreground bg-card/95 p-5 text-center shadow-[6px_6px_0px_oklch(0.15_0.01_0)] sm:p-7">
            <h3 className="mb-4 text-2xl font-black tracking-tight">検索中...</h3>
            <div className="mb-4 flex justify-center">
              <div
                className="overflow-hidden rounded-3xl border-2 border-foreground bg-memphis-lilac/20 shadow-[4px_4px_0px_oklch(0.15_0.01_0)]"
                style={{
                  width: `min(${WAITING_CAT_DISPLAY_SIZE}px, 72vw)`,
                  height: `min(${WAITING_CAT_DISPLAY_SIZE}px, 72vw)`,
                  backgroundImage: `url(${waitingSpriteUrl})`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: `${waitingFrameXPercent}% ${waitingFrameYPercent}%`,
                  backgroundSize: `${waitingBackgroundWidthPercent}% ${waitingBackgroundHeightPercent}%`,
                }}
                role="img"
                aria-label="検索中の待機猫アニメーション"
              />
            </div>
            <p className="mb-4 text-sm font-medium text-muted-foreground sm:text-base">
              AI が学割情報を深掘り調査中です。しばらくお待ちください。
            </p>
            <p className="mx-auto mb-2 max-w-lg rounded-xl border-2 border-foreground/20 bg-memphis-yellow/30 px-4 py-3 text-sm font-semibold leading-relaxed text-foreground">
              <span className="mr-2 inline-block rounded-md border border-foreground/30 bg-background/60 px-2 py-0.5 text-xs font-black tracking-wide">
                TIP
              </span>
              {waitingTip}
            </p>
          </div>
        </div>
      )}

      {hasSearched && !agentSearch.isPending && (
        <section className="py-6">
          <div className="container">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-extrabold uppercase tracking-tight">検索結果</h2>
                <p className="text-sm text-muted-foreground">
                  {results.length}件を調査 / {gakuwariCount}件で学割を確認
                </p>
              </div>

              {gakuwariCount > 0 && (
                <Button
                  variant={filterGakuwariOnly ? "default" : "outline"}
                  size="sm"
                  className={cn(
                    "memphis-btn text-xs",
                    filterGakuwariOnly && "bg-memphis-yellow text-foreground"
                  )}
                  onClick={() => setFilterGakuwariOnly((current) => !current)}
                >
                  学割ありのみ ({gakuwariCount})
                </Button>
              )}
            </div>

            {displayResults.length === 0 ? (
              <div className="memphis-card rounded-xl bg-card p-8 text-center">
                <AlertCircle size={48} className="mx-auto mb-3 text-muted-foreground/30" />
                <p className="font-medium text-muted-foreground">
                  {filterGakuwariOnly
                    ? "学割ありの店舗は見つかりませんでした。フィルターを外してご確認ください。"
                    : "指定範囲内では学割を確認できませんでした。"}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {displayResults.map((result) => (
                  <AgentResultCard
                    key={result.place_id}
                    result={result}
                    isSelected={selectedPlaceId === result.place_id}
                    onClick={() => {
                      setSelectedPlaceId(result.place_id);

                      if (mapRef.current) {
                        mapRef.current.panTo({ lat: result.lat, lng: result.lng });
                        mapRef.current.setZoom(17);
                      }
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
