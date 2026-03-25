import { useState, useRef, useEffect, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { MemphisBackground } from "@/components/MemphisDecorations";
import { AgentResultCard, type AgentResult } from "@/components/AgentResultCard";
import { MapView } from "@/components/Map";
import {
  Bot,
  Navigation,
  Search,
  MapPin,
  Loader2,
  AlertCircle,
  Sparkles,
  Filter,
  Cpu,
  Cloud,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const DEFAULT_AGENT_LOCATION = { lat: 35.6595, lng: 139.7005 };

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

  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);

  // Agent search mutation
  const agentSearch = trpc.agent.searchGakuwari.useMutation({
    onSuccess: (data) => {
      setResults(data.results);
      setHasSearched(true);
      const gakuwariCount = data.results.filter((r) => r.has_gakuwari).length;
      if (gakuwariCount > 0) {
        toast.success(`${data.results.length}件中 ${gakuwariCount}件の学割スポットが見つかりました！`);
      } else if (data.results.length > 0) {
        toast.info(`${data.results.length}件の店舗が見つかりましたが、学割情報は確認できませんでした。`);
      } else {
        toast.info("周辺に店舗が見つかりませんでした。範囲を広げてみてください。");
      }
    },
    onError: (error) => {
      toast.error(`検索に失敗しました: ${error.message}`);
    },
  });

  // Get user location
  const getLocation = useCallback(() => {
    if (!navigator.geolocation) {
      toast.error("お使いのブラウザは位置情報に対応していません。");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(loc);
        if (mapRef.current) {
          mapRef.current.setCenter(loc);
          mapRef.current.setZoom(15);
        }
        toast.success("現在地を取得しました！");
      },
      () => {
        setUserLocation(DEFAULT_AGENT_LOCATION);
        toast.error("位置情報の取得に失敗しました。ブラウザの設定を確認してください。");
      },
    );
  }, []);

  // Auto-get location on mount
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        () => {
          setUserLocation(DEFAULT_AGENT_LOCATION);
        },
      );
    }
  }, []);

  // Handle search
  const handleSearch = () => {
    if (!userLocation) {
      toast.error("まず現在地を取得してください。");
      return;
    }
    agentSearch.mutate({
      lat: userLocation.lat,
      lng: userLocation.lng,
      radius,
      keyword: keyword.trim() || undefined,
      llmProvider,
    });
  };

  // Map ready
  const handleMapReady = useCallback((map: google.maps.Map) => {
    mapRef.current = map;
    infoWindowRef.current = new google.maps.InfoWindow();

    // Allow clicking on map to set location
    map.addListener("click", (e: google.maps.MapMouseEvent) => {
      if (e.latLng) {
        const loc = { lat: e.latLng.lat(), lng: e.latLng.lng() };
        setUserLocation(loc);
        toast.info("地図上の位置を検索地点に設定しました。");
      }
    });
  }, []);

  // Update markers when results change
  useEffect(() => {
    if (!mapRef.current) return;

    // Clear old markers
    markersRef.current.forEach((m) => (m.map = null));
    markersRef.current = [];

    const displayResults = filterGakuwariOnly
      ? results.filter((r) => r.has_gakuwari)
      : results;

    if (displayResults.length === 0) return;

    const bounds = new google.maps.LatLngBounds();

    displayResults.forEach((result) => {
      const pinEl = document.createElement("div");
      const isGakuwari = result.has_gakuwari;
      pinEl.style.cssText = `
        width: 36px; height: 36px; border-radius: 50%;
        background: ${isGakuwari ? "#fde047" : "#e5e7eb"};
        border: 2px solid #1a1a1a;
        display: flex; align-items: center; justify-content: center;
        font-size: 16px; cursor: pointer;
        box-shadow: 2px 2px 0px #1a1a1a;
        transition: transform 0.2s;
      `;
      pinEl.textContent = isGakuwari ? "🎓" : "📍";

      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: mapRef.current!,
        position: { lat: result.lat, lng: result.lng },
        title: result.name,
        content: pinEl,
      });

      marker.addListener("click", () => {
        setSelectedPlaceId(result.place_id);
        if (infoWindowRef.current) {
          infoWindowRef.current.setContent(`
            <div style="font-family:'Noto Sans JP',sans-serif;padding:6px;max-width:240px;">
              <strong style="font-size:14px;">${result.name}</strong>
              ${isGakuwari
                ? `<div style="margin:6px 0;padding:4px 8px;background:#fef9c3;border-radius:6px;font-size:12px;">
                    🎓 ${result.discount_info || "学割あり"}
                  </div>`
                : `<p style="font-size:12px;color:#999;margin:4px 0;">学割情報なし</p>`
              }
              ${result.rating ? `<p style="font-size:11px;color:#666;">★ ${result.rating.toFixed(1)}</p>` : ""}
              <p style="font-size:11px;color:#888;margin-top:4px;">${result.address}</p>
            </div>
          `);
          infoWindowRef.current.open({ anchor: marker, map: mapRef.current });
        }
      });

      markersRef.current.push(marker);
      bounds.extend({ lat: result.lat, lng: result.lng });
    });

    // Also include user location in bounds
    if (userLocation) {
      bounds.extend(userLocation);
    }

    mapRef.current.fitBounds(bounds, { top: 50, right: 50, bottom: 50, left: 50 });
  }, [results, filterGakuwariOnly, userLocation]);

  // Add user location marker
  useEffect(() => {
    if (!mapRef.current || !userLocation) return;

    const userPinEl = document.createElement("div");
    userPinEl.style.cssText = `
      width: 16px; height: 16px; border-radius: 50%;
      background: #3b82f6; border: 3px solid white;
      box-shadow: 0 0 8px rgba(59,130,246,0.5);
    `;

    const userMarker = new google.maps.marker.AdvancedMarkerElement({
      map: mapRef.current,
      position: userLocation,
      title: "現在地",
      content: userPinEl,
    });

    return () => {
      userMarker.map = null;
    };
  }, [userLocation]);

  const displayResults = filterGakuwariOnly
    ? results.filter((r) => r.has_gakuwari)
    : results;

  const gakuwariCount = results.filter((r) => r.has_gakuwari).length;

  return (
    <div className="min-h-screen pb-20 md:pb-0">
      {/* Header */}
      <section className="relative overflow-hidden py-6 sm:py-10">
        <MemphisBackground count={15} />
        <div className="container relative z-10">
          <div className="max-w-2xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 bg-memphis-lilac/30 border-2 border-foreground rounded-full px-4 py-1.5 mb-3 shadow-[2px_2px_0px_oklch(0.15_0.01_0)]">
              <Bot size={14} />
              <span className="text-xs font-bold uppercase tracking-wider">AI Agent 検索</span>
            </div>
            <h1
              className="text-3xl sm:text-4xl font-black uppercase tracking-tight leading-[1.1] mb-3"
              style={{ textShadow: "3px 3px 0px oklch(0.82 0.12 290 / 0.5)" }}
            >
              学割スポット発見
            </h1>
            <p className="text-sm sm:text-base text-muted-foreground font-medium mb-4 max-w-md mx-auto">
              AIが周辺の店舗を自動調査し、学割情報をリアルタイムで発見します。
            </p>
          </div>
        </div>
      </section>

      {/* Search Controls */}
      <section className="py-4">
        <div className="container">
          <div className="memphis-card rounded-xl bg-card p-4 sm:p-6">
            {/* Location */}
            <div className="flex items-center gap-3 mb-4">
              <Button
                onClick={getLocation}
                variant="outline"
                className="memphis-btn bg-memphis-mint/30 shrink-0"
              >
                <Navigation size={16} className="mr-1.5" />
                現在地を取得
              </Button>
              {userLocation ? (
                <p className="text-sm text-muted-foreground">
                  <MapPin size={14} className="inline mr-1" />
                  {userLocation.lat.toFixed(4)}, {userLocation.lng.toFixed(4)}
                  <span className="text-xs ml-1">(地図クリックで変更可)</span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">位置情報を取得してください</p>
              )}
            </div>

            {/* Keyword + Radius */}
            <div className="flex flex-col sm:flex-row gap-3 mb-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
                <Input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="キーワード（任意）: カフェ、ラーメン..."
                  className="pl-9 h-11 border-2 border-foreground/20 rounded-lg"
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                />
              </div>
              <Button
                onClick={() => setShowFilters(!showFilters)}
                variant="outline"
                size="sm"
                className="memphis-btn sm:h-11"
              >
                <Filter size={14} className="mr-1" />
                詳細設定
              </Button>
            </div>

            {/* Expandable filters */}
            {showFilters && (
              <div className="bg-muted/50 rounded-lg p-4 mb-4 border-2 border-foreground/10 space-y-4">
                {/* Search radius */}
                <div>
                  <label className="text-sm font-semibold block mb-2">
                    検索範囲: {radius}m
                  </label>
                  <Slider
                    value={[radius]}
                    onValueChange={([v]) => setRadius(v)}
                    min={100}
                    max={5000}
                    step={100}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground mt-1">
                    <span>100m</span>
                    <span>5,000m</span>
                  </div>
                </div>

                {/* LLM provider toggle */}
                <div>
                  <label className="text-sm font-semibold block mb-2">
                    AIモード
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setLlmProvider("gemini")}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border-2 transition-colors",
                        llmProvider === "gemini"
                          ? "bg-memphis-yellow border-foreground shadow-[2px_2px_0px_oklch(0.15_0.01_0)]"
                          : "bg-background border-foreground/20 hover:border-foreground/50"
                      )}
                    >
                      <Cloud size={14} />
                      Gemini（高速・推奨）
                    </button>
                    <button
                      type="button"
                      onClick={() => setLlmProvider("ollama")}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border-2 transition-colors",
                        llmProvider === "ollama"
                          ? "bg-memphis-mint border-foreground shadow-[2px_2px_0px_oklch(0.15_0.01_0)]"
                          : "bg-background border-foreground/20 hover:border-foreground/50"
                      )}
                    >
                      <Cpu size={14} />
                      Ollama（ローカルLLM）
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    {llmProvider === "gemini"
                      ? "Google Gemini APIを使用。高速で安定しています。"
                      : "Ollamaサーバーを使用。OLLAMA_AGENT_URLの設定が必要です。"}
                  </p>
                </div>
              </div>
            )}

            {/* Search button */}
            <Button
              onClick={handleSearch}
              disabled={!userLocation || agentSearch.isPending}
              className="w-full memphis-btn h-12 bg-primary text-primary-foreground text-base font-bold rounded-xl"
            >
              {agentSearch.isPending ? (
                <>
                  <Loader2 size={18} className="mr-2 animate-spin" />
                  AIが調査中...（店舗数により3〜10分かかります）
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

      {/* Map */}
      <section className="py-4">
        <div className="container">
          <div className="rounded-xl overflow-hidden border-2 border-foreground shadow-[4px_4px_0px_oklch(0.15_0.01_0)]">
            <MapView
              className="h-[300px] sm:h-[400px]"
              initialCenter={userLocation ?? { lat: 35.6812, lng: 139.7671 }}
              initialZoom={userLocation ? 15 : 13}
              onMapReady={handleMapReady}
            />
          </div>
        </div>
      </section>

      {/* Loading state */}
      {agentSearch.isPending && (
        <section className="py-6">
          <div className="container">
            <div className="memphis-card rounded-xl bg-card p-8 text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-memphis-lilac/30 border-2 border-foreground mb-4">
                <Bot size={32} className="text-primary animate-pulse" />
              </div>
              <h3 className="text-lg font-bold mb-2">AIが学割情報を調査中...</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Google Mapsから周辺店舗を取得し、各店舗について
                <br />
                Web検索（SearXNG）で学割情報を調査しています。
                <br />
                <span className="text-xs mt-1 block">
                  使用中のAI: {llmProvider === "ollama" ? "Ollama（ローカルLLM）" : "Gemini API"}
                  　／　店舗数により3〜10分ほどかかる場合があります。
                </span>
              </p>
              <div className="flex justify-center gap-2">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-3 h-3 rounded-full bg-primary animate-bounce"
                    style={{ animationDelay: `${i * 0.2}s` }}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Results */}
      {hasSearched && !agentSearch.isPending && (
        <section className="py-6">
          <div className="container">
            {/* Results header */}
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div>
                <h2 className="text-lg font-extrabold uppercase tracking-tight">
                  検索結果
                </h2>
                <p className="text-sm text-muted-foreground">
                  {results.length}件の店舗 / {gakuwariCount}件の学割スポット
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
                  onClick={() => setFilterGakuwariOnly(!filterGakuwariOnly)}
                >
                  🎓 学割ありのみ ({gakuwariCount})
                </Button>
              )}
            </div>

            {/* Results list */}
            {displayResults.length === 0 ? (
              <div className="memphis-card rounded-xl bg-card p-8 text-center">
                <AlertCircle size={48} className="mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground font-medium">
                  {filterGakuwariOnly
                    ? "学割スポットが見つかりませんでした。フィルターを解除してみてください。"
                    : "周辺に店舗が見つかりませんでした。範囲を広げて再検索してみてください。"}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
